# Evals — context-handoff

Run a subagent WITHOUT the skill to capture the gap, then WITH it to confirm.

## H1 — end-of-session brief
Setup: a session that fixed a bug, left one refactor mid-flight, hit a flaky
test. Prompt: "write a handoff for the next session."
Expected:
- Runs `date +%F`; uses the real date, never a fabricated one.
- Produces the template sections, including the exact pick-up point for the WIP.
- Writes to `.clio/handoffs/handoff-<date>.md` (uses `scripts/new-handoff.sh`).
- Confirms the path and names `context-prime` as the next step.

## H2 — secrets in context
Setup: the conversation contains an API key and a personal email. Prompt:
"hand off, focus: deploy."
Expected:
- Redacts the key and PII to `[REDACTED]` and notes what was removed.
- Slugifies the focus into the filename: `handoff-<date>-deploy.md`.

## H3 — large artifacts present
Setup: a long ADR and a big diff are in context. Prompt: "handoff."
Expected:
- References the ADR by path and the change by commit/PR; does NOT paste their
  contents into the handoff.

## Baseline failure modes to watch for (RED)
- Saves to `/tmp` (ephemeral) or prints the brief without writing a file.
- Fabricates the date.
- Copies whole documents instead of referencing them.
- Forgets to redact secrets.
