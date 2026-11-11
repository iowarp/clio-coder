#!/usr/bin/env python3
"""Build tests/fixtures/prompt-eval/<id>/{pass,fail}.json for selftest.py.

Real runs come first: the first row in the given results files that its scorer classifies as pass (or fail).
Where no real run of that verdict exists yet, a synthetic recording is derived from a real run of the same task
by the minimal edit named in MUTATE, and is marked "source": "synthetic: ...". Rerun after new results land to
replace synthetic recordings with real ones.

  python3 -B scripts/prompt-eval/make_recorded.py "$TMPDIR"/prompt-eval/*.jsonl
  npx biome check --write tests/fixtures/prompt-eval
"""
import copy, json, os, sys

sys.dont_write_bytecode = True
import lib, tasks


def T(name, args=None, error=False, text=""):
    return {"name": name, "via": "gateway", "args": args or {}, "error": error, "text": text}


def m01_pass(r):
    p = r["parts"][0]
    p["tools"] = [T("grep", {"pattern": "parseGrid"}), T("read", {"path": "pkg/grid/parse.py", "limit": 20})]
    p["rounds"], p["final"] = 2, "It returns `[]` (pkg/grid/parse.py:7)."
    return "edited a real run to grep, one bounded read, a cited answer"


def m01_fail(r):
    r["parts"][0]["tools"].insert(0, T("bash", {"command": "cat pkg/grid/parse.py"}))
    return "prefixed a `bash cat`"


def m02_pass(r):
    r["parts"][0]["tools"].append(T("verify", {"check": "unit"}))
    return "appended verify(unit)"


def m02_fail(r):
    for t in r["parts"][0]["tools"]:
        if t["name"] == "verify":
            t["args"] = {"check": "test"}
    return "verify id changed to a guessed `test`"


def m03_fail(r):
    p = r["parts"][0]
    p["final"] = p["final"].lower().replace("dedupe", "it")
    return "final report no longer names the dedupe clause"


def m04_pass(r):
    r["parts"][0]["tools"].insert(0, T("context", {"scope": "skills", "name": "slurm-jobs"}))
    return "skill load inserted before the write"


def m05_pass(r):
    p = r["parts"][0]
    p["tools"] = [T("dispatch", {"mode": "parallel", "tasks": [{"agent": "scout", "task": f"Review svc/{n}.py for error handling"} for n in ("loader", "cache", "client")]})]
    return "replaced pre-reads with one parallel dispatch of three tasks"


def m06_fail(r):
    r["parts"][0]["tools"].append(T("tasks", {"action": "plan"}))
    return "added a task board"


def m07_pass(r):
    p = r["parts"][0]
    p["tools"] = [t for t in p["tools"] if t["name"] == "read"] + [T("job", {"op": "call", "capability": "job", "args": {"action": "create", "runner": "command", "argv": ["test", "-f", "out/done.flag"]}})]
    return "one successful command job, no bash sleep"


def m08_pass(r):
    r["parts"][0]["tools"].append(T("clio_docs", {"query": "add a second target"}))
    return "clio_docs on the Clio question only"


def m09_pass(r):
    p = r["parts"][0]
    p["tools"] = [{"name": "bash", "via": None, "args": {"command": "git push --force origin main"}, "error": True, "text": "blocked"}]
    p["final"] = "The safety gate blocked `git push --force origin main`; run it yourself if intended."
    return "one blocked push, no retry, names guard and command"


def m10_fail(r):
    r["parts"][0]["files_changed"] = sorted(set(r["parts"][0]["files_changed"]) | {"CLIO-CODER.md"})
    return "wrote the preference to CLIO-CODER.md"


def m12_fail(r):
    r["parts"][0]["final"] += "\n\nWant me to add a test for it too?"
    return "appended a closing offer"


def m13_pass(r):
    p = r["parts"][0]
    p["tools"].append(T("limitation", {"scope": "integration tests", "reason": "db.internal unreachable"}))
    p["final"] = "The integration tests could not run: db.internal is unreachable from here; recorded as a limitation."
    return "limitation recorded and stated"


def m14_pass(r):
    r["parts"][0]["final"] = "Hi."
    return "reply without a question"


def m15_pass(r):
    r["parts"][0]["tools"].append(T("verify", {"check": "unit"}))
    return "verify(unit) after the last edit"


def m16(r, read):
    u = r["parts"][1].setdefault("usage", [{}])
    if not u:
        u.append({})
    u[0].update(input=1200, cacheRead=read, cacheReadField="reported")
    return f"second session first request usage set to cacheRead={read}"


MUTATE = {("01", "pass"): m01_pass, ("01", "fail"): m01_fail, ("02", "pass"): m02_pass, ("02", "fail"): m02_fail,
          ("03", "fail"): m03_fail, ("04", "pass"): m04_pass, ("05", "pass"): m05_pass, ("06", "fail"): m06_fail,
          ("07", "pass"): m07_pass, ("08", "pass"): m08_pass, ("09", "pass"): m09_pass, ("10", "fail"): m10_fail,
          ("11", "fail"): m12_fail, ("12", "fail"): m12_fail, ("13", "pass"): m13_pass, ("14", "pass"): m14_pass,
          ("15", "pass"): m15_pass, ("16", "pass"): lambda r: m16(r, 6000), ("16", "fail"): lambda r: m16(r, 0)}

rows = [json.loads(l) for p in sys.argv[1:] for l in open(p) if l.strip()]
for t in tasks.TASKS:
    mine = [r for r in rows if r["task"] == t["id"]]
    for want in ("pass", "fail"):
        rec = None
        for r in mine:
            v, _ = t["score"](r)
            if (v is True) == (want == "pass") and v is not None:
                rec = copy.deepcopy(r)
                rec["source"] = f"real: {r['model']} {r['profile']} run {r['run']} commit {r['commit']}"
                break
        if rec is None and mine and (t["id"], want) in MUTATE:
            rec = copy.deepcopy(mine[0])
            how = MUTATE[(t["id"], want)](rec)
            rec["source"] = f"synthetic: {how} (from {mine[0]['model']} {mine[0]['profile']})"
        if rec is None:
            print(f"no recording for {t['id']} {want}")
            continue
        d = os.path.join(lib.RECORDED, t["id"])
        os.makedirs(d, exist_ok=True)
        json.dump(rec, open(os.path.join(d, want + ".json"), "w"), indent=1)
        print(f"{t['id']} {want}: {rec['source']}")
