# Change Manifest and Evolve CLI

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The evolution domain makes meaningful harness improvement proposals typed and falsifiable. A change manifest is a JSON document that names the iteration, the base git sha, and one or more typed `ManifestChange` entries. Each change declares its authority level, the components or files it touches, the evidence that motivated it, the failure it targets, predicted fixes and regressions, a validation plan, and a rollback plan. The manifest is the unit that downstream slices (attribution, regression scouting, rollback) will key off. The CLI surface is `clio evolve manifest init`, `clio evolve manifest validate <path>`, and `clio evolve manifest summarize <path>`.

## Data layout

The evolution domain has no persistent storage. Manifests are JSON files the operator chooses where to commit. The convention is to store them next to a sprint plan or under `docs/.superpowers/sprints/`, but the validator does not enforce a path. `clio evolve manifest init` writes a template to stdout, not to disk.

## Public CLI surface

- `clio evolve manifest init` writes a populated `ChangeManifest` template to stdout, including one example `ManifestChange` with `iterationId: exploratory-1`, a placeholder `baseGitSha`, an empty `evidenceRefs[]`, and a `validationPlan` of `["npm run test"]`. The template is intentionally minimal and is expected to be edited before validation.
- `clio evolve manifest validate <path>` parses the JSON at `<path>`, runs structural validation, and exits 0 with `manifest valid (N change[s])` or exits 1 with one issue per line under `manifest invalid (N issue[s])`. Each issue carries a JSON-pointer-style `path` (`$.changes[0].rollbackPlan`) and a one-sentence message.
- `clio evolve manifest summarize <path>` validates the manifest, then prints a multi-line summary: iteration id, base sha, change count, deduplicated authority levels, deduplicated component ids, deduplicated changed files, deduplicated predicted regressions, and total validation step count.

## Public types

Types live in `src/domains/evolution/manifest.ts` and are re-exported from `src/domains/evolution/index.ts`.

- `ChangeManifest` carries `version: 1`, `iterationId`, `baseGitSha`, `createdAt`, and `changes[]`.
- `ManifestChange` carries `id`, `componentIds[]`, `filesChanged[]`, `authorityLevel`, `evidenceRefs[]`, `rootCause`, `targetedFix`, `predictedFixes[]`, `predictedRegressions[]`, `validationPlan[]`, `rollbackPlan`, and optional `expectedBudgetImpact`.
- `ManifestAuthorityLevel` enumerates 9 levels: `prompt`, `tool-description`, `tool-implementation`, `middleware`, `memory`, `runtime`, `safety`, `schema`, `cli`. The high-authority subset is `tool-implementation`, `middleware`, `runtime`, `safety`, `schema`, `cli`.
- `ExpectedBudgetImpact` carries optional `tokenDelta`, optional `wallTimeDeltaMs`, and a required `risk` of `lower`, `same`, or `higher`.
- `ChangeManifestSummary` is the deduplicated, sorted summary returned by `summarizeChangeManifest()`.
- `ManifestValidationResult` is a discriminated union over `valid: true | false`. Invalid results carry a `ManifestValidationIssue[]` list with `{ path, message }` entries.

## Invariants

1. `version` must equal `1`.
2. `iterationId`, `baseGitSha`, and `createdAt` are required non-empty strings; `changes` is a required array.
3. Every change declares at least one entry in `componentIds[]` or `filesChanged[]`. An empty change is rejected.
4. Every change carries a non-empty `rollbackPlan`. There is no implicit revert path.
5. High-authority changes (`tool-implementation`, `middleware`, `runtime`, `safety`, `schema`, `cli`) require at least one `predictedRegressions[]` entry.
6. Empty `evidenceRefs[]` is admitted only when `iterationId === "exploratory-1"`. Every later iteration must cite at least one evidence id per change.
7. Authority levels and budget risks are validated against the closed enumerations in `manifest.ts`; unknown values produce an issue.
8. Validation issues are accumulated; the validator runs every check before returning so the operator sees every problem in one pass.

## Status and scope notes

v0.1.4 ships the manifest schema, the validator, the summarizer, and the three CLI subcommands. Manifest authoring is manual today; the M9 `evolver` agent recipe drafts manifests as Markdown plus a JSON block, and the operator commits the result. Auto-attribution against eval baselines is the M9 `attributor` recipe's job and is not enforced by the CLI. `clio --dev` does not yet refuse to hand off when no manifest exists; that gate is reserved for a later slice. The schema is intentionally not extensible: adding a new authority level requires editing `MANIFEST_AUTHORITY_LEVELS`.

## References

- `src/domains/evolution/manifest.ts`: the schema, template, and summary helpers.
- `src/domains/evolution/validate.ts`: the structural validator.
- `src/domains/evolution/index.ts`: public domain entry.
- `src/cli/evolve.ts`: CLI wiring.
- `tests/unit/evolution-manifest.test.ts`: regression coverage.
- `docs/.superpowers/IMPROVE.md` section M2: roadmap entry.
