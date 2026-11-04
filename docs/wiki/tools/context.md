---
title: "Environment context tool"
summary: "How the context tool answers questions about the working environment (workspace snapshot, settings, budget, skills, recall, opt-in semantic search) and how its scopes are gated, rendered and tested. Read this before changing scope handling, skill activation refusals, or the semantic tool surface."
sources:
  - "src/tools/context/index.ts"
  - "src/tools/context/surface.ts"
  - "src/tools/context/semantic.ts"
  - "src/tools/context/docs-engine.ts"
  - "src/tools/context/library.ts"
  - "src/tools/core-bootstrap.ts"
symbols:
  - "createContextTool"
  - "createContextToolSurface"
  - "runSemanticScope"
  - "runSkillsScope"
  - "pendingSkillPolicyError"
  - "runDocsScope"
tests:
  - "tests/contracts/context-semantic.test.ts"
  - "tests/extended/skill-library-activation.test.ts"
invariants:
  - "The context tool accepts scope values workspace, settings, skills, recall, budget and semantic; semantic is advertised only when the settings snapshot makes it usable at registration, and docs and library are refused with a pointer to the gateway capability."
  - "scope=semantic returns an error without loading the search bridge when the host reports the feature disabled, and it never refreshes sources or appends session entries."
  - "scope=skills refuses a load by name unless the pending-skill policy permits it; a manual-only skill loads only for an operator-requested pending request from a slash-command or selector source."
validate:
  - "pnpm run test:file -- tests/contracts/context-semantic.test.ts"
  - "pnpm run test:file -- tests/extended/skill-library-activation.test.ts"
---

# Environment context tool

The `context` tool is the model's single read-only entry point for facts about the working environment rather than the source tree itself. A reader needs this page when changing what a scope returns, how a skill load is refused, or how the semantic search surface is advertised. Repository code navigation belongs to `code_nav`, and the bundled documentation and recipe catalog are gateway capabilities; see [Tools](../tools.md) and [Domains context](../domains/context.md).

## What the tool does

`createContextTool` in `src/tools/context/index.ts` returns a `ToolSpec` whose `run` dispatches on `args.scope`. The accepted scopes are checked in the body of `run`:

- `workspace` returns the session workspace snapshot, probing and saving one when none exists (`runWorkspaceScope`).
- `settings` renders a paged view of effective settings through `settingsAwareness`, with `offset` and `limit` bounded to 12 rows.
- `budget` returns the live request budget. It rejects any extra argument beyond `scope`.
- `skills` lists installed and marketplace skills, or loads one when `name` is given (`runRankedSkillsScope` and `runSkillsScope`).
- `recall` readmits an evicted tool result by ref or path (`runRecallScope`).
- `semantic` runs an explicit search through `runSemanticScope` in `src/tools/context/semantic.ts`.

A `scope` of `docs` or `library` is not executed here. The handler returns an error that names `gateway(op="call", capability="clio_docs" | "clio_library", ...)`. `runDocsScope` in the same file is exported for that gateway capability, and `src/tools/context/library.ts` holds the body-free recipe catalog. The docs search itself is in `src/tools/context/docs-engine.ts` (`listDocsCorpus` and `searchDocs`).

Before any scope handler runs, `run` reserves a share of the per-turn observation pool through `reserveObservation` with a self cap that depends on the scope. If the reservation is exhausted, the call returns `observationBudgetExhausted` and the scope does no work.

## Registration and the advertised surface

`createContextToolSurface` in `src/tools/context/surface.ts` builds the name, description, parameter schema and execution mode. Its single argument is the `semantic` settings block. The `semantic` scope value, its extra parameters (`kinds`, `run_id`, `media_type`, `after`, `before`) and the `semantic` description sentence are included only when `semanticUsable(semantic)` from `src/core/config.ts` is true. The file's comment states that settings fix the advertised capability at registration.

`src/tools/core-bootstrap.ts` builds the surface once, `contextSurface = createContextToolSurface(deps.getSettings?.().context.semantic)`, and registers it through `lazyTool`. The implementation is loaded on first use with `createContextTool(skillToolDeps, contextSurface)`. Worker registries without a session get the same tool without the session dependency. Session-bound registries add `session` and `workspace` deps.

## Semantic scope

The semantic path has three gates before any search runs.

1. `createContextTool` returns `semanticUnavailable()` when `deps.semantic?.isEnabled()` is false. This message is produced in `src/tools/context/semantic.ts:semanticUnavailable`.
2. `runSemanticScope` parses the request with `parseRequest`. Unknown keys, a query outside 1 to 2000 characters, a limit outside 1 to 20 (default 5), unsupported kinds, out-of-range `run_id` or `media_type`, and malformed `after`/`before` values all return an error string before any search. A date-only `before` is widened to the end of its UTC day.
3. The search is raced against a 6000 ms timer and the caller's abort signal (`SEMANTIC_TOOL_TIMEOUT_MS`). The bridge is loaded through `deps.loadSearch()` and checked again with `deps.isEnabled()` before results are used.

Results are filtered by `paths.allows(hit.path)` unless the hit is `kind === "memory"`, truncated to the requested limit, and excerpts are cut to 480 characters. If the JSON exceeds the reservation's call cap, hits are popped until it fits, and `truncated` is set. The payload carries a `followUp` string that tells the model to inspect originals before making claims.

The focused test `tests/contracts/context-semantic.test.ts` checks the disabled path. A call with `{ scope: "semantic", query: "retry" }` returns `kind: "error"` with a message matching `/disabled.*code_nav/`, and the loader is never invoked (`loads === 0`). The same file's agreement test loops over four settings cases (pinned, missing target, missing model, missing asset identity). For each, it asserts that the turn-context hint, the registered tool's semantic result and the advertised `scope` enum all agree on whether semantic search is usable. The test also covers `kinds`, `run_id` and date validation through rejected inputs and the `limit: 20` upper bound.

## Skill loads and refusals

Skill loading is gated by `pendingSkillPolicyError` in `src/tools/context/index.ts`. The decision order, as written in that function, is:

- With no `pendingSkillPolicy` on the invocation, the refusal is the operator-only message (`operatorOnly`, kind `operator-only`).
- When `modelActivation` is true and the run is not recipe-bound, a load of an already-loaded skill is refused with kind `already-loaded`. Any other name passes through (`null`), and the skill's lookup decides the outcome.
- Otherwise, a name outside `allowedSkillNames` is refused. Recipe-bound runs get kind `recipe-bound`. A carried surface gets the operator-only message. Other runs get kind `not-requested`.
- A name already in `loadedSkillNames` is refused with kind `already-loaded`.

`runSkillsScope` applies two further refusals. A load of `ship` is refused with kind `recipe-bound` when the invocation has a task worktree. A skill that is installed but not ready, a `disableModelInvocation` skill, an untrusted plugin skill, or a skill discovered but not imported each return a `skillRefusal` with its own kind (`not-ready`, `manual-only`, `untrusted`, `not-imported`).

A manual-only skill loads only when `operatorRequestedManualSkill` is true. That requires the skill to be trusted, to have `disableModelInvocation`, and a pending request marked installed whose source is `slash-command` or `selector`. The comment in source states that recipe and marketplace requests do not widen visibility.

The focused test `tests/extended/skill-library-activation.test.ts` loads every plugin skill in a fixture of 40. For each skill with `disableModelInvocation`, a call under an automatic policy returns an error whose message matches `/explicit operator activation/`. The same skill then loads successfully under a policy built from a parsed `/skill <name>` request, and the returned `details` carry the matching `filePath`. A separate case in the same file calls `scope: "skills", name: "foreign-only"` at line 213 for the not-imported path; this was not read in full, so its assertion is not described here.

## Listing and ranking

With no `name`, `runSkillsScope` builds a catalog through `buildSkillCatalogView` from `src/domains/resources/index.ts`. Ready rows, installed packages and marketplace rows are included unless the skill loader options disable discovery or the worker registry sets `skillMarketplace: false`. Drifted skills are annotated by `driftedSkillNames`, which annotates and does not hide the skill. The optional `rankSkills` dependency reorders the listing but never shortens it (`runRankedSkillsScope`). The per-row `details` are keyed by row identity, so they match the text the model sees.

`withSkillsPointer` appends a one-line `skills` pointer to the workspace snapshot. It counts visible installed skills and marketplace rows, and it reports no catalog entries.

## Callers and dependencies

Upstream, `src/tools/core-bootstrap.ts` is the registration site, and the registry hands the `ToolSpec` to the model's tool surface. Downstream, the context tool depends on `src/tools/observation.ts` for reservations and envelopes, `src/domains/resources/index.ts` for skill loading and catalog views, `src/domains/plugins/index.ts` for `withPluginDiscoveryPass`, `src/domains/semantic/index.ts` types for semantic results, and `src/core/config.ts` for `semanticUsable`. The skill refusals return the structured `details.refusal` shape built by `skillRefusal`.

## Things to watch when editing

- The advertised `scope` enum and parameter set come from `createContextToolSurface`, which is called at registration. Changes to `semanticUsable`'s inputs take effect for the registered schema only after the registry is rebuilt. The agreement test in `tests/contracts/context-semantic.test.ts` pins this across the four settings cases.
- Skill refusal messages are model-facing text, and `pendingSkillPolicyError` also sets a `kind` that the transcript records. Changing a message without its kind, or the reverse, changes what the operator sees. Tests match some of these messages by regular expression, for example `/explicit operator activation/` and `/disabled.*code_nav/`.
- The semantic path never appends session entries or refreshes the index. Adding a refresh inside `runSemanticScope` would change the documented contract in the file's own comment.
- `runSkillsScope` filters `details` by stable row keys. A new listing kind must add its key to the same `shown` check, or its details will disagree with the text.
- Coverage limit: the docs, library and recall scopes were not traced end to end. `runRecallScope`, `runBudgetScope` and the library catalog body were not read, so their behavior is described here only at the level of their dispatch in `run`.
