#!/usr/bin/env python3
"""Render results files as one report: pass rate per task, profile and model; cross-task counters;
the four criteria for moving to the v2 prompt; run count, models, build commit; what it cannot show.

  python3 -B scripts/prompt-eval/report.py [--rescore] "$TMPDIR"/prompt-eval/*.jsonl

--rescore scores each stored run again with the current scorers, after a scorer fix.
"""
import collections, json, re, sys

sys.dont_write_bytecode = True

MALFORMED = re.compile(r"argument|schema|unknown capability|invalid|required|must be|expected", re.I)


def counters(rec):
    """Cross-task counters for one run, summed over its parts (sessions)."""
    rounds = sum(p.get("rounds", 0) for p in rec["parts"])
    malformed = sum(1 for p in rec["parts"] for t in p["tools"]
                    if t.get("error") and ((t.get("via") == "gateway" or t.get("name") == "gateway") and MALFORMED.search(t.get("text") or "")
                        or (t.get("via") == "acp" and isinstance(t.get("args"), dict) and "capability" in t["args"])))
    first = rec["parts"][0]["usage"][0] if rec["parts"] and rec["parts"][0].get("usage") else None
    c = {"rounds": rounds, "tool_calls": sum(len(p["tools"]) for p in rec["parts"]), "malformed_gateway": malformed}
    if first:
        c["prompt_tokens_first"] = first["input"] + first["cacheRead"]
        c["cached_first"] = first["cacheRead"] if first.get("cacheReadField") != "omitted" else None
    return c


def load(paths):
    rows = []
    for p in paths:
        rows += [json.loads(l) for l in open(p) if l.strip()]
    return rows


def rate(rs):
    scored = [r for r in rs if r["verdict"] is not None]
    if not scored:
        return None, 0, len(rs)
    return sum(1 for r in scored if r["verdict"]), len(scored), len(rs)


def rescore(rows):
    import tasks
    for rec in rows:
        try:
            rec["verdict"], rec["note"] = tasks.BY_ID[rec["task"]]["score"](rec)
        except Exception as x:
            rec["verdict"], rec["note"] = False, f"scorer error: {x!r}"


def render(paths, rescore_rows=False):
    rows = load(paths)
    if rescore_rows:
        rescore(rows)
    if not rows:
        return "no rows"
    models = sorted({r["model"] for r in rows})
    profiles = sorted({r["profile"] for r in rows})
    commits = sorted({r["commit"] for r in rows})
    by = collections.defaultdict(list)
    for r in rows:
        by[(r["task"], r["name"], r["model"], r["profile"])].append(r)
    tasks = sorted({(r["task"], r["name"]) for r in rows})
    L = [f"# Prompt-profile evaluation", "",
         f"Runs: {len(rows)} rows; models: {', '.join(models)}; profiles: {', '.join(profiles)}; build commit(s): {', '.join(commits)}.", ""]
    head = "| task | " + " | ".join(f"{m.split('/')[-1]} {p}" for m in models for p in profiles) + " |"
    L += [head, "|" + "---|" * (1 + len(models) * len(profiles))]
    pr = {}
    for tid, name in tasks:
        cells = []
        for m in models:
            for p in profiles:
                ok, n, tot = rate(by[(tid, name, m, p)])
                pr[(tid, m, p)] = (ok, n)
                cells.append("-" if tot == 0 else ("n/a" if ok is None else f"{ok}/{n}"))
        L.append(f"| {tid} {name} | " + " | ".join(cells) + " |")
    L += ["", "Counters (mean per run): tool rounds, tool calls, malformed gateway calls, first-request prompt tokens, first-request cached input.", "",
          "| model profile | rounds | calls | malformed gw | prompt tok (1st req) | cached (1st req) |", "|---|---|---|---|---|---|"]
    for m in models:
        for p in profiles:
            rs = [r for r in rows if r["model"] == m and r["profile"] == p]
            def mean(k):
                v = [r["counters"].get(k) for r in rs if r["counters"].get(k) is not None]
                return f"{sum(v) / len(v):.1f}" if v else "n/a"
            L.append(f"| {m.split('/')[-1]} {p} | {mean('rounds')} | {mean('tool_calls')} | {mean('malformed_gateway')} | {mean('prompt_tokens_first')} | {mean('cached_first')} |")
    offers = {}
    for m in models:
        for p in profiles:
            rs = [r for r in rows if r["model"] == m and r["profile"] == p and r["task"] in ("11", "12", "14")]
            o = [bool(re.search(r"closingOffer=True|offer=True", r["note"])) for r in rs]
            offers[(m, p)] = f"{sum(o)}/{len(o)}" if o else "n/a"
    L += ["", "Closing-offer rate on tasks 11, 12, 14 (persona-evaluation patterns): " +
          "; ".join(f"{m.split('/')[-1]} {p} {v}" for (m, p), v in offers.items()), ""]
    L += ["## Flip criteria, v2 against v1", ""]
    if not {"v1", "v2"} <= set(profiles):
        L.append("Not evaluable: both profiles are needed.")
    else:
        drops = []
        for tid, _ in tasks:
            for m in models:
                (o1, n1), (o2, n2) = pr.get((tid, m, "v1"), (None, 0)), pr.get((tid, m, "v2"), (None, 0))
                if o1 is not None and o2 is not None and n1 and n2 and (o1 / n1 - o2 / n2) * 5 > 1 + 1e-9:
                    drops.append(f"{tid} on {m.split('/')[-1]} ({o1}/{n1} -> {o2}/{n2})")
        L.append(f"1. No task's pass rate falls by more than one run in five on either model: {'MET' if not drops else 'NOT MET: ' + ', '.join(drops)}")
        local = [m for m in models if m.startswith("mini/")]
        if not local:
            L.append("2. Tasks 2, 4, 7 and 8 improve on the local model: NOT EVALUATED (no local-model rows)")
        else:
            m = local[0]
            imp = []
            for tid in ("02", "04", "07", "08"):
                (o1, n1), (o2, n2) = pr.get((tid, m, "v1"), (None, 0)), pr.get((tid, m, "v2"), (None, 0))
                imp.append((tid, o1 is not None and o2 is not None and n1 and n2 and o2 / n2 > o1 / n1, f"{o1}/{n1}->{o2}/{n2}"))
            L.append("2. Tasks 2, 4, 7 and 8 improve on the local model: " + ("MET" if all(x[1] for x in imp) else "NOT MET") +
                     " (" + ", ".join(f"{t} {s}" for t, _, s in imp) + ")")
        L.append("3. System prompt characters meet the budgets: NOT EVALUATED here (prompt size is measured by the product's prompt tests; "
                 "first-request prompt tokens above are the proxy)")
        c16 = [r for r in rows if r["task"] == "16" and r["profile"] == "v2"]
        if not c16 or all(r["verdict"] is None for r in c16):
            L.append("4. First-request cached share on task 16 above 80% of the system prompt: NOT EVALUATED (provider does not report cached input)")
        else:
            L.append("4. First-request cached share on task 16: " + "; ".join(r["note"] for r in c16) + " (80% bar needs the system-prompt token count; read against the share)")
    L += ["", "## What this cannot show", "",
          "- Long-session behavior: every task is one or two short sessions.",
          f"- Models other than the ones run ({', '.join(models)}).",
          f"- Small samples: with {max(len(v) for v in by.values())} run(s) per cell, only large gaps (0/5 against 4/5) separate.",
          "- ACP tasks (7, 11, 12) carry no usage counters; their ask_user cards are answered with a cancel.",
          "- Task 4 offers the Slurm skill through `--skill`, not an installed package; task 9 turns the safety judge off so the force push needs approval, which a headless run denies."]
    return "\n".join(L)


if __name__ == "__main__":
    args = sys.argv[1:]
    print(render([a for a in args if a != "--rescore"], "--rescore" in args))
