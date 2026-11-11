#!/usr/bin/env python3
"""The scorer tests: every task has a recorded passing and a recorded failing run under tests/fixtures/prompt-eval/<id>/,
and its scorer must classify both. Exit 1 on any mismatch or missing recording.

  python3 -B selftest.py
"""
import json, os, sys

sys.dont_write_bytecode = True
import lib, tasks

bad = 0
for t in tasks.TASKS:
    for want in ("pass", "fail"):
        p = os.path.join(lib.RECORDED, t["id"], want + ".json")
        if not os.path.exists(p):
            print(f"MISSING {t['id']} {want}")
            bad += 1
            continue
        rec = json.load(open(p))
        got, note = t["score"](rec)
        ok = (got is True) == (want == "pass")
        bad += not ok
        src = rec.get("source", "?")
        print(f"{'ok  ' if ok else 'BAD '} {t['id']} {t['name']:<20} recorded={want:<4} scored={got}  [{src}] {note}")
print(f"\n{'all scorers classify their recordings' if not bad else f'{bad} problem(s)'}")
sys.exit(1 if bad else 0)
