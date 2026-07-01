#!/usr/bin/env python3
"""Deterministic pre-release battletest for Clio Coder.

This is NOT a fourth bespoke harness. It is a `clio eval` task-file generator
(the same pattern as scicode_clio.py) that turns a real repo into a
SWE-bench-discipline oracle and lets clio's own `clio eval run` do the scoring.

Per target (see targets.json) the oracle is:
  setup[0]  freeze  : git reset --hard <SHA>; git clean (keep deps); INJECT one
                      deterministic single-line regression into a NON-TEST file.
  setup[1]  solve   : `clio run --json` with the deterministic sampler, pinned
                      target/model from fleet.json (profile local-split). clio's
                      own exit is swallowed so the verifier — not clio's
                      self-report — decides pass/fail.
  verifier[0] ban   : hard-fail if `git diff` touched any test file.
  verifier[1] gate  : the repo's OWN offline test gate. exit 0 == regression
                      repaired without breaking anything == PASS.

`prepare` proves the oracle is non-vacuous before any model runs by asserting
green -> inject -> red -> revert -> green on the frozen copy. `--repeat N` reuses
the same cwd (heavy dep dirs persist, .clio index rebuilds), so results are
pass@k over independent attempts, not single-shot determinism (no decode seed is
plumbed yet; see the report).

Subcommands: prepare | generate-tasks | run | settings | freeze | inject |
             testedit-ban | gate | envelope
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
TARGETS_JSON = HERE / "targets.json"
# clio_fleet lives one level up in community-benchmarks; reuse it so fleet
# endpoints/model names stay single-source (WS1).
COMMUNITY = HERE.parent / "community-benchmarks"
sys.path.insert(0, str(COMMUNITY))
try:
    from clio_fleet import load_fleet  # type: ignore
except Exception:  # pragma: no cover (guarded like the other adapters)
    load_fleet = None  # type: ignore

REPO_ROOT = HERE.parent.parent
DEFAULT_DIST = REPO_ROOT / "dist" / "cli" / "index.js"


# ---------------------------------------------------------------------------
# config
# ---------------------------------------------------------------------------
def load_targets() -> dict[str, Any]:
    return json.loads(TARGETS_JSON.read_text(encoding="utf-8"))


def target_config(name: str) -> tuple[dict[str, Any], dict[str, Any]]:
    root = load_targets()
    targets = root.get("targets", {})
    if name not in targets:
        raise KeyError(f"unknown target {name!r}; available: {sorted(targets)}")
    return root, targets[name]


def clio_dist() -> str:
    return os.environ.get("CLIO_DIST") or str(DEFAULT_DIST)


def fleet_or_die(profile: str | None) -> dict[str, Any]:
    if load_fleet is None:
        raise RuntimeError("clio_fleet.load_fleet unavailable; cannot resolve the model fleet")
    return load_fleet(profile=profile)


# ---------------------------------------------------------------------------
# git + injection primitives
# ---------------------------------------------------------------------------
def git(repo: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    proc = subprocess.run(
        ["git", "-C", str(repo), *args], capture_output=True, text=True
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed in {repo}: {proc.stderr.strip()[-400:]}")
    return proc


def inject_bug(repo: Path, bug: dict[str, Any]) -> None:
    """Apply the single deterministic regression. Asserts `find` occurs exactly
    once in the clean source so a drifted target can never inject silently."""
    path = repo / bug["file"]
    text = path.read_text(encoding="utf-8")
    count = text.count(bug["find"])
    if count != 1:
        raise RuntimeError(
            f"inject refused: expected `find` exactly once in {bug['file']}, found {count}. "
            "The target has drifted from the pinned oracle."
        )
    path.write_text(text.replace(bug["find"], bug["replace"], 1), encoding="utf-8")


def freeze_repo(repo: Path, cfg: dict[str, Any]) -> None:
    """Restore the frozen starting state for one attempt: reset to SHA, drop
    untracked cruft (keeping the excluded heavy dirs), then re-inject the bug."""
    git(repo, "reset", "--hard", cfg["sha"])
    clean = ["clean", "-fd"]
    for pat in cfg.get("clean_exclude", []):
        clean += ["-e", pat]
    git(repo, *clean)
    inject_bug(repo, cfg["bug"])


def run_gate(repo: Path, cfg: dict[str, Any]) -> int:
    proc = subprocess.run(cfg["gate"], cwd=str(repo), shell=True)
    return proc.returncode


def changed_test_files(repo: Path, cfg: dict[str, Any]) -> list[str]:
    out = git(repo, "diff", "--name-only", cfg["sha"], "--", cfg["test_pathspec"]).stdout
    return [line for line in out.splitlines() if line.strip()]


# ---------------------------------------------------------------------------
# settings.yaml rendering (from fleet.json, so endpoints stay single-source)
# ---------------------------------------------------------------------------
def render_settings(profile: str | None) -> dict[str, Any]:
    fleet = fleet_or_die(profile)
    orch = fleet["orchestrator"]
    work = fleet["workers"]
    targets: list[dict[str, Any]] = []
    seen: set[str] = set()
    for node in (orch, work):
        tid = node.get("target")
        if not tid or tid in seen:
            continue
        seen.add(tid)
        entry: dict[str, Any] = {"id": tid, "runtime": node.get("runtime")}
        if node.get("url"):
            entry["url"] = node["url"]
        if node.get("model"):
            entry["defaultModel"] = node["model"]
            entry["wireModels"] = [node["model"]]
        targets.append(entry)
    return {
        "version": 1,
        "identity": "clio",
        "autonomy": "full-auto",
        "targets": targets,
        "orchestrator": {
            "target": orch.get("target"),
            "model": orch.get("model"),
            "thinkingLevel": orch.get("thinking", "off"),
        },
        "workers": {
            "default": {
                "target": work.get("target"),
                "model": work.get("model"),
                "thinkingLevel": work.get("thinking", "off"),
            },
            "profiles": {},
        },
    }


def write_settings(path: Path, profile: str | None) -> dict[str, Any]:
    settings = render_settings(profile)
    try:
        import yaml  # type: ignore

        body = yaml.safe_dump(settings, sort_keys=False)
    except Exception:
        body = _minimal_yaml(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    return settings


def _minimal_yaml(value: Any, indent: int = 0) -> str:
    """Tiny YAML emitter for the settings shape, used only if PyYAML is absent."""
    pad = "  " * indent
    if isinstance(value, dict):
        if not value:
            return "{}\n"
        out = ""
        for key, val in value.items():
            if isinstance(val, (dict, list)) and val:
                out += f"{pad}{key}:\n{_minimal_yaml(val, indent + 1)}"
            else:
                out += f"{pad}{key}: {_scalar(val)}\n"
        return out
    if isinstance(value, list):
        out = ""
        for item in value:
            if isinstance(item, dict):
                first = True
                for key, val in item.items():
                    lead = "- " if first else "  "
                    if isinstance(val, (dict, list)) and val:
                        out += f"{pad}{lead}{key}:\n{_minimal_yaml(val, indent + 2)}"
                    else:
                        out += f"{pad}{lead}{key}: {_scalar(val)}\n"
                    first = False
            else:
                out += f"{pad}- {_scalar(item)}\n"
        return out
    return f"{pad}{_scalar(value)}\n"


def _scalar(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    return str(value)


# ---------------------------------------------------------------------------
# eval task-file generation
# ---------------------------------------------------------------------------
def build_prompt(root: dict[str, Any], cfg: dict[str, Any]) -> str:
    return root["template"].format(repo_name=cfg["repo_name"], symptom=cfg["symptom"])


def solve_command(prompt: str, logdir: Path, profile: str | None, agent: str | None = None) -> str:
    fleet = fleet_or_die(profile)
    orch = fleet["orchestrator"]
    dist = clio_dist()
    if agent:
        # Dispatch mode: `--agent <recipe>` routes to workers.default (the dynamo
        # worker in local-split), exercising the full cross-node dispatch path.
        # Do NOT pin --target/--model here or we would override the worker target.
        routing = f"--agent {shlex.quote(agent)}"
    else:
        # Main-agent mode: the orchestrator (mini) does the work directly.
        routing = (
            f"--target {shlex.quote(orch['target'])} --model {shlex.quote(orch['model'])}"
        )
    clio = (
        f"node {shlex.quote(dist)} --no-context-files --no-skills run --json "
        f"{routing} --thinking {shlex.quote(str(orch.get('thinking', 'off')))} "
        "--temperature 0 --top-k 1 --top-p 0.8 --min-p 0 "
        f"{shlex.quote(prompt)}"
    )
    ld = shlex.quote(str(logdir))
    # Swallow clio's own exit so the verifier decides pass/fail; a real timeout
    # still surfaces because the eval runner kills the shell (SIGTERM) and marks
    # the command timedOut. Every attempt's stdout/stderr + exit are archived.
    return (
        f"mkdir -p {ld} && TS=$(date +%s%N) && "
        f"{clio} 1>{ld}/clio-$TS.jsonl 2>{ld}/clio-$TS.err; "
        f'echo "attempt exit=$? ts=$TS" >> {ld}/attempts.log'
    )


def generate_tasks(args: argparse.Namespace) -> int:
    root, cfg = target_config(args.target)
    run_root = Path(args.run_root).resolve()
    target_dir = run_root / "target"
    logdir = run_root / "logs"
    script = str(HERE / "battletest_clio.py")
    prompt = build_prompt(root, cfg)

    agent = getattr(args, "agent", None)
    freeze_cmd = f"python3 {shlex.quote(script)} freeze --target {shlex.quote(args.target)} --repo {shlex.quote(str(target_dir))}"
    solve_cmd = solve_command(prompt, logdir, args.profile, agent)
    ban_cmd = f"python3 {shlex.quote(script)} testedit-ban --target {shlex.quote(args.target)} --repo {shlex.quote(str(target_dir))}"
    gate_cmd = f"python3 {shlex.quote(script)} gate --target {shlex.quote(args.target)} --repo {shlex.quote(str(target_dir))}"

    task_id = f"battletest-{args.target}-{agent}" if agent else f"battletest-{args.target}"
    lines = ["version: 1", "tasks:"]
    lines.append(f"  - id: {task_id}")
    lines.append("    prompt: |")
    lines.extend(f"      {line}" for line in prompt.splitlines())
    lines.append("    cwd: target")
    lines.append("    setup:")
    lines.append(f"      - {json.dumps(freeze_cmd)}")
    lines.append(f"      - {json.dumps(solve_cmd)}")
    lines.append("    verifier:")
    lines.append(f"      - {json.dumps(ban_cmd)}")
    lines.append(f"      - {json.dumps(gate_cmd)}")
    lines.append(f"    timeoutMs: {int(args.timeout) * 1000}")
    lines.append("    tags:")
    lines.append("      - battletest")
    lines.append(f"      - {args.target}")
    lines.append(f"      - {cfg['lang']}")
    lines.append(f"      - {'dispatch-' + agent if agent else 'main-agent'}")

    out = Path(args.out) if args.out else run_root / "tasks.yaml"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote battletest eval task for {args.target} -> {out}", file=sys.stderr)
    print(str(out))
    return 0


# ---------------------------------------------------------------------------
# prepare: copy, install deps, prove the oracle is non-vacuous
# ---------------------------------------------------------------------------
def prepare(args: argparse.Namespace) -> int:
    root, cfg = target_config(args.target)
    src = Path(cfg["repo"]).resolve()
    run_root = Path(args.run_root).resolve()
    target_dir = run_root / "target"
    if not (src / ".git").exists():
        print(f"ERROR: {src} is not a git repo", file=sys.stderr)
        return 1

    run_root.mkdir(parents=True, exist_ok=True)
    if target_dir.exists():
        if not args.force:
            print(f"ERROR: {target_dir} exists; pass --force to recopy", file=sys.stderr)
            return 1
        shutil.rmtree(target_dir)
    print(f"[prepare] copying {src} -> {target_dir}", file=sys.stderr)
    shutil.copytree(src, target_dir, symlinks=True)

    git(target_dir, "reset", "--hard", cfg["sha"])
    git(target_dir, "clean", "-fdx")
    full_sha = git(target_dir, "rev-parse", "HEAD").stdout.strip()
    tree_hash = git(target_dir, "rev-parse", "HEAD^{tree}").stdout.strip()
    print(f"[prepare] frozen at {full_sha} (tree {tree_hash})", file=sys.stderr)

    if not args.skip_install:
        print(f"[prepare] installing deps: {cfg['install']}", file=sys.stderr)
        rc = subprocess.run(cfg["install"], cwd=str(target_dir), shell=True).returncode
        if rc != 0:
            print(f"ERROR: dependency install failed (exit {rc})", file=sys.stderr)
            return 1

    # Oracle preflight: green -> inject -> red -> revert -> green.
    preflight: dict[str, Any] = {}
    if not args.skip_preflight:
        print("[prepare] preflight 1/3: gate on CLEAN tree (expect GREEN/0)", file=sys.stderr)
        clean_rc = run_gate(target_dir, cfg)
        preflight["clean_exit"] = clean_rc
        print(f"[prepare] preflight 2/3: inject bug, gate (expect RED/nonzero)", file=sys.stderr)
        inject_bug(target_dir, cfg["bug"])
        broken_rc = run_gate(target_dir, cfg)
        preflight["broken_exit"] = broken_rc
        print("[prepare] preflight 3/3: revert bug, gate (expect GREEN/0)", file=sys.stderr)
        git(target_dir, "checkout", "--", cfg["bug"]["file"])
        reverted_rc = run_gate(target_dir, cfg)
        preflight["reverted_exit"] = reverted_rc
        ok = clean_rc == 0 and broken_rc != 0 and reverted_rc == 0
        preflight["oracle_valid"] = ok
        if not ok:
            print(
                f"ORACLE INVALID: clean={clean_rc} broken={broken_rc} reverted={reverted_rc} "
                "(want 0, nonzero, 0). Fix the bug/gate before running.",
                file=sys.stderr,
            )
            _write_envelope(run_root, args.target, cfg, full_sha, tree_hash, preflight, args.profile)
            return 1
        print("[prepare] ORACLE VALID: green -> inject -> red -> revert -> green", file=sys.stderr)

    _write_envelope(run_root, args.target, cfg, full_sha, tree_hash, preflight, args.profile)
    print(str(target_dir))
    return 0


def _tool_versions() -> dict[str, str]:
    out: dict[str, str] = {}
    for name, cmd in (
        ("node", ["node", "--version"]),
        ("pnpm", ["pnpm", "--version"]),
        ("npm", ["npm", "--version"]),
        ("uv", ["uv", "--version"]),
        ("python", ["python3", "--version"]),
        ("git", ["git", "--version"]),
    ):
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
            out[name] = r.stdout.strip() or r.stderr.strip()
        except Exception:
            out[name] = "missing"
    return out


def _write_envelope(
    run_root: Path,
    target: str,
    cfg: dict[str, Any],
    full_sha: str,
    tree_hash: str,
    preflight: dict[str, Any],
    profile: str | None,
) -> None:
    fleet = fleet_or_die(profile) if load_fleet is not None else {}
    env_knobs = {
        k: os.environ.get(k)
        for k in (
            "CLIO_HOME",
            "CLIO_CONFIG_DIR",
            "CLIO_STATE_DIR",
            "CLIO_REQUIRE_HOME_PREFIX",
            "CLIO_RIGOR",
            "CLIO_MAX_TOOL_CALLS",
            "CLIO_ORCH_MAX_TOOL_CALLS",
            "CLIO_STATUS_STUCK_MS",
            "CLIO_NO_UPDATE_NOTIFIER",
        )
    }
    envelope = {
        "target": target,
        "repo": cfg["repo"],
        "pinnedSha": cfg["sha"],
        "resolvedSha": full_sha,
        "treeHash": tree_hash,
        "bug": cfg["bug"],
        "gate": cfg["gate"],
        "testPathspec": cfg["test_pathspec"],
        "sampler": {"temperature": 0, "topK": 1, "topP": 0.8, "minP": 0},
        "fleet": fleet,
        "envKnobs": env_knobs,
        "toolVersions": _tool_versions(),
        "preflight": preflight,
        "seedGap": "no per-request decode seed is plumbed; results are pass@k, not bit-reproducible",
    }
    (run_root / "envelope.json").write_text(json.dumps(envelope, indent=2) + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# run: prepare + settings + generate + `clio eval run --repeat N`
# ---------------------------------------------------------------------------
def run(args: argparse.Namespace) -> int:
    run_root = Path(args.run_root).resolve()
    # Settings live in the isolated CLIO_CONFIG_DIR the caller set up.
    config_dir = os.environ.get("CLIO_CONFIG_DIR")
    if config_dir and not args.skip_settings:
        settings_path = Path(config_dir) / "settings.yaml"
        write_settings(settings_path, args.profile)
        print(f"[run] wrote settings -> {settings_path}", file=sys.stderr)

    prep = prepare(args)
    if prep != 0:
        return prep

    gen_ns = argparse.Namespace(
        target=args.target, run_root=str(run_root), out=None,
        timeout=args.timeout, profile=args.profile, agent=getattr(args, "agent", None),
    )
    generate_tasks(gen_ns)
    tasks_yaml = run_root / "tasks.yaml"

    dist = clio_dist()
    cmd = ["node", dist, "eval", "run", "--task-file", str(tasks_yaml), "--repeat", str(args.repeat)]
    print(f"[run] {' '.join(shlex.quote(c) for c in cmd)}", file=sys.stderr)
    rc = subprocess.run(cmd).returncode
    print(f"[run] clio eval exit={rc}", file=sys.stderr)
    return rc


# ---------------------------------------------------------------------------
# thin subcommands used inside generated eval task commands
# ---------------------------------------------------------------------------
def cmd_freeze(args: argparse.Namespace) -> int:
    _, cfg = target_config(args.target)
    freeze_repo(Path(args.repo), cfg)
    return 0


def cmd_inject(args: argparse.Namespace) -> int:
    _, cfg = target_config(args.target)
    inject_bug(Path(args.repo), cfg["bug"])
    return 0


def cmd_testedit_ban(args: argparse.Namespace) -> int:
    _, cfg = target_config(args.target)
    changed = changed_test_files(Path(args.repo), cfg)
    if changed:
        print("TEST-EDIT BAN VIOLATED; changed test files:", file=sys.stderr)
        for path in changed:
            print(f"  {path}", file=sys.stderr)
        return 1
    return 0


def cmd_gate(args: argparse.Namespace) -> int:
    _, cfg = target_config(args.target)
    return run_gate(Path(args.repo), cfg)


def cmd_settings(args: argparse.Namespace) -> int:
    write_settings(Path(args.out), args.profile)
    print(str(args.out))
    return 0


# ---------------------------------------------------------------------------
# argparse
# ---------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def add_profile(p: argparse.ArgumentParser) -> None:
        p.add_argument("--profile", default=None, help="fleet profile (default: fleet.json default = local-split)")

    p_prep = sub.add_parser("prepare", help="copy target, install deps, prove the oracle")
    p_prep.add_argument("--target", required=True)
    p_prep.add_argument("--run-root", required=True)
    p_prep.add_argument("--force", action="store_true")
    p_prep.add_argument("--skip-install", action="store_true")
    p_prep.add_argument("--skip-preflight", action="store_true")
    add_profile(p_prep)
    p_prep.set_defaults(func=prepare)

    p_gen = sub.add_parser("generate-tasks", help="write the clio eval YAML")
    p_gen.add_argument("--target", required=True)
    p_gen.add_argument("--run-root", required=True)
    p_gen.add_argument("--out", default=None)
    p_gen.add_argument("--timeout", type=int, default=900, help="per-command wall cap (s)")
    p_gen.add_argument("--agent", default=None, help="dispatch via `clio run --agent <recipe>` (routes to the dynamo worker); omit for the mini main-agent path")
    add_profile(p_gen)
    p_gen.set_defaults(func=generate_tasks)

    p_run = sub.add_parser("run", help="prepare + generate + clio eval run --repeat N")
    p_run.add_argument("--target", required=True)
    p_run.add_argument("--run-root", required=True)
    p_run.add_argument("--repeat", type=int, default=1)
    p_run.add_argument("--timeout", type=int, default=900)
    p_run.add_argument("--force", action="store_true")
    p_run.add_argument("--skip-install", action="store_true")
    p_run.add_argument("--skip-preflight", action="store_true")
    p_run.add_argument("--skip-settings", action="store_true")
    p_run.add_argument("--agent", default=None, help="dispatch via `clio run --agent <recipe>` (routes to the dynamo worker); omit for the mini main-agent path")
    add_profile(p_run)
    p_run.set_defaults(func=run)

    p_set = sub.add_parser("settings", help="render settings.yaml from fleet.json")
    p_set.add_argument("--out", required=True)
    add_profile(p_set)
    p_set.set_defaults(func=cmd_settings)

    for name, fn in (("freeze", cmd_freeze), ("inject", cmd_inject), ("testedit-ban", cmd_testedit_ban), ("gate", cmd_gate)):
        p = sub.add_parser(name, help=f"{name} (used inside eval tasks)")
        p.add_argument("--target", required=True)
        p.add_argument("--repo", required=True)
        p.set_defaults(func=fn)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except Exception as exc:  # noqa: BLE001 - surfaced as a nonzero exit for the runner
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
