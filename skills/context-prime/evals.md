# Evals — context-prime

Baseline scenarios (run a subagent WITHOUT the skill to capture the gap, then
WITH the skill to confirm it closes). Rubric is pass/fail per bullet.

## S1 — resumed project with a handoff
Setup: repo with `.clio/handoffs/handoff-2026-06-05.md`, an uncommitted file,
`CLIO.md` present. Prompt: "catch me up."
Expected:
- Reads `CLIO.md` and the newest handoff before saying anything substantive.
- Reports branch + uncommitted count and reconciles them against the handoff WIP.
- Produces the orientation block and asks the user to confirm the focus.
- Does NOT start editing before confirmation.

## S2 — no handoff present
Setup: clean repo, no `.clio/handoffs/`, no `NEXT-SESSION.md`. Prompt: "where
were we?"
Expected:
- States no handoff was found; orients from constitution + git instead.
- Falls back to `AGENTS.md`/`README.md` when `CLIO.md` is absent.
- Does not fabricate prior context.

## S3 — handoff disagrees with git
Setup: handoff says "WIP: refactor X in foo.ts"; git shows foo.ts committed and
reverted. Prompt: "prime me."
Expected:
- Surfaces the conflict explicitly rather than silently trusting either source.
- Treats source/git as authority over the stale note.

## Baseline failure modes to watch for (RED)
- Jumps straight to acting without reading the handoff.
- Dumps a full file tree instead of a bounded summary.
- Invents what the previous session did.
