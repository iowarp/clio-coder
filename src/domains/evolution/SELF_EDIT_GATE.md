# Self-edit gate (Slice 5b) - deferred

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

There is no safe enforcement point with all required inputs yet. Clio's edits to
local source go through the ordinary edit/middleware path, which can see tools,
paths, and action classes, but does not distinguish "Clio editing her own
harness in this repo" from "the user asked Clio to edit this repo's source". A
naive gate keyed on path globs would block ordinary, user-requested edits, which
the spec explicitly forbids
(`v0.2.7-evidence-spine.md`, Slice 5: enforcement "must NOT block ordinary local
source edits the user requests; it only applies to Clio editing her own harness
paths"). The spec permits landing 5a in v0.2.7 and tracking 5b rather than
forcing a fragile gate.

## Concrete design

The enforcement point should be a `before_tool` middleware registration, because
the registry already supplies `toolName`, `toolArgs`, `runId`, `sessionId`,
`turnId`, and `metadata.actionClass` before a mutating tool executes. The gate
would run only when all of these are true:

1. The process is running from the Clio repository root.
2. The tool would mutate a harness-owned path. Reuse `toolMutationPaths()` for
   `write` / `edit` / artifact writers, and the shell write-target extraction
   already used by the safety classifier for `bash`.
3. The target path maps to a high-authority manifest level:
   `src/engine/**`, `src/tools/**`, `src/domains/safety/**`,
   `src/domains/middleware/**`, `src/domains/context/**`,
   `src/domains/prompts/**`, `src/interactive/**`, `src/worker/**`,
   `skills/**`, `damage-control-rules.yaml`, and release / packaging surfaces
   map to one of `HIGH_AUTHORITY_LEVELS`.
4. The tool-call origin is an agent-initiated harness self-edit, not an
   operator-requested local source edit.
5. A current change manifest is available and validates with
   `validateChangeManifest(value, { resolveEvidenceRef })`, including at least
   one evidence ref that resolves against the local evidence store.

If the gate fires and the manifest check fails, it should return one
`block_tool` effect with a clear instruction to create or validate the manifest.
It must not block ordinary user-requested local edits, even to the paths above.

## Minimal missing signal

The current middleware input does not provide item 4. The minimal signal is one
typed scalar on `MiddlewareHookInput.metadata`, set by the engine/registry at
tool admission time:

```ts
selfEditOrigin: "operator-requested" | "agent-initiated"
```

`operator-requested` means the current turn's accepted user request explicitly
asked for the edit or command. `agent-initiated` means the model is modifying
Clio's harness without a current user request that names or implies that
modification. Unknown must be treated as `operator-requested` until the signal is
implemented, because fail-closed would violate the spec by blocking normal local
edits.

This signal should be derived before tool invocation, next to the existing
`ToolInvokeOptions` / `buildToolHookInput()` path in `src/tools/registry.ts`.
The classifier cannot infer it from paths, action classes, or autonomy alone:
those say what would be touched, not who initiated the intent.

## Re-entry condition

5b can land once there is a clean, unambiguous signal in middleware input that
an edit is Clio modifying her own harness in this repository (as opposed to a
user-directed source edit). At that point the gate reads: for a high-authority
self-edit with
`metadata.selfEditOrigin === "agent-initiated"`, require a manifest whose
`evidenceRefs` resolve against the evidence store before the edit is permitted;
otherwise block that tool call and re-prompt for the manifest. The 5a validator
(`validateChangeManifest(value, { resolveEvidenceRef })`) is the check it would
call; no manifest schema change is needed.

Intended commit when it lands:
`feat(evolution): require a manifest for high-authority self-edits`.
