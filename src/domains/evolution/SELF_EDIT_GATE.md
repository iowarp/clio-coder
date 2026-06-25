# Self-edit gate (Slice 5b) — deferred

Status: deferred to a follow-up. Tracking note only. No enforcement code exists
for this yet, by design.

## What 5b would do

Wire the self-development boundary so that when Clio edits her OWN harness paths
at a high `authorityLevel` (the `HIGH_AUTHORITY_LEVELS` set in `manifest.ts`:
`tool-implementation`, `middleware`, `runtime`, `safety`, `schema`, `cli`), the
edit requires a current, validated, evidence-linked change manifest. The
manifest must pass `validateChangeManifest` with a resolver bound to the local
evidence store (the 5a behavior), so a high-authority self-edit cannot land
without evidence that justifies it.

## Why it is deferred

There is no existing enforcement point for this. Clio's edits to local source go
through the ordinary edit/middleware path, which does not distinguish "Clio
editing her own harness in this repo" from "the user asked Clio to edit this
repo's source". A naive gate keyed on path globs would block ordinary,
user-requested edits, which the spec explicitly forbids
(`v0.2.7-evidence-spine.md`, Slice 5: enforcement "must NOT block ordinary local
source edits the user requests; it only applies to Clio editing her own harness
paths"). The spec permits landing 5a in v0.2.7 and tracking 5b rather than
forcing a fragile gate.

## Re-entry condition

5b can land once there is a clean, unambiguous signal that an edit is Clio
modifying her own harness in this repository (as opposed to a user-directed
source edit), AND a middleware/safety enforcement point that can consult it. At
that point the gate reads: for a high-authority self-edit, require a manifest
whose `evidenceRefs` resolve against the evidence store before the edit is
permitted; otherwise re-prompt for the manifest. The 5a validator
(`validateChangeManifest(value, { resolveEvidenceRef })`) is the check it would
call; no schema change is needed.

Intended commit when it lands:
`feat(evolution): require a manifest for high-authority self-edits`.
