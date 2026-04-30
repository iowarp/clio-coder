# Long-Term Memory Domain

Date: 2026-04-29
Status: shipped in v0.1.4

## Goal

The memory domain stores scoped, approved, evidence-linked lessons learned from prior runs and injects a compact section into the system prompt when matching memory exists. Records are proposed from evidence corpora, approved or rejected by the operator, and pruned by deterministic staleness rules. Retrieval is gated by approval state, scope, evidence presence, regression history, a fixed token budget, and a hard item-count cap. Memory is the only consumer of the curation lifecycle: it does not mutate prompts or settings outside the dedicated `memory.dynamic` prompt fragment slot. The CLI surface is `clio memory list`, `clio memory propose`, `clio memory approve`, `clio memory reject`, and `clio memory prune`.

## Data layout

The memory store is a single JSON file:

```
<dataDir>/memory/records.json
```

The file is `{ version: 1, records[] }`. Records are sorted on write by `(scope, key, createdAt, id)` so two operators running the same operations against the same store produce byte-identical files. The store is capped at `MEMORY_STORE_MAX_RECORDS = 500`; writing past the cap fails with a hint to run `clio memory prune --stale`. Records have no per-record file; the JSON document is the unit of read and write.

## Public CLI surface

- `clio memory list` prints every record with id, status (`proposed`, `approved`, or `rejected`), scope, confidence, evidence ref list, key, and lesson.
- `clio memory propose --from-evidence <evidenceId>` reads the named evidence corpus, derives a candidate record from its findings, upserts it with `approved: false`, and prints the proposed record. Re-running with the same evidence id is idempotent.
- `clio memory approve <memoryId>` flips a record to `approved: true`, sets `lastVerifiedAt` to the current time, and clears any `rejectedAt` field.
- `clio memory reject <memoryId>` flips `approved` to `false` and stamps `rejectedAt`. The record is preserved so it does not get re-proposed automatically.
- `clio memory prune --stale` removes records whose `lastVerifiedAt` (or `createdAt` if never verified) is older than the staleness window, and prints the count removed.

## Public types

Types live in `src/domains/memory/types.ts` and are re-exported from `src/domains/memory/index.ts`.

- `MemoryScope` enumerates 7 scopes: `global`, `repo`, `language`, `runtime`, `agent`, `task-family`, `hpc-domain`.
- `MemoryRecord` carries `id`, `scope`, `key`, `lesson`, `evidenceRefs[]`, `appliesWhen[]`, `avoidWhen[]`, `confidence` (0..1), `createdAt`, optional `lastVerifiedAt`, optional `regressions[]`, `approved`, and optional `rejectedAt`.
- `MemoryStoreFile` is `{ version: 1, records[] }`.
- `MemoryStatus` is the derived `proposed | approved | rejected` enum used by the CLI list view.
- `MemoryRetrievalOptions` carries `scopes[]` and `tokenBudget`.
- `MemoryProposalResult` carries the resulting record plus a `created` flag distinguishing first proposal from idempotent re-proposal.
- `MemoryPruneResult` carries `pruned[]` and `kept[]`.

## Invariants

1. Unapproved memory is never injected into prompts. Retrieval filters on `approved === true`.
2. Memory must cite at least one evidence ref. Records with empty `evidenceRefs[]` are filtered out at retrieval time even when approved.
3. Records with a non-empty `regressions[]` array are suppressed at retrieval. Suppression is a soft delete; the record stays in the store for audit.
4. Prompt injection has a fixed token budget (`MEMORY_PROMPT_DEFAULT_TOKEN_BUDGET = 400`) and a hard item count cap (`MEMORY_PROMPT_DEFAULT_MAX_ITEMS = 5`). Both are exceeded by no caller.
5. The default prompt-injection scope set is `["global", "repo"]`. Other scopes need richer call-site context and are opted into per call site.
6. The store is bounded at 500 records. Approved records become stale after 180 days without verification (`MEMORY_STALE_APPROVED_DAYS`); unapproved records become stale after 30 days (`MEMORY_STALE_UNAPPROVED_DAYS`).
7. Staleness compares against `lastVerifiedAt` when present, otherwise `createdAt`. A record with an unparsable timestamp is treated as stale.
8. The retrieval section is omitted entirely when no record applies; the `memory.dynamic` prompt fragment slot resolves to an empty string and the consumer must treat a missing section as a no-op.
9. The memory section is built by `buildMemoryPromptSection()` and is the only sanctioned shape; consumers do not hand-format memory into prompts.

## Status and scope notes

Memory was deliberately de-domain-modulated in v0.1.4: it does not export a `manifest`, `contract`, or `extension` and is not registered as a domain module. Consumers import directly from `src/domains/memory/index.ts`. The domain is consumed by both the chat-loop and the worker dispatch path: `src/cli/run.ts` calls `loadMemoryRecordsSync` and passes the rendered section through `DispatchRequest.memorySection`, and `dispatch.buildSystemPrompt` prepends the section to whichever base prompt wins (`req.systemPrompt` or `recipe.body`). Workers see the same gated memory the orchestrator does. Proposal heuristics in `proposal.ts` are intentionally simple in v0.1.4: the `memory-curator` agent recipe is the long-term path for deriving high-quality candidate records.

## References

- `src/domains/memory/types.ts`: type surface.
- `src/domains/memory/store.ts`: filesystem layout, sort order, and staleness window constants.
- `src/domains/memory/operations.ts`: approve, reject, prune, and retrieval helpers.
- `src/domains/memory/proposal.ts`: candidate record derivation from evidence.
- `src/domains/memory/prompt-section.ts`: deterministic prompt section builder and the budget and item-count constants.
- `src/domains/memory/validate.ts`: record and store validation.
- `src/domains/memory/index.ts`: public domain entry.
- `src/cli/memory.ts`: CLI wiring.
- `src/domains/prompts/fragments/memory/`: dedicated dynamic memory prompt fragment.
- `tests/unit/memory.test.ts`, `tests/unit/memory-prompt-section.test.ts`, `tests/unit/chat-loop-memory-injection.test.ts`, `tests/unit/dispatch-memory-injection.test.ts`: regression coverage.
- `docs/.superpowers/IMPROVE.md` section M8: roadmap entry.
