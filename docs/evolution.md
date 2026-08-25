# Evolution and Change Manifests

> [!TIP]
> **Interactive Spec Available:** An interactive change manifest editor, authority risk assessor, and checklist workspace is located at [docs/html/evolution_blueprint.html](html/evolution_blueprint.html) (Version: 0.3.7).

Clio Coder uses change manifests to make harness changes reviewable, falsifiable, and rollback-friendly. CLIO stands for Context Layer for Input/Output, named for the Greek muse of history. A manifest is JSON, generated or checked with `clio-coder evolve manifest`, and should describe what changed, why, what evidence supports it, what could regress, how to validate it, and how to roll it back.

Source of truth: `src/domains/evolution/manifest.ts`, `src/domains/evolution/validate.ts`, and `src/cli/evolve.ts`.

---

## CLI

```bash
clio-coder evolve manifest init > change-manifest.json
clio-coder evolve manifest validate change-manifest.json
clio-coder evolve manifest summarize change-manifest.json
```

`init` prints a template. `validate` exits non-zero and reports JSON paths when fields are missing or invalid. In `v0.2.9`, it additionally resolves each non-empty `evidenceRefs` entry (which must match `run-<id>` or `session-<id>` formatting) against the local evidence store, failing validation if a referenced bundle is not found. `summarize` prints the iteration id, base SHA, authority levels, components, files, predicted regressions, validation-step count, and reports evidence refs resolution.

---

## Minimal manifest

```json
{
  "version": 1,
  "iterationId": "exploratory-1",
  "baseGitSha": "0000000000000000000000000000000000000000",
  "createdAt": "2026-04-29T00:00:00.000Z",
  "changes": [
    {
      "id": "change-1",
      "componentIds": ["context-file:CLIO-CODER.md"],
      "filesChanged": ["CLIO-CODER.md"],
      "authorityLevel": "prompt",
      "evidenceRefs": [],
      "rootCause": "First exploratory iteration; no evidence corpus exists yet.",
      "targetedFix": "Describe the smallest proposed harness change.",
      "predictedFixes": ["One expected improvement."],
      "predictedRegressions": [],
      "validationPlan": ["npm run test"],
      "rollbackPlan": "Revert the filesChanged entries for this change.",
      "expectedBudgetImpact": {
        "risk": "same"
      }
    }
  ]
}
```

Only the first exploratory iteration (`iterationId: "exploratory-1"`) is permitted to use an empty `evidenceRefs` array. For all other iterations, the manifest must cite valid evidence of verification.

### Evidence-Linked Validation (Slice 5a)

During `clio-coder evolve manifest validate` and `summarize` commands, Clio Coder validates the referenced evidence bundles:
- **Format Verification**: Every reference in the `evidenceRefs` array must follow the format `run-<id>` or `session-<id>`.
- **Durable Store Resolution**: Each reference must correspond to a folder that actually exists under `<dataDir>/evidence/`. If any referenced bundle is missing, validation fails and reports a dangling reference issue.
- **Engine Boundaries**: To maintain the domain boundaries the lint-time boundary checker enforces, the validation function `validateChangeManifest` is completely decoupled. It accepts a `resolveEvidenceRef` predicate option. The CLI passes a resolver connected to the evidence store, keeping the evolution domain from directly importing the evidence domain.

### Self-Edit Gate Deferral (Slice 5b)

Enforcement of high-authority self-edits (Slice 5b) is deferred per the status and design in `src/domains/evolution/SELF_EDIT_GATE.md`.

#### Why it is Deferred
To enforce that Clio Coder cannot modify its own codebase (specifically paths mapped to `HIGH_AUTHORITY_LEVELS` such as `src/engine/**` or `src/domains/safety/**`) without a validated change manifest, the harness must distinguish between:
1. **Agent-Initiated Self-Edits**: Clio editing its own harness paths autonomously.
2. **Operator-Requested Edits**: The developer instructing Clio to modify files in the repository.

Currently, the middleware lacks a reliable signal to separate these two scenarios. Implementing a naive path-glob filter would block developers from making ordinary source changes, which is forbidden by the release specification.

#### Concrete Gate Design and Re-entry
When the required signal (`selfEditOrigin: "operator-requested" | "agent-initiated"`) is implemented, Slice 5b will run as a `before_tool` middleware registration. For any high-authority tool call classified as `agent-initiated`, it will require a change manifest whose `evidenceRefs` validate against the local evidence store, returning a `block_tool` effect if missing.


---

## Schema notes

| Field | Type | Requirement |
| --- | --- | --- |
| `version` | literal `1` | Required. |
| `iterationId` | non-empty string | Required. `exploratory-1` has special empty-evidence handling. |
| `baseGitSha` | non-empty string | Required. Use the commit the change was based on. |
| `createdAt` | non-empty string | Required; ISO timestamp recommended. |
| `changes` | array | Required. |
| `changes[].id` | non-empty string | Required. |
| `changes[].componentIds` | string array | Required; can be empty only if `filesChanged` is non-empty. |
| `changes[].filesChanged` | string array | Required; can be empty only if `componentIds` is non-empty. |
| `changes[].authorityLevel` | enum | Required; see below. |
| `changes[].evidenceRefs` | string array | Required; empty only for `exploratory-1`. |
| `changes[].rootCause` | non-empty string | Required. |
| `changes[].targetedFix` | non-empty string | Required. |
| `changes[].predictedFixes` | string array | Required. |
| `changes[].predictedRegressions` | string array | Required; high-authority changes require at least one entry. |
| `changes[].validationPlan` | string array | Required. |
| `changes[].rollbackPlan` | non-empty string | Required. |
| `changes[].expectedBudgetImpact` | object | Optional; when present, `risk` is required. |

Authority levels:

```text
prompt | tool-description | tool-implementation | middleware | memory | runtime | safety | schema | cli
```

High-authority levels are:

```text
tool-implementation | middleware | runtime | safety | schema | cli
```

High-authority changes must list predicted regressions. This is deliberate: the point of the manifest is not to promise safety, but to make risk reviewable.

Budget impact risk values:

```text
lower | same | higher
```

Optional budget deltas:

```json
"expectedBudgetImpact": {
  "tokenDelta": 500,
  "wallTimeDeltaMs": 2000,
  "risk": "higher"
}
```

---

## Recommended workflow

1. Capture the current commit: `git rev-parse HEAD`.
2. Run `clio-coder components snapshot --out before.json` if the change affects prompts, tools, runtimes, safety, schemas, or recipes.
3. Draft the change manifest.
4. Implement the smallest change set.
5. Run the validation plan and update `evidenceRefs` with resolved evidence bundle IDs such as `run-<id>` or `session-<id>` where available.
6. Run `clio-coder evolve manifest validate` and include the manifest in review notes.
7. If the change fails, use `rollbackPlan` rather than ad hoc cleanup.

Change manifests are especially useful for experimental CLIO work because they separate evidence-backed claims from plans, hypotheses, and future milestones.
