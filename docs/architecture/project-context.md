# Project context: codemap, orientation, status, and guidance

Clio keeps structural navigation separate from authored guidance, current work evidence, and deeper explanations. An ordinary session gets a small orientation and retrieval pointers. It does not preload the structural index or the generated wiki bodies.

| Artifact | Owner and purpose | Creation and updates | Model surface and failure behavior |
| --- | --- | --- | --- |
| `.clio-coder/codemap.json` | Deterministic files, languages, roles, content identities, symbols, imports and dependency edges; schema v5 | `context index`, `context init`, `context refresh`; background session-start reconciliation; notified tool edits; demand navigation | `code_nav` returns bounded views. A missing, malformed or stale index is rebuilt privately for read-only navigation. Prompt presence is a snapshot availability hint, not a freshness certificate. |
| `.clio-coder/state.json` | Deterministic lifecycle evidence: source fingerprint, recorded project type, index timestamps, imported guidance identities, bootstrap provenance and bounded orientation | The existing index transactions update orientation from the committed map and bounded root inputs. Stop updates the session timestamp under the index lease. | The prompt reads the small state, never the full map. Invalid lifecycle state is unavailable. A damaged or unknown optional orientation is discarded without discarding valid lifecycle evidence. |
| `state.json` → `orientation` | Declared identity/purpose, declared command entry points, source/test counts, areas and entry candidates; no model summaries | Common root manifests and README, at most 64 KiB per input, plus the existing typed map; stored with an observation time, workspace identity and source identities | At most 2,100 characters of snapshot orientation. Changed or newly added checked root inputs and a copied worktree state invalidate the view. Unreadable or oversized inputs remain unknown; facts from other checked inputs can still appear with an explicit partial-coverage warning. Current source paths must be checked before editing. |
| `.clio-coder/user-tasks.json` | Durable operator intent, acceptance declarations and recorded handoff/progress links; owned by the operator-task store | Explicit task operations and linked session reconciliation | `code_nav mode=project` reads a bounded, validated current snapshot. Recorded `done` is not evidence of passing checks. Missing tasks are absent; malformed/oversized/unreadable tasks are unknown. |
| Session task boards, decisions and verification/evidence stores | Run/session progress, blockers, decisions, completion claims and actual check receipts | Their existing session and evidence operations | `tasks action=list` and the existing evidence/trace surfaces retain ownership. Orientation does not copy these stores, merge different sessions or infer a global completion state. |
| `CLIO-CODER.md` and overrides/ancestor handbooks | Explicit project guidance; authored text remains authoritative guidance within its scope | Operator edits, explicit bootstrap/apply operations; automatic index refresh preserves them | Main prompt preload preserves authored bytes with omission metadata. Bounded workers receive sections selected by role/path, or a bounded prose prefix. |
| `.clio-coder/wiki/**/*.md`, `meta.json`, plan/checkpoint | Deeper, model-generated explanations grounded in declared source inputs | Explicit wiki generation/update; per-page dispatch, validation and staged publication | A small checkpoint hint in prompts; `code_nav mode=wiki` resolves pages and checks freshness. Existing Markdown can await successful validation. Coverage without generation evidence is unknown. |
| `docs/wiki/` and its publishing workflow | Preserved public documentation/checkpoint publication | Explicit export/publishing workflow | Ordinary packaged/repository docs, independent of the workspace's live `.clio-coder/wiki`. File presence is not proof of a completed wiki plan or a qualified release. |
| Packaged `docs/**/*.md` | Clio product reference and browser documentation | Release packaging | `clio-coder docs` and the docs retrieval capability read these offline. They describe Clio, not the current project's status. |
| Packaged `src/**` | Runtime-loaded prompt fragments, provider/resources data, extension runtime/API, and source for Clio's own navigation | Release packaging | The fragment loader loads Markdown from `src/domains/prompts/fragments`; bundled navigation points to shipped source that `read` can open. Removing all source would break these consumers. |
| `dist/assets/codemap.json` | Clio's own deterministic, packed-file structural map | Build after the executable/assets are built; file membership comes from `npm pack --dry-run` | `code_nav source=clio` resolves shipped files against the installed package root. This is separate from the current workspace map and state. |

## Storage and presentation

**Codemap** is the public name for the structural index. It is not a wiki. Compact JSON remains its storage format: native parsing, existing typed validation, deterministic normalization, and v2–v5 migration support already serve its consumers. A full index is substantially larger than a useful model context, in every tested format. Navigation returns compact JSON containing the requested symbols, paths, outlines or dependencies; storage bytes and model input tokens are separate measurements.

The canonical workspace and bundled filenames are `codemap.json`. Readers accept legacy workspace `.clio-coder/codewiki.json` and a legacy bundled `dist/assets/codewiki.json` when the canonical file is absent. The next workspace writer publishes the canonical file. A legacy workspace file remains until reset for existing clients, so migration can temporarily duplicate cache bytes; readers select the canonical file thereafter. A malformed canonical artifact never falls back to potentially older legacy facts. Reset removes both workspace spellings. Protected worktree paths include both.

The normalized index shape remains schema v5. Existing TypeScript API names, state `codewikiVersion`, bootstrap telemetry keys and the `context index --json` compatibility field `codewikiPath` remain available. `codemapPath` is the preferred coverage field. State stays version 1 with an optional, independently versioned orientation; older readers already ignore additive state fields. Older binaries cannot discover a newly created canonical-only index: upgrade running clients together. Mixed-version writers share the existing legacy lease identity, and new navigation still validates actual source before answering.

TOON's tabular encoding does not help this ragged index enough to justify a new parser and migration surface. TOML is useful for human-authored configuration but adds parsing and repeated-table overhead here. XML adds escaping and structure overhead. POML can compose model prompts; wrapping an entire index in it does not make a navigation database smaller or more useful. See the reproducible comparison in `benchmarks/project-context/` in a source checkout; benchmark artifacts are not shipped as product docs.

## Freshness and concurrency

Prompt compilation and bounded dispatch do not enumerate/hash the whole project, parse the map, read wiki Markdown, or call a model. When state has no recorded project type, the foreground uses root filenames as a hint; source classification belongs to indexing. Root orientation input identities are checked with bounded reads. A partial view includes only identity/command facts whose declared source input has a captured content identity; unknown inputs are named and never certified. The prompt explicitly says that the structural snapshot and wiki source freshness have not been certified there.

CMake identity extraction ignores comments and quoted/bracket examples; it records literal declarations without evaluating CMake. Preset command hints preserve the declared name with POSIX shell quoting. Hidden presets and names over 80 characters or containing control characters are omitted rather than changed into a different command.

Source reconciliation still runs in the existing build worker. Content identities, not mtimes alone, detect external edits, equal-size edits with restored mtimes, additions, deletions, renames, configuration/ignore changes and a different checked-out tree. Read-only navigation has a private, bounded artifact cache and reconciles current source before returning facts. A wiki read verifies its own broader source evidence and Git checkpoint. Background checks and tool retrieval perform the expensive work, so the prompt remains responsive.

Changed-file notifications first check the named inputs without parsing or building dependencies. An irrelevant or unchanged notification retains the old global baseline; it cannot hide unrelated external drift. A real change enters one coherent global reconciliation rather than first building a speculative dependency graph and then reconciling it again. Stable before/after fingerprints and bounded retries protect publication when files change during generation.

All codemap writers and reset share the existing queue and filesystem lease. Writes remain atomic replacements. A reader can observe state and map from adjacent commits because these are separate files; neither prompt availability nor a task status is a freshness certificate, and navigation repairs against source. Bootstrap completion preserves any newer leased index/state and records the handbook's separate `bootstrapFingerprint`. A late session timestamp cannot overwrite another process's newer source snapshot. Automatic updates preserve authored guidance.

`code_nav mode=project` obtains current Git HEAD, branch and porcelain status asynchronously and reads the operator-task store through its existing validator. It labels the observation time and provenance, caps task output, and leaves unavailable observations unknown. These independently owned stores are not one filesystem transaction: concurrent Git/task changes may occur between observations. There is no invented project objective, synthesized global blocker or automatic verified-completion summary.

Git output is bounded to 24 complete status records; a rename/copy record includes its source path after an embedded NUL in the same `porcelain` string. A failed codemap reconstruction returns `orientation: null` and a `codemap` unknown reason while retaining available Git and operator-task observations.

## Consumption

Start with `clio-coder context index` for deterministic context without generating a handbook or calling a model. `context init` adds explicit handbook/bootstrap handling; `context refresh` refreshes the structural context while preserving handbooks. Wiki updates remain explicit.

Useful model calls include:

```text
code_nav({mode:"project"})
code_nav({mode:"symbol",query:"solve",limit:10})
code_nav({mode:"deps",query:"src/solver.ts"})
code_nav({mode:"dependents",query:"src/solver.ts"})
code_nav({mode:"wiki",query:"architecture"})
```

`source=clio` is for navigating the installed Clio implementation. `mode=project` and `mode=wiki` describe the workspace and are unavailable with `source=clio`; use the product docs capability for Clio documentation.

Bounded workers receive up to 2,400 characters of complete codemap/orientation/wiki support fragments, independently of whether a handbook is present. Their existing handbook policy and omission notices remain separate. Receipt provenance includes the orientation message. A worker's task worktree supplies structural/status facts; a source-checkout handbook fallback does not substitute the source checkout's map or status. Workers configured with project-context tier `none` retain that policy.

Installed operation needs the executable/worker bundles, vendored grammar assets, prompt/resource files, product Markdown, and the bundled map. Offline source navigation and docs remain supported. Package size is measured separately from model tokens; this change preserves shipped source and docs because their consumers require them.
