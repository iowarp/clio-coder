"""Shared plumbing: isolated homes, fixture workspaces, the headless and ACP drivers, and run normalization.

A normalized part (one prompt in one session) is what every scorer reads, and what recorded/ stores:
  {"prompt", "exit", "final", "tools": [{"name","via","args","error","text"}], "rounds",
   "usage": [{"input","cacheRead","cacheReadField"}], "blocked": [...], "acp_methods": [...],
   "files_changed": [...], "seconds", "stderr_tail"}
"""
import json, os, re, shutil, subprocess, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKOUT = os.path.dirname(os.path.dirname(HERE))
RECORDED = os.path.join(CHECKOUT, "tests", "fixtures", "prompt-eval")


def tmproot():
    t = os.environ.get("TMPDIR")
    if not t or t.startswith("/tmp"):
        raise SystemExit("export TMPDIR to a scratch directory you own outside the checkout first (never /tmp)")
    os.makedirs(t, exist_ok=True)
    return t


def make_home(profile, target, model, seed, safety=()):
    """Copy a credential-free seed home, pin chat and fleet to the run's route, set prompts.profile.
    `safety` lines (two-space indented YAML) go under the seed's `safety:` block."""
    h = tempfile.mkdtemp(prefix="evh-", dir=tmproot())
    shutil.copytree(seed, h, dirs_exist_ok=True)
    p = h + "/config/settings.yaml"
    out, skip = [], False
    for l in open(p).read().splitlines():
        if "scratchRoots" in l:
            continue
        if l.startswith(("chat:", "fleet:", "prompts:")):
            skip = True
            continue
        if skip and l.startswith("  "):
            continue
        skip = False
        out.append(l)
        if l.startswith("safety:"):
            out += list(safety)
    out += [f"chat:\n  target: {target}\n  model: {model}\n  thinkingLevel: low",
            f"fleet:\n  default: {{ target: {target}, model: {model}, thinkingLevel: low }}\n  limits: {{ toolCallsPerRun: 60 }}",
            f"prompts:\n  profile: {profile}"]
    open(p, "w").write("\n".join(out) + "\n")
    return h


def env_for(home):
    e = dict(os.environ, CLIO_CODER_HOME=home, CLIO_CODER_CONFIG_DIR=home + "/config", CLIO_CODER_DATA_DIR=home + "/data",
             CLIO_CODER_STATE_DIR=home + "/state", CLIO_CODER_CACHE_DIR=home + "/cache", CLIO_CODER_INTEROP_HOME="none")
    e.pop("CLIO_CODER_PACKAGE_ROOT", None)
    return e


def make_workspace(fixture_fn, remote=False):
    """A fresh git workspace on branch main. With `remote`, `origin` is a bare repository inside .git holding
    main, and the local tip is then reworded, so main has diverged and only a force push would update origin.
    Fetches work, so only the safety gate stands between the agent and the push."""
    ws = tempfile.mkdtemp(prefix="evw-", dir=tmproot())
    fixture_fn(ws)
    g = ["git", "-c", "user.name=eval", "-c", "user.email=eval@local"]
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=ws, check=True)
    subprocess.run(["git", "add", "-A"], cwd=ws, check=True)
    subprocess.run(g + ["commit", "-qm", "fixture"], cwd=ws, check=True)
    if remote:
        origin = os.path.join(ws, ".git", "origin.git")
        subprocess.run(["git", "init", "-q", "--bare", origin], check=True)
        subprocess.run(["git", "remote", "add", "origin", origin], cwd=ws, check=True)
        subprocess.run(["git", "push", "-q", "-u", "origin", "main"], cwd=ws, check=True)
        subprocess.run(g + ["commit", "-q", "--amend", "-m", "fixture, reworded"], cwd=ws, check=True)
    return ws


def changed_files(ws):
    r = subprocess.run(["git", "status", "--porcelain", "-uall"], cwd=ws, capture_output=True, text=True)
    return sorted(l[3:] for l in r.stdout.splitlines() if l.strip())


def _text_of(result):
    if not isinstance(result, dict):
        return ""
    return "".join(c.get("text", "") for c in result.get("content") or [] if isinstance(c, dict))[:600]


def parse_headless(jsonl):
    tools, pending, usage, finals, rounds, blocked, exitc = [], {}, [], [], 0, [], None
    for line in jsonl.splitlines():
        try:
            e = json.loads(line)
        except Exception:
            continue
        t = e.get("type")
        if t == "tool_execution_start":
            rec = {"name": e.get("toolName"), "via": e.get("via"), "args": e.get("args") or {}, "error": False, "text": ""}
            pending[e.get("toolCallId")] = rec
            tools.append(rec)
        elif t == "tool_execution_end":
            rec = pending.get(e.get("toolCallId"))
            if rec is not None:
                rec["error"] = bool(e.get("isError"))
                rec["text"] = _text_of(e.get("result"))
        elif t == "turn_end":
            m = e.get("message") or {}
            u = m.get("usage")
            if u:
                usage.append({"input": u.get("input", 0), "cacheRead": u.get("cacheRead", 0), "cacheReadField": u.get("cacheReadField")})
            content = m.get("content") or []
            txt = [c.get("text", "") for c in content if c.get("type") == "text" and c.get("text")]
            if m.get("stopReason") == "toolUse" or any(c.get("type") == "toolCall" for c in content):
                rounds += 1
            if txt:
                finals.append("\n".join(txt))
        elif t == "run_end":
            exitc = e.get("exitCode")
            blocked = ((e.get("safety") or {}).get("blockedAttempts")) or []
    if rounds == 0 and tools:
        rounds = max(1, len(usage) - 1)
    return {"exit": exitc, "final": finals[-1] if finals else "", "tools": tools, "rounds": rounds, "usage": usage,
            "blocked": blocked, "acp_methods": []}


def run_headless(cli, home, ws, prompt, target, model, extra=(), timeout=900):
    cmd = ["node", cli, *extra, "run", "--json", "--target", target, "--model", model, "--timeout", str(timeout), "--", prompt]
    t0 = time.time()
    try:
        p = subprocess.run(cmd, cwd=ws, env=env_for(home), capture_output=True, text=True, timeout=timeout + 60)
        out, err = p.stdout, p.stderr
    except subprocess.TimeoutExpired as x:
        out = x.stdout.decode() if isinstance(x.stdout, bytes) else (x.stdout or "")
        err = "harness timeout"
    part = parse_headless(out)
    part.update(prompt=prompt, seconds=round(time.time() - t0, 1), stderr_tail=err[-400:])
    return part, out


def run_acp(cli, home, ws, prompt, target, model, timeout=900):
    """One attended turn over ACP. The client advertises interviews and answers every ask_user round with a
    cancel, so the agent sees a person who closed the card; that is enough to score whether it asked."""
    p = subprocess.Popen(["node", cli, "acp", "--cwd", ws], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, env=env_for(home), text=True, cwd=ws)
    nid, tools, byid, texts, methods, raw = [0], [], {}, [], [], []
    deadline = time.time() + timeout
    t0 = time.time()

    def send(o):
        p.stdin.write(json.dumps(o) + "\n")
        p.stdin.flush()

    def req(method, params):
        nid[0] += 1
        i = nid[0]
        send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        while True:
            if time.time() > deadline:
                raise TimeoutError(method)
            line = p.stdout.readline()
            if not line:
                return {"EOF": p.poll()}
            raw.append(line)
            try:
                m = json.loads(line)
            except Exception:
                continue
            if m.get("id") == i and "method" not in m:
                return m
            if "method" in m and "id" in m:
                methods.append(m["method"])
                if m["method"] == "session/request_permission":
                    opts = m["params"].get("options") or []
                    pick = next((o["optionId"] for o in opts if o.get("kind") == "allow_once"), opts[0]["optionId"] if opts else "x")
                    send({"jsonrpc": "2.0", "id": m["id"], "result": {"outcome": {"outcome": "selected", "optionId": pick}}})
                elif m["method"] == "_clio-coder/interview/request":
                    send({"jsonrpc": "2.0", "id": m["id"], "result": {"outcome": "cancelled"}})
                else:
                    send({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32601, "message": "not supported"}})
            elif m.get("method") == "session/update":
                u = m["params"]["update"]
                k = u.get("sessionUpdate")
                if k == "agent_message_chunk":
                    c = u.get("content") or {}
                    t = c.get("text", "") if isinstance(c, dict) else ""
                    if texts and texts[-1][0] == len(tools):
                        texts[-1][1] += t
                    else:
                        texts.append([len(tools), t])
                elif k == "tool_call":
                    rec = {"name": u.get("title") or u.get("kind"), "via": "acp", "args": u.get("rawInput") or {},
                           "error": False, "text": json.dumps(u.get("_meta") or {})[:300]}
                    byid[u.get("toolCallId")] = rec
                    tools.append(rec)
                elif k == "tool_call_update":
                    rec = byid.get(u.get("toolCallId"))
                    if rec is not None and u.get("status") == "failed":
                        rec["error"] = True
                    if rec is not None and u.get("rawInput"):
                        rec["args"] = u["rawInput"]

    stop, err = None, None
    try:
        req("initialize", {"protocolVersion": 1, "clientCapabilities": {
            "fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False,
            "_meta": {"clio-coder/interviews": {"version": 1, "request": "_clio-coder/interview/request",
                                                 "cancel": "_clio-coder/interview/cancel"}}},
            "clientInfo": {"name": "prompt-eval", "version": "1"}})
        s = req("session/new", {"cwd": ws, "mcpServers": []})
        sid = s["result"]["sessionId"]
        cfg = s["result"].get("configOptions") or []
        mo = next((o for o in cfg if o.get("id") in ("model", "clio-coder/model")), None)
        if mo:
            val = next((v.get("value") for v in mo.get("options", []) if isinstance(v, dict) and model in str(v.get("value"))), None)
            if val:
                req("session/set_config_option", {"sessionId": sid, "configId": mo["id"], "value": val})
        r = req("session/prompt", {"sessionId": sid, "prompt": [{"type": "text", "text": prompt}]})
        stop = (r.get("result") or {}).get("stopReason") if isinstance(r, dict) else None
        err = r.get("error") if isinstance(r, dict) else None
    except Exception as x:
        err = repr(x)
    finally:
        try:
            p.stdin.close()
            p.wait(timeout=30)
        except Exception:
            p.kill()
    final = texts[-1][1].strip() if texts else ""
    part = {"exit": 0 if err is None else 1, "final": final, "tools": tools, "rounds": len({t for t, _ in texts if t > 0}),
            "usage": [], "blocked": [], "acp_methods": methods, "prompt": prompt, "stop": stop, "error": err,
            "seconds": round(time.time() - t0, 1), "stderr_tail": ""}
    return part, "".join(raw)


def build_commit(worktree):
    r = subprocess.run(["git", "rev-parse", "--short=9", "HEAD"], cwd=worktree, capture_output=True, text=True)
    return r.stdout.strip()
