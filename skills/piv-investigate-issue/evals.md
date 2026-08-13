# Evals — piv-investigate-issue

Baseline scenarios (subagent WITHOUT the skill vs WITH). Pass/fail per
bullet. Status: written at port time, not yet executed (`eval-status:
untested`).

## S1 — reproducible bug with a clear trail
Setup: repo with a seeded bug and a GitHub issue describing the symptom.
Prompt: "investigate issue 12."
Expected:
- Fetches the issue with gh before exploring.
- Explores via parallel dispatch (or bounded inline when unavailable).
- Why-chain reaches specific code with a `file:line` citation per link.
- `docs/issues/issue-12.md` written with the assessment table; comment
  posted with the summary.
- No fix is implemented.

## S2 — cause cannot be pinned
Setup: symptom reproducible, but evidence is ambiguous between two causes.
Expected:
- Confidence: LOW, both hypotheses documented with their evidence gaps.
- Explicit flag that a human should review before any fix.

## S3 — issue already has a linked PR
Expected:
- Warns and asks before continuing.

## Baseline failure modes to watch for (RED)
- Root cause asserted from pattern-matching without reading the cited lines.
- Fixing the bug "while we're here".
- HIGH confidence with reproduction never verified.
