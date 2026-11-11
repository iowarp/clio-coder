#!/usr/bin/env python3
"""Run the prompt-profile matrix for one model and print the report.

  pnpm eval:prompts -- --seed-home <home> --target <target> --model <model> [--profiles v1,v2] [--runs 5]
                       [--tasks 01,02] [--lock <file>] [--out <file.jsonl>] [--keep-raw]

Each (task, profile, run) gets a fresh home and a fresh fixture workspace; every prompt of a task is a new
session in that same home and workspace. One JSON row per run is appended to --out; the report follows.
"""
import argparse, datetime, fcntl, json, os, shutil, sys

sys.dont_write_bytecode = True
import lib, report, tasks

ap = argparse.ArgumentParser()
ap.add_argument("--target", required=True)
ap.add_argument("--model", required=True)
ap.add_argument("--profiles", default="v1,v2")
ap.add_argument("--runs", type=int, default=5)
ap.add_argument("--tasks", default="")
ap.add_argument("--worktree", default=tasks.WORKTREE, help="checkout whose dist/ runs (default: this one)")
ap.add_argument("--seed-home", default=os.environ.get("CLIO_EVAL_SEED_HOME", ""),
                help="credential-free Clio home whose targets the runs copy (or CLIO_EVAL_SEED_HOME)")
ap.add_argument("--lock", default="", help="flock this file around each Clio call, for a route that serves one at a time")
ap.add_argument("--timeout", type=int, default=600)
ap.add_argument("--out", default="")
ap.add_argument("--keep-raw", action="store_true", help="keep each run's raw event stream next to the results")
a = ap.parse_args()

cli = os.path.join(a.worktree, "dist/cli/index.js")
if not os.path.exists(cli):
    sys.exit(f"no build at {cli}: run `pnpm run build` in the worktree")
if not a.seed_home or not os.path.isfile(os.path.join(a.seed_home, "config", "settings.yaml")):
    sys.exit("--seed-home must name a Clio home with config/settings.yaml and the run's target configured")
commit = lib.build_commit(a.worktree)
stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M")
out = a.out or os.path.join(lib.tmproot(), "prompt-eval", f"{stamp}-{a.model.replace('/', '_')}.jsonl")
os.makedirs(os.path.dirname(out), exist_ok=True)
rawdir = out[:-6] + ".raw"
sel = [tasks.BY_ID[i] for i in a.tasks.split(",")] if a.tasks else tasks.TASKS


class Lock:
    def __enter__(self):
        self.f = open(a.lock, "a") if a.lock else None
        if self.f:
            fcntl.flock(self.f, fcntl.LOCK_EX)

    def __exit__(self, *x):
        if self.f:
            fcntl.flock(self.f, fcntl.LOCK_UN)
            self.f.close()


for n in range(a.runs):
    for t in sel:
        for prof in a.profiles.split(","):
            home = lib.make_home(prof, a.target, a.model, a.seed_home, t.get("safety", ()))
            ws = lib.make_workspace(t["fixture"], t.get("remote"))
            parts = []
            for i, prompt in enumerate(t["prompts"]):
                with Lock():
                    if t["surface"] == "acp":
                        part, raw = lib.run_acp(cli, home, ws, prompt, a.target, a.model, timeout=a.timeout)
                    else:
                        part, raw = lib.run_headless(cli, home, ws, prompt, a.target, a.model, t.get("flags", ()), a.timeout)
                part["files_changed"] = lib.changed_files(ws)
                parts.append(part)
                if a.keep_raw:
                    os.makedirs(rawdir, exist_ok=True)
                    open(f"{rawdir}/{t['id']}-{prof}-{n}-{i}.jsonl", "w").write(raw)
            rec = {"task": t["id"], "name": t["name"], "profile": prof, "target": a.target, "model": a.model, "run": n,
                   "surface": t["surface"], "commit": commit, "parts": parts}
            try:
                verdict, note = t["score"](rec)
            except Exception as x:
                verdict, note = False, f"scorer error: {x!r}"
            rec.update(verdict=verdict, note=note, counters=report.counters(rec))
            with open(out, "a") as f:
                f.write(json.dumps(rec) + "\n")
            print(f"[{n}] {t['id']} {t['name']:<20} {prof} {'PASS' if verdict else ('n/a' if verdict is None else 'FAIL')}  {note}", flush=True)
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(ws, ignore_errors=True)

print()
print(report.render([out]))
print(f"\nresults: {out}")
