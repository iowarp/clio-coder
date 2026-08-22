# Working Set

The working set is the part of the session ledger the model actually receives on the next request. When context pressure crosses `compaction.threshold`, Clio narrows that view before it considers summarizing anything: selected tool-result bodies and closed-turn thinking blocks stop being replayed, and a one-line marker takes each body's place. Nothing is deleted. The ledger keeps every byte the tools produced, the transcript keeps showing them, and the model can ask for any evicted body back by ref.

Source of truth is `src/domains/context/working-set/` (`contract.ts`, `fold.ts`, `project.ts`, `marker.ts`, `protect.ts`, `engine.ts`, `recall.ts`, `policies/`), the ledger records in `src/domains/session/entries.ts`, and the compaction stage in `src/interactive/turn-context.ts` (`runAutoCompact`).

> [!WARNING]
> This is an experimental community alpha surface. The default policy is `structural-v1`, chosen from the replay tables under `benchmarks/results/context-replay/`. `age-horizon` reproduces the selection Clio made before this layer existed and stays available.

## Vocabulary

| Term | Definition |
| --- | --- |
| Working set | What the model sees on the next request: the ledger with the current projection applied. It is never a file. |
| Ledger | The durable append-only session record (`current.jsonl`). The working-set layer appends to it and never rewrites it. |
| Evicted | A unit whose body the projection replaces with a marker. The ledger entry that holds the original body is untouched. |
| Offloaded | A result the observation envelope already wrote to a file because it exceeded the per-call cap. Its marker carries the pointer instead of a preview, and recall returns the pointer rather than inlining the file. |
| Recall | Readmitting an evicted body by ref, through `context(scope="recall", ref=...)` for the model or `/context recall <ref>` for the operator. |
| Marker | The byte-stable one-line stub the projection renders in place of an evicted body. It names the ref, the reason, the size, and the exact call that brings the body back. |
| Projection | A pure, in-memory transform from ledger entries to the entries the replay builder hands the model. `projectWorkingSet(entries, view)` is that function. |

## Eviction is a projection, not a rewrite

The stage this layer replaces rewrote history. `maskStaleObservations` walked the entries, replaced observation bodies with a masked-out string, and called `session.replaceEntries`. That destroyed the only copy: after a mask, `/resume`, `/tree`, `/fork`, and the HTML export all showed the placeholder, and the content was gone for the operator as well as the model.

The working-set layer separates the two audiences. What leaves is recorded as a `contextEviction` entry, appended like any other. `refreshAgentMessagesFromSession` folds those entries into a `WorkingSetView` and applies `projectWorkingSet` before `buildReplayAgentMessagesFromTurns` runs, so only the messages bound for the provider carry markers. Every reader that shows the session to a human reads the raw ledger and sees the full bodies.

Three properties follow from that shape:

- **Idempotence.** Projecting an already-projected slice reproduces it byte for byte, because the marker comes from the ledger entry rather than from the body being replaced.
- **Branch safety.** The fold runs through `filterEntriesToActivePath` (issue #94), so an eviction recorded on a branch `/tree` later abandoned cannot project onto the live one, and a fork inherits the view of its shared prefix.
- **Determinism.** A policy is a pure function of `PolicyInput`. The same ledger and the same settings select the same units in a live session and in an offline replay of that session.

Usage anchors recorded before an eviction described a longer prompt than the model will now receive, so the projection stamps `contextUsageInvalidated` on assistant entries that precede the newest eviction event. Without that, `calculateContextTokens` would keep reporting the pre-eviction size and the pressure estimator would never see the space the event freed.

## Ledger records and format v4

Two entry kinds carry the layer, both defined in `src/domains/session/entries.ts`:

| Kind | Fields | Meaning |
| --- | --- | --- |
| `contextEviction` | `policyId`, `trigger` (`pressure` or `operator`), `evicted[]`, `tokensBefore`, `tokensAfter`, `pressureBefore`, `snapshotIdBefore` | One applied event. Each `evicted[]` item is `{ ref, reason, tokensFreed, marker, by? }`. |
| `contextRecall` | `ref`, `trigger` (`tool` or `operator`), `tokensReadmitted`, `toolCallId?` | One readmission of one ref. It is a churn record, not an un-eviction. |

`reason` is one of `superseded_read`, `stale_after_mutation`, `listing_consumed`, `failure_resolved`, `thinking_turn_closed`, `age_horizon`, `operator`. A `ref` is the `turnId` of the ledger entry that holds the unit: for a `tool_result` message the unit is the result body, and for an `assistant` message it is every thinking block the message carries. Per-block eviction is deliberately not modelled.

Adding those kinds bumps the session format to version 4 (`CURRENT_SESSION_FORMAT_VERSION = 4` in `src/engine/session.ts`). The bump is additive: no existing entry kind changes shape, so a version 3 session migrates to 4 in place when Clio opens it and no entry is rewritten. `runMigrations` refuses only what it cannot read, a session written by a newer build, with "upgrade clio-coder to resume this session". The bump is still one-way for the operator: Clio 0.3.3 does not know these kinds and cannot open a session this release wrote.

## The marker contract

A marker is one line, its fields are in fixed order, and it carries no timestamp and no counter. That is not cosmetic. The marker is persisted inside the `contextEviction` entry and replayed on every subsequent request, so a marker whose bytes drifted between renders would cold-start the provider prefix cache on a turn that evicted nothing new. It would also make two replays of the same recorded ledger disagree.

Field order is `ref`, `reason`, `by`, `tool`, `path`, `size`, `offload`, `recall`, then the body tail. Undefined fields are omitted rather than rendered empty. `path` is the one file the result was about: `details.paths` when the tool recorded exactly one (`edit`, `write`, `artifact`), otherwise the `path` argument of the call as the model wrote it, which is how a `read` marker names its file. Real output from `renderMarker` in `src/domains/context/working-set/marker.ts`:

```text
[evicted ref=0198f3c2-7a10-7c31-9d44-2b0c5f1e88a3 reason=stale_after_mutation by=0198f3c2-9b02-7f55-8e10-6d21ac9e4471 tool=read path=src/domains/context/working-set/engine.ts size=41 lines/3.8KB recall=context(scope="recall", ref="0198f3c2-7a10-7c31-9d44-2b0c5f1e88a3") preview="export function planEviction(policy: WorkingSetPolicy, input: PolicyInput): EvictionPlan | null { export function planEv"]
```

```text
[evicted ref=0198f3c2-1d44-7a90-b201-77c0e1a2f5de reason=failure_resolved by=0198f3c3-0002-7ab1-9c33-14ff90bb2c07 tool=bash size=4 lines/152B recall=context(scope="recall", ref="0198f3c2-1d44-7a90-b201-77c0e1a2f5de") first_line="src/interactive/turn-context.ts(466,15): error TS2345: Argument of type 'PolicyInput' is not assignable to parameter of "]
```

```text
[evicted ref=0198f3c4-55aa-7be2-8f01-9a3d6c2b1e77 reason=listing_consumed tool=grep size=1 lines/234.4KB offload=/home/dev/.local/state/clio-coder/offload/0198f3c4-grep.txt recall=context(scope="recall", ref="0198f3c4-55aa-7be2-8f01-9a3d6c2b1e77")]
```

Three rules govern the tail. Most reasons render `preview`: the first 120 characters of the body, whitespace collapsed and double quotes escaped, so the preview cannot break the quoted field or spill onto a second line. A `failure_resolved` eviction renders `first_line` instead, because the line that says what failed is worth the marker's tokens where a preview of a stack trace is not. An offloaded body renders neither, because the `offload=` pointer already promises the full artifact at a stable path and a preview would spend tokens repeating it.

Thinking eviction renders no marker at all. The reasoning simply stops being replayed. A marker there would spend tokens announcing that something the model cannot act on is gone.

## Policies

A policy answers one question: which units should leave. It never writes, never reads a clock, and never calls a model. `planEviction` then materializes the selection into `EvictedItem`s with markers rendered and tokens measured, and prices the result against the projection the model will actually receive.

### Protection predicates

`protect.ts` runs before every rule in `structural-v1` and is absolute. A policy is allowed to be wrong about relevance; it is not allowed to drop these:

1. Anything that is not a `tool_result` or `assistant` message. Operator words, compaction and branch summaries, skill activations, task ledgers, worker runs, and bash executions are the session's record of itself.
2. Anything inside the recent window, which starts at `protectionCutoffIndex(entries, protectLastTurns)`. A turn starts at a user message, a `bashExecution`, or a `branchSummary`.
3. A result whose estimated body is below `minEvictableTokens`. This protects low-yield bodies from churn; the engine independently rejects a marker that would free no tokens.
4. A body the legacy destructive stage already replaced, which has nothing left to evict.
5. A call the safety rails blocked. A refused call is a decision the session made, not an observation it can re-fetch.
6. A write or edit the turn in flight is still standing on.
7. A failure nothing later resolved, and any unindexed failure, because without an observation there is no way to ask whether it was resolved.

### `age-horizon`

The rule `maskStaleObservations` applied, recorded instead of destroyed. Every `tool_result` body older than the protection horizon leaves the working set, and every `assistant` message older than the horizon loses its thinking blocks. Same turn-start definition, same cutoff, and a body carrying a legacy compaction marker is skipped the same way.

One skip condition is new, so this is today's selection minus small results rather than a byte-identical reproduction of it: a result whose estimated body is below `minEvictableTokens` (200 tokens by default) stays, whatever its age. The engine already rejects markers that save no tokens; the higher default is a measured low-yield churn guard. The old mask had no such floor and masked those results too. Thinking has no size floor either way, because dropping it renders no marker.

`age-horizon` has no target stop. It evicts everything beyond the horizon in one event, exactly as the mask did, and ignores `context.workingSet.target`; the replay tables show this as `saturated events = 1.000` on every row. That is deliberate: the policy exists to reproduce the old selection through the ledger, and an operator who wants batching to a target wants `structural-v1`. Candidates arrive newest-safe-first, so a caller that stops early has evicted the newest safe unit rather than the oldest one.

Age is not a quality signal. A file read twenty turns ago and never touched since is more useful than a directory listing from two turns ago, which is the whole reason `structural-v1` exists and is the default.

### `structural-v1` (default)

Rule order is the policy. Each rung emits candidates newest-first, every candidate passes `isProtected`, and no unit is claimed twice, so a read that is both stale and superseded is evicted for the reason that came first and carries the `by` ref that explains it. The rungs, in order:

| # | Reason | Fires when |
| --- | --- | --- |
| 1 | `stale_after_mutation` | A read-class observation is followed by a write or edit of the same file. Whatever the body said is now a claim about a file that no longer exists in that form. |
| 2 | `superseded_read` | A later successful read of the same file covers this one's lines. A full read covers everything; any other read covers only an identical or containing range, and an unknown range covers nothing. |
| 3 | `failure_resolved` | A later call succeeded with byte-identical arguments, or, for `read`, `grep`, and `find`, reached the same file by any route. |
| 4 | `listing_consumed` | Every path the listing surfaced went on to be read. One surfaced path still unread and the listing stays, because that is the path the agent comes back to. |
| 5 | `thinking_turn_closed` | An assistant message beyond the protection horizon carries thinking blocks. |
| 6 | `age_horizon` | Only under pressure, and only until the projection reaches `target`. |

Rungs 1 through 5 are unconditional: redundant content is free to drop, whatever the pressure. Rung 6 is the only one that looks at token counts, and it stops the moment the projected size reaches `context.workingSet.target × contextWindow`. Newest-first within a rung is a cost decision: evicting the youngest safe unit keeps the cold region after the eviction point small, so the turn that pays for the event pays least.

The long-trace sweep found that targets 0.4 and an exhaustive rung 6 produced identical results because the usable candidate pool ran out first. Relative to the 0.6 default, 0.4 reduced cold-prefix tokens by 6.1% at 64k and 6.2% at 128k, did not materially reduce summaries, and lowered retention covered by 0.00354 at 128k. The default therefore remains 0.6. The replay README records the full grid and the numeric reopening rule.

The facts the rungs read come from `path-index.ts`, one deterministic pass over the active-path entries producing one observation per tool result that names a path: which file, which line range, which paths a listing surfaced, whether the call failed, and where in the turn sequence it sits. Tools that observe no path (dispatch, web fetch, tasks, ask user, context) produce no observation. There are no content fingerprints.

## Recall

Recall is explicit and by ref. There is no auto-readmission: the marker tells the model exactly which call brings the body back, and the model decides.

`resolveRecall(entries, view, ref, activeLeafTurnId)` resolves a ref against the fold at the live leaf and returns the original body byte-exact, read with the same field precedence the projection would have used. It fails in three typed ways, and each message names the nearest valid ref when one exists:

- `invalid_ref` when the ref is empty or carries whitespace.
- `not_on_active_path` when the session has no such turn on this branch, which includes a ref from a branch `/tree` abandoned.
- `not_evicted` when the unit is still in context. An assistant turn reports separately that thinking is not recallable.

Both messages end with the refs that can be recalled on the active path (tool results only, up to eight, then a count), because a failed recall is usually a mistyped ref and the listing is what the next call needs.

An LLM summary also preserves recall discovery across its cut. When an evicted tool result falls before `firstKeptTurnId`, the generated checkpoint carries a `<recallable-refs>` block with the same `ref (tool path)` rows used by recall failures, bounded to eight rows plus a remaining count. Results that stay after the cut keep their ordinary markers and are not repeated in the block.

**A recall does not un-evict.** The key stays in `view.evicted`, the marker stays byte-identical at its original position, and the recalled body arrives at the tail of the working set inside the recall result. Readmitting it in place would duplicate the bytes and invalidate the provider prefix cache for everything after that point, which costs more than the recall saved.

That also makes recall the churn signal. `churn = recalls / itemsEvicted` over the active path. A high churn number means the policy keeps evicting content the session still needs, which is a reason to change the policy rather than to raise the threshold.

The procedural replay does not synthesize churn from path reuse. Its reference graph maps each earlier observation to every later reread or discovery of the same path, while a real `contextRecall` is an explicit model choice of one ref. A later reread already returns current content at the tail, so also injecting the old body would duplicate data and misread stale or superseded observations as recall demand. Replay reports `recallTokens` as a one-time demand bound per evicted item and waits for explicit `contextRecall` records before reporting recall count, churn, or tail growth. The graph-density measurements and reopening condition are in the replay README.

An offloaded result returns its pointer, never the file. The model gets the same `full: <path>` promise the original tool result ended with and reads it with `read` when it wants it.

The two entry points differ in where the body lands:

| Caller | Entry point | Where the body goes | Ledger record |
| --- | --- | --- | --- |
| Model | `context(scope="recall", ref=...)` | Back into the working set through the normal observation envelope, so the per-turn pool and the self cap still apply | `contextRecall` with `trigger: "tool"` and the `toolCallId` |
| Operator | `/context recall <ref>` | The transcript only. It is never submitted as a turn and never counted against the context window | `contextRecall` with `trigger: "operator"` |

Both publish `BusChannels.ContextRecalled`, and both route through the middleware `on_compaction` hook as stage `working_set_recall`.

## Settings

```yaml
context:
  workingSet:
    enabled: true
    policy: structural-v1
    target: 0.6
    protectLastTurns: 6
    minEvictableTokens: 200
```

| Key | Default | Accepted | Meaning |
| --- | --- | --- | --- |
| `context.workingSet.enabled` | `true` | boolean | Master switch. `false` skips eviction and goes straight to summary compaction. It does not restore the destructive mask. |
| `context.workingSet.policy` | `structural-v1` | `age-horizon`, `structural-v1` | Candidate selection rule set. |
| `context.workingSet.target` | `0.6` | number greater than 0 and less than 1 | Used-over-window ratio an applied `structural-v1` event batches down to. `age-horizon` ignores it. |
| `context.workingSet.protectLastTurns` | `6` | integer ≥ 1 | Recent turns whose observations and thinking are never evicted. |
| `context.workingSet.minEvictableTokens` | `200` | integer ≥ 0 | Results below this body estimate are never evicted. The default protects low-yield bodies; marker break-even is enforced separately. |

`compaction.excludeLastTurns` governs only the temporary legacy mask path; working-set protection uses `protectLastTurns`. Settings validation is strict, so an unknown key under this block fails startup with its exact path.

`CLIO_CODER_LEGACY_MASK=1` restores the destructive stale-observation stage for one release as a compatibility escape hatch. It rewrites the ledger, and it is removed in the next release.

## What the operator sees

- **`/context` overlay.** A working-set section under the category legend: the policy that produced the most recent event, evicted item count, evicted tokens, event count, recall count, and churn. Evicted tokens render as one line after the legend rather than as a meter category, because they are outside the window rather than a slice of it.
- **Transcript.** An evicted tool row keeps its full body and gains a dim `evicted · <reason>` tag. The transcript shows the ledger, never the projection, so `/resume`, `/tree`, `/fork`, and the HTML export are unaffected by eviction.
- **`/context recall <ref>`.** Prints the ref, why it was evicted, the token count, and the offload pointer when there is one, followed by the original body. Transcript only.
- **Prompt cache line.** Every applied event stamps `working_set_evict` on the next assistant entry's `promptCache.expectedColdReasons`. When the last settled run came back cold for that reason, the overlay adds `last cold turn: working-set eviction (expected)` and drops the shell-reused-but-backend-cold warning, because the cold turn is explained rather than surprising.
- **Notice.** One line per applied event: `[context engine] working set: N items evicted by <policy>; ~X -> ~Y tokens, recall by ref with context(scope="recall")`. The numbers are the plan's, priced over the visible ledger slice, and they are the same numbers the `contextEviction` entry, the `[Compaction] Reclaimed context` toast, and the overlay's `last compaction` line carry. The footer meter is a separate live estimate over the agent message list and can differ from them by the tool schemas and replay text it includes.

## Not in this release

These are tracked follow-ups, not available behavior:

- **Auto-readmission.** Nothing brings an evicted body back on its own. There are no path fingerprints and no registry of what the model is likely to need next.
- **Cost model and deferred scheduling.** Pressure is the only trigger. There is no break-even horizon, no deferred eviction plan, and no piggybacking beyond the fact that the working-set stage already runs first inside `runAutoCompact`.
- **Intra-turn eviction.** Eviction runs before a request is sent. A single turn whose tool results overflow the window is handled by the observation envelope's caps and by summary compaction, not by this layer.
- **Worker runtimes.** Dispatched workers replay their own ledgers without the working-set stage.
- **Digests.** A marker carries tool, size, and a first-line preview. The generated summaries from #165 are not embedded in it.

## See also

- `clio-coder context replay --sessions <path>...` replays Clio ledgers, and `--synthetic <ids>` replays the seeded procedural corpora, through the same fold, projection, and policy code with `none`, `random`, and `oracle` controls; `clio-coder context working-set --session <id|path>` prints one session's fold and path index. Both are described under [Working-set replay](commands-and-modes.md#working-set-replay), and the committed tables with the default-policy rule are under `benchmarks/results/context-replay/`.
- [context-engine.md](context-engine.md) for context window resolution, token accounting, and how this stage sits ahead of summary compaction.
- [session-lifecycle.md](session-lifecycle.md) for the ledger format, active-path lineage, and branching.
- [glossary.md](glossary.md) for the one-line definitions of these terms.
