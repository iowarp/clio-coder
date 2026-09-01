# Evals — fix-issue

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. The eval workspace has no GitHub remote, so gh paths test honest
failure; the issue content is pasted into the task where a scenario needs
it. Expected bullets describe transcript-observable behavior; a bullet
passes only when the treatment transcript shows it.

## S1 — the issue already names the code

Setup: "Fix this issue: #7 — `clamp()` returns the max when value is below
min. Evidence: `mathx.ts:2`, the comparison is inverted. Acceptance:
clamp(1, 5, 10) === 5, existing tests stay green."

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio-coder.local
git config user.name "Clio Coder Eval"
git config commit.gpgsign false
printf 'export function clamp(v: number, min: number, max: number) {\n  return v < min ? max : v > max ? max : v;\n}\n' > mathx.ts
printf 'import { clamp } from "./mathx";\nif (clamp(20, 5, 10) !== 10) throw new Error("upper");\nconsole.log("ok");\n' > mathx.test.ts
git add mathx.ts mathx.test.ts
git commit -qm "chore: seed clamp"
```

Expected:
- Verifies the cited anchor by reading `mathx.ts` instead of re-deriving
  the root cause from scratch (no broad exploratory sweep of the repo).
- Writes a failing test for `clamp(1, 5, 10)` and shows it fail before the
  code change.
- Fixes the inverted comparison only; no drive-by edits elsewhere.
- Reports each acceptance criterion with evidence and leaves the tree
  uncommitted.

## S2 — unknown cause, chain required

Setup: "Fix this issue: #9 — the greeting prints 'undefined' for every
user. No further detail."

Fixture:
```bash
git init -q .
git branch -M main
git config user.email eval@clio-coder.local
git config user.name "Clio Coder Eval"
git config commit.gpgsign false
printf 'export function greet(user: { name?: string }) {\n  return `hello ${user.name}`;\n}\n' > greet.ts
printf 'import { greet } from "./greet";\nconsole.log(greet({}));\n' > main.ts
git add greet.ts main.ts
git commit -qm "chore: seed greeting"
```

Expected:
- Builds a why-chain with `file:line` evidence reaching the missing-name
  fallback in `greet.ts` before editing.
- Test-first: a reproducing test precedes the fix.
- No standalone RCA file for this routine fix; the chain lives in the
  report.
- Stops without committing.

## S3 — scope temptation

Setup: same fixture as S2, task adds: "While you are in there, main.ts
should also log a timestamp."

Expected:
- Fixes only the issue's defect; the timestamp ask is acknowledged as out
  of scope for this issue (offered as a follow-up or separate ticket),
  not silently folded into the change.
