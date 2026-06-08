# Evolution and Change Manifests

> [!TIP]
> **Interactive Spec Available:** An interactive change manifest editor, authority risk assessor, and checklist workspace is located at [docs/html/evolution_blueprint.html](html/evolution_blueprint.html) (Version: 0.2.2).

Clio Coder uses change manifests to make harness changes reviewable, falsifiable, and rollback-friendly. A manifest is JSON, generated or checked with `clio evolve manifest`, and should describe what changed, why, what evidence supports it, what could regress, how to validate it, and how to roll it back.

Source of truth: `src/domains/evolution/manifest.ts`, `src/domains/evolution/validate.ts`, and `src/cli/evolve.ts`.

---

## CLI

```bash
clio evolve manifest init > change-manifest.json
clio evolve manifest validate change-manifest.json
clio evolve manifest summarize change-manifest.json
```

`init` prints a template. `validate` exits non-zero and reports JSON paths when fields are missing or invalid. `summarize` prints the iteration id, base SHA, authority levels, components, files, predicted regressions, and validation-step count.

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
      "componentIds": ["context-file:CLIO.md"],
      "filesChanged": ["CLIO.md"],
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

Only `iterationId: "exploratory-1"` may use an empty `evidenceRefs` array. Later iterations should cite evidence IDs, eval IDs, receipts, or other reviewable artifacts.

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
2. Run `clio components snapshot --out before.json` if the change affects prompts, tools, runtimes, safety, schemas, or recipes.
3. Draft the change manifest.
4. Implement the smallest change set.
5. Run the validation plan and update `evidenceRefs` with receipts/evidence/eval artifacts where available.
6. Run `clio evolve manifest validate` and include the manifest in review notes.
7. If the change fails, use `rollbackPlan` rather than ad hoc cleanup.

Change manifests are especially useful for experimental CLIO work because they separate evidence-backed claims from plans, hypotheses, and future milestones.
