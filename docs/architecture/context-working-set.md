# Working Set

The working set is the part of the session ledger the model actually receives on the next request. When context pressure crosses `context.compaction.threshold`, Clio narrows that view before it considers summarizing anything: selected tool-result bodies and closed-turn thinking blocks stop being replayed, and a one-line marker takes each body's place. Nothing is deleted. The ledger keeps every byte the tools produced, the transcript keeps showing them, and the model can ask for any evicted body back by ref.

Source of truth is `src/domains/context/working-set/` (`contract.ts`, `fold.ts`, `project.ts`, `marker.ts`, `protect.ts`, `engine.ts`, `recall.ts`, `policies/`), the ledger records in [entries.ts](../../src/domains/session/entries.ts), and the compaction stage in [turn-context.ts](../../src/interactive/turn-context.ts) (`runAutoCompact`).

> [!WARNING]
> This is an experimental community alpha surface. The default policy is `structural-v2`; `structural-v1` remains available as the previous composition, and `age-horizon` preserves the old age-based selection except for the current low-yield token floor and stays available.

## Vocabulary

| Term | Definition |
| --- | --- |
| Working set | What the model sees on the next request: the ledger with the current projection applied. It is never a file. |
| Ledger | The durable append-only session record (`current.jsonl`). The working-set layer appends to it and never rewrites it. |
| Evicted | A unit whose body the projection replaces with a marker. The ledger entry that holds the original body is untouched. |
| Offloaded | A result the observation envelope already wrote to a file because it exceeded the per-call cap. Its marker carries the pointer instead of a preview, and recall returns the pointer rather than inlining the file. |
| Recall | Readmitting an evicted or summarized tool-result body by ref, through `context(scope="recall", ref=...)` for the model or `/context recall <ref>` for the operator. |
| Marker | The byte-stable one-line stub the projection renders in place of an evicted body. It names the ref, the reason, the size, and the exact call that brings the body back. |
| Projection | A pure, in-memory transform from ledger entries to the entries the replay builder hands the model. `projectWorkingSet(entries, view)` is that function. |

## Eviction is a projection, not a rewrite

The stage this layer replaces rewrote history. `maskStaleObservations` walked the entries, replaced observation bodies with a masked-out string, and called `session.replaceEntries`. That destroyed the only copy: after a mask, `/resume`, `/tree`, `/fork`, and the HTML export all showed the placeholder, and the content was gone for the operator as well as the model.

The working-set layer separates the two audiences. What leaves is recorded as a `contextEviction` entry, appended like any other. `refreshAgentMessagesFromSession` folds those entries into a `WorkingSetView` and applies `projectWorkingSet` before `buildReplayAgentMessagesFromTurns` runs, so only the messages bound for the provider carry markers. Every reader that shows the session to a human reads the raw ledger and sees the full bodies.

Three properties follow from that shape:

- **Idempotence.** Projecting an already-projected slice reproduces it byte for byte, because the marker comes from the ledger entry rather than from the body being replaced.
- **Branch safety.** The fold runs through `filterEntriesToActivePath` (issue #94), so an eviction recorded on a branch `/tree` later abandoned cannot project onto the live one, and a fork inherits the view of its shared prefix.
- **Determinism.** A policy is a pure function of `PolicyInput`. The same ledger and the same settings select the same units in a live session and in an offline replay of that session.

Usage anchors recorded before an eviction described a longer prompt than the model will now receive, so the projection stamps `contextUsageInvalidated` on assistant entries that precede the newest eviction event. Without that, `calculateContextTokens` would keep reporting the pre-eviction size and the pressure estimator would never see the space the event freed. The stamp is replay bookkeeping, not provider-visible message content, and the prompt estimator deliberately excludes it. That keeps plan-time `tokensAfter` and the post-event cold-prefix metric on the same byte definition.

## Ledger records and format v6

Two entry kinds carry the layer, both defined in [entries.ts](../../src/domains/session/entries.ts):

| Kind | Fields | Meaning |
| --- | --- | --- |
| `contextEviction` | `policyId`, `trigger` (`pressure` or `operator`), `evicted[]`, `tokensBefore`, `tokensAfter`, `pressureBefore`, `snapshotIdBefore` | One applied event. Each `evicted[]` item is `{ ref, reason, tokensFreed, marker, alias?, by?, contentHash? }`. |
| `contextRecall` | `ref`, `trigger` (`tool`, `operator`, or `reread`), `tokensReadmitted`, `toolCallId?` | One readmission of one ref. It is a churn record, not an un-eviction. |

`reason` is one of `superseded_read`, `stale_after_mutation`, `listing_consumed`, `failure_resolved`, `superseded_call`, `search_narrowed`, `diff_applied`, `offloaded_body`, `dispatch_receipt_settled`, `thinking_turn_closed`, `age_horizon`, `operator`. A `ref` is the `turnId` of the ledger entry that holds the unit: for a `tool_result` message the unit is the result body, and for an `assistant` message it is every thinking block the message carries. Per-block eviction is deliberately not modelled.

Session format is version 6 (`CURRENT_SESSION_FORMAT_VERSION = 6` in [session.ts](../../src/engine/session.ts)). Version 5 introduced short recall aliases; version 6 adds the new eviction reasons, the `reread` trigger and optional SHA-256 `contentHash`. Older supported ledgers, including formats 4 and 5, remain readable and are restamped on opening. A reader supporting only format 5 refuses a ledger written by this build; the change is one-way. Legacy eviction items without a hash remain valid but cannot match automatic rereads.

## Pressure checkpoints and rearm band

The live adapter checks pressure before an operator submission and at settled tool-batch boundaries before the next model request. It appends eviction records and refreshes the projection outside the streaming step. It does not install a `transformContext` hook. Replay recognizes the corresponding ledger checkpoints through `isPressureCheckpointBefore` in [checkpoint.ts](../../src/domains/context/working-set/checkpoint.ts).

After an eviction, automatic reduction waits until projected working-set tokens have grown by `context.workingSet.rearmFraction × contextWindow` beyond that event's `tokensAfter`. The default fraction is 0.1; zero disables the band. The wait covers both another eviction and summary compaction. A subsequent summary resets the baseline. Overflow recovery bypasses the band, and request-fit admission remains the safety check.

The rearm band and policy headroom arithmetic use projected visible-ledger tokens in both live execution and replay. The live threshold and request-fit checks still include the full prompt, tool schemas and output reserve. Replay models overflow at a configurable fraction of the budget (0.95 by default); its summary and cache costs are estimates, not provider measurements.

## The marker contract

A marker is one line, its fields are in fixed order, and it carries no timestamp and no counter. That is not cosmetic. The marker is persisted inside the `contextEviction` entry and replayed on every subsequent request, so a marker whose bytes drifted between renders would cold-start the provider prefix cache on a turn that evicted nothing new. It would also make two replays of the same recorded ledger disagree.

Field order is `ref`, `reason`, `by`, `tool`, `path`, `size`, `offload`, `recall`, then the body tail. Undefined fields are omitted rather than rendered empty. `path` is the one file the result was about: `details.paths` when the tool recorded exactly one (`edit`, `write`, `artifact`), otherwise the `path` argument of the call as the model wrote it, which is how a `read` marker names its file. Real output from `renderMarker` in [marker.ts](../../src/domains/context/working-set/marker.ts):

```text
[evicted ref=0198f3c2-7a10-7c31-9d44-2b0c5f1e88a3 reason=stale_after_mutation by=0198f3c2-9b02-7f55-8e10-6d21ac9e4471 tool=read path=src/domains/context/working-set/engine.ts size=41 lines/3.8KB recall=context(scope="recall", ref="0198f3c2-7a10-7c31-9d44-2b0c5f1e88a3") preview="export function planEviction(policy: WorkingSetPolicy, input: PolicyInput): EvictionPlan | null { export function planEv"]
```

```text
[evicted ref=0198f3c2-1d44-7a90-b201-77c0e1a2f5de reason=failure_resolved by=0198f3c3-0002-7ab1-9c33-14ff90bb2c07 tool=bash size=4 lines/152B recall=context(scope="recall", ref="0198f3c2-1d44-7a90-b201-77c0e1a2f5de") first_line="src/interactive/turn-context.ts(466,15): error TS2345: Argument of type 'PolicyInput' is not assignable to parameter of "]
```

```text
[evicted ref=0198f3c4-55aa-7be2-8f01-9a3d6c2b1e77 reason=listing_consumed tool=grep size=1 lines/234.4KB offload=/home/dev/.local/state/clio-coder/offload/0198f3c4-grep.txt recall=context(scope="recall", ref="0198f3c4-55aa-7be2-8f01-9a3d6c2b1e77")]
```

Three rules govern the tail. Most reasons render `preview`: the first 120 characters of the body, whitespace collapsed and double quotes escaped, so the preview cannot break the quoted field or spill onto a second line. A `failure_resolved` or `dispatch_receipt_settled` eviction renders `first_line` instead, because the line that says what failed is worth the marker's tokens where a preview of a stack trace is not. An offloaded body renders neither, because the `offload=` pointer already promises the full artifact at a stable path and a preview would spend tokens repeating it.

Thinking eviction renders no marker at all. The reasoning simply stops being replayed. A marker there would spend tokens announcing that something the model cannot act on is gone.

## Policies

A policy answers one question: which units should leave. It never writes, never reads a clock, and never calls a model. `planEviction` then materializes the selection into `EvictedItem`s with markers rendered and tokens measured, and prices the result against the projection the model will actually receive.

### Protection predicates

`protect.ts` runs before every rule in the composed structural policies and is absolute. A policy is allowed to be wrong about relevance; it is not allowed to drop these:

1. Anything that is not a `tool_result` or `assistant` message. Operator words, compaction and branch summaries, skill activations, task ledgers, worker runs, and bash executions are the session's record of itself.
2. Anything inside the recent window, which starts at `protectionCutoffIndex(entries, settings)`. The later cutoff of the last `protectLastTurns` turns and last `protectLastSteps` assistant steps wins. A turn starts at a user message, a `bashExecution`, or a `branchSummary`. At least the newest assistant step stays protected, including provider-required thinking.
3. A result whose estimated body is below `minEvictableTokens`. This protects low-yield bodies from churn; the engine independently rejects a marker that would free no tokens.
4. A body the legacy destructive stage already replaced, which has nothing left to evict.
5. A call the safety rails blocked. A refused call is a decision the session made, not an observation it can re-fetch.
6. A write or edit the turn in flight is still standing on.
7. A failure nothing later resolved, and any unindexed failure, because without an observation there is no way to ask whether it was resolved.
8. A gateway chain aggregate with any member that items 5 to 7 would keep as a standalone result of its capability: a refused step, a write or edit the turn in flight stands on, or an unresolved or unindexed failure. A failed step with no member, such as a step whose `$from` binding failed and never ran, is an unindexed failure and keeps the aggregate. The floor, pins and recent window apply to the aggregate, which is the unit a marker replaces. Eviction addresses whole persisted results, so an aggregate otherwise leaves as one unit, and only after every settled member has earned a rung reason. A member with no path observation earns one only from a whole-entry rung such as `age_horizon`. The aggregate carries its weakest member's reason, the latest rung in the policy's order, and its marker and recall address the whole aggregate body.

### `age-horizon`

Outside the protected horizon, `age-horizon` evicts eligible tool-result bodies
at or above `minEvictableTokens` and removes assistant thinking blocks. Bodies
containing legacy compaction markers are skipped. Thinking blocks have no size
floor because their removal adds no marker.

The policy evicts all eligible candidates in one event and ignores
`context.workingSet.target`. Candidates arrive newest-safe-first. Structural
policies add relevance rules and stop their pressure-driven age rung at a target
size.

### `structural-v2` (default) and `structural-v1`

Rule order is the policy. Each rung emits candidates newest-first, every candidate passes `isProtected`, and no unit is claimed twice, so a read that is both stale and superseded is evicted for the reason that came first and carries the `by` ref that explains it. The rungs, in order:

| # | Reason | Fires when |
| --- | --- | --- |
| 1 | `stale_after_mutation` | A read-class observation is followed by a write or edit of the same file. Whatever the body said is now a claim about a file that no longer exists in that form. |
| 2 | `superseded_read` | A later successful read of the same file covers this one's lines. A full read covers everything; any other read covers only an identical or containing range, and an unknown range covers nothing. |
| 3 | `failure_resolved` | A later call succeeded with byte-identical arguments, or, for `read`, `grep`, and `find`, reached the same file by any route. |
| 4 | `superseded_call` | A later run of the same tool has byte-identical arguments, even if it fails again. |
| 5 | `listing_consumed` | Every path the listing surfaced went on to be read. |
| 6 | `offloaded_body` | The full body already lives at an offload path; its excerpt is redundant beyond the protection horizon. |
| 7 | `thinking_turn_closed` | An assistant message beyond the protection horizon carries thinking blocks. |
| 8 | `age_horizon` | Only under pressure, and only until the projection reaches `target`. |

The final `recalled_twice` rung is a protection flag rather than an eviction reason. It pins a result whose body has been recalled at least twice, including successive reread copies of that body. `structural-v1` uses the same composition without `offloaded_body` and `recalled_twice`.

Rungs 1 through 7 do not test pressure themselves; the live scheduler gates the checkpoint. The age rung stops once the projected size reaches `context.workingSet.target × contextWindow`. Candidates arrive newest-safe-first within a rung to limit the cold prefix caused by an event. The composer in [compose.ts](../../src/domains/context/working-set/policies/compose.ts) owns protection, duplicate refusal, and shared headroom accounting.

Three additional rungs are available in replay outside the default composition: `search_narrowed` accepts searches whose paths were read or edited; `diff_applied` accepts mutation echoes superseded by a covering read or later mutation; `dispatch_receipt_settled` accepts receipts acknowledged by later continuity records.

The path index records tool identity, canonical paths, ranges, outcomes, and ledger position. Call arguments establish identical-call supersession. Content hashes serve reread matching rather than candidate ranking.

### Protection profiles

`context.workingSet.profile` is an operator setting for the main agent. Workers retain their separate in-memory pressure guard and have no fleet-profile binding for this layer.

| Profile | Additional protection and ordering |
| --- | --- |
| `default` | Configured step horizon and token floor; ledger age ordering. The chosen policy decides whether to pin repeated recalls. |
| `data-analysis` | Pins the latest three bash-class outputs with a line containing at least two numeric tokens. |
| `web-design` | Pins the latest successful read of each edited stylesheet or component (`.css`, `.scss`, `.tsx`, `.jsx`, `.html`, `.vue`, `.svelte`); the age rung considers bash output first. |

Profiles can override `protectLastSteps` and `minEvictableTokens`; the shipped profiles currently inherit both settings. Pins apply to composed structural policies, while `age-horizon` and replay controls retain their own selection rules.

## Recall

Exact recall by ref works for persisted tool results hidden by eviction or summary compaction. `context(scope="recall", query="...", limit=8, offset=0)` with `ref` omitted discovers eligible results in active-path ledger order. Query matches ref, tool, and path metadata; limit defaults to 8 and caps at 12. Rows include timestamps and evicted/summarized state. `nextOffset` continues the same query against the same active path and ledger state. Discovery does not append `contextRecall`.

`resolveRecall(entries, view, ref, activeLeafTurnId)` resolves against the active path and compaction cut, returning the persisted tool-result body with the same field precedence as projection. It rejects malformed refs, unknown or other-branch refs, currently visible results, assistant thinking, and legacy destructively compacted bodies. It cannot recover bytes already removed from older logs.

Errors distinguish malformed refs, off-branch refs, visible results, unavailable bodies and a path with no evicted read.

Recoverable recall error messages end with the refs that can be recalled on the active path (tool results only, up to eight, then a count). `invalid_ref` reports only the malformed value. Clio deliberately lists valid refs instead of guessing a nearest ref, because similar time-ordered identifiers can name unrelated results.

An LLM summary preserves discovery across its cut. The checkpoint carries a bounded `<recallable-refs>` preview for tool results hidden by compaction, including results that were never explicitly evicted, and points to omitted-ref discovery for the complete paginated inventory. Results after the cut retain their ordinary markers. Exact recall returns historical persisted content; reading the path again returns its current filesystem contents.

`context(scope="recall", path="src/x.ts")` resolves the newest eligible evicted read of that canonical path on the active branch. It does not match visible reads or reads already behind the summary cut; summarized bodies remain recallable by ref.

A successful text `read` also checks whether the returned body matches an evicted read of the same canonical path. Matching uses the SHA-256 of the persisted body text, never mtime. A match appends `contextRecall` with trigger `reread` and adds the immediate matched ref to `details.recall`. The read still returns and persists the body again at the tail. Changed content, images, missing hashes, no session, or a port failure leave an ordinary read. A lazy hash index avoids reparsing the ledger on misses after its initial build; eviction events and session changes invalidate it.

**A recall does not un-evict.** For explicitly evicted results, the key stays in `view.evicted` and the marker stays byte-identical. Summarized results remain behind the compaction cut. In both cases the recalled body arrives at the tail inside the recall result. Readmitting it in place would duplicate the bytes and invalidate the provider prefix cache for everything after that point, which costs more than the recall saved.

That also makes recall the churn signal. `churn = recalls / itemsEvicted` over the active path. A high churn number means the policy keeps evicting content the session still needs, which is a reason to change the policy rather than to raise the threshold.

The procedural replay retains recorded `contextRecall` events and their result provenance, but does not synthesize churn from path reuse. Its reference graph distinguishes genuine rereads from rereads after a rewrite, counts listing discovery only at the first subsequent read, and treats identical calls as coverage, while a real `contextRecall` is an explicit model choice of one ref. A later reread already returns current content at the tail, so also injecting the old body would duplicate data and misread stale or superseded observations as recall demand. Replay reports `recallTokens` as a one-time demand bound per evicted item and waits for explicit `contextRecall` records before reporting recall count, churn, or tail growth.

An offloaded result returns its pointer, never the file. The model gets the same `full: <path>` promise the original tool result ended with and reads it with `read` when it wants it.

The entry points differ in where the body lands:

| Caller | Entry point | Where the body goes | Ledger record |
| --- | --- | --- | --- |
| Model | `context(scope="recall", ref=...)` or `context(scope="recall", path=...)` | Back into the working set through the normal observation envelope, so the per-turn pool and the self cap still apply | `contextRecall` with `trigger: "tool"` and the `toolCallId` |
| Operator | `/context recall <ref>` | The transcript only. It is never submitted as a turn and never counted against the context window | `contextRecall` with `trigger: "operator"` |

An unchanged reread returns the ordinary read body with recall provenance and records trigger `reread`. All three publish `BusChannels.ContextRecalled`; the explicit tool and operator recall routes also run the middleware `on_compaction` hook as stage `working_set_recall`.

## Settings

```yaml
context:
  workingSet:
    enabled: true
    policy: structural-v2
    profile: default
    target: 0.6
    protectLastTurns: 6
    protectLastSteps: 8
    minEvictableTokens: 200
    rearmFraction: 0.1
```

| Key | Default | Accepted | Meaning |
| --- | --- | --- | --- |
| `context.workingSet.enabled` | `true` | boolean | Master switch. `false` skips eviction and goes straight to summary compaction. It does not restore the destructive mask. |
| `context.workingSet.policy` | `structural-v2` | `age-horizon`, `structural-v1`, `structural-v2` | Candidate selection rule set. |
| `context.workingSet.target` | `0.6` | number greater than 0 and less than 1 | Used-over-window ratio an applied structural event batches down to. `age-horizon` ignores it. |
| `context.workingSet.protectLastTurns` | `6` | integer ≥ 1 | Turn limit of the protected window, combined with the step limit. |
| `context.workingSet.profile` | `default` | `default`, `data-analysis`, `web-design` | Main-agent structural protection profile. |
| `context.workingSet.protectLastSteps` | `8` | integer ≥ 1 | Assistant-step limit of the protected window. |
| `context.workingSet.rearmFraction` | `0.1` | number ≥ 0 and < 1 | Required projected growth as a fraction of the window before another automatic reduction. |
| `context.workingSet.minEvictableTokens` | `200` | integer ≥ 0 | Results below this body estimate are never evicted. The default protects low-yield bodies; marker break-even is enforced separately. |

The retired `compaction.excludeLastTurns` key is not accepted by settings v2. The temporary legacy mask uses a compiled six-turn fallback; working-set protection uses `context.workingSet.protectLastTurns`. Settings validation is strict, so an unknown key under this block fails startup with its exact path.

`CLIO_CODER_LEGACY_MASK=1` enables the legacy stale-observation stage for compatibility. That stage rewrites the ledger rather than projecting a working set.

## What the operator sees

- **`/context` overlay.** A working-set section under the category legend: the configured policy with its state (`policy structural-v2 · rearm 10% · no events yet` until the first event, `disabled` when `context.workingSet.enabled` is off, and `(last event by <policy>)` when the setting changed after an event), the non-default profile (for example `profile web-design`), rearm percentage, evicted item count, evicted tokens, event count, recall count, and churn. Evicted tokens render as one line after the legend rather than as a meter category, because they are outside the window rather than a slice of it.
- **Transcript.** An evicted tool row keeps its full body and gains a dim `evicted · <reason>` tag. The transcript shows the ledger, never the projection, so `/resume`, `/tree`, `/fork`, and the HTML export are unaffected by eviction.
- **`/context recall <ref>`.** Prints the ref, its evicted or summarized state, the token count, and any offload pointer, followed by the persisted body. Transcript only.
- **Prompt cache line.** Every applied event stamps `working_set_evict` on the next assistant entry's `promptCache.expectedColdReasons`. When the last settled run came back cold for that reason, the overlay adds `last cold turn: working-set eviction (expected)` and drops the shell-reused-but-backend-cold warning, because the cold turn is explained rather than surprising.
- **Notice.** One line per applied event: `[context engine] working set: N items evicted by <policy>; ~X -> ~Y tokens, recall by ref with context(scope="recall")`. The numbers are the plan's, priced over the visible ledger slice, and they are the same numbers the `contextEviction` entry, the `[Compaction] Reclaimed context` toast, and the overlay's `last compaction` line carry. The footer meter is a separate live estimate over the agent message list and can differ from them by the tool schemas and replay text it includes.

Dispatched workers replay their own ledgers without the working-set stage.
Automatic reduction uses the pressure threshold and rearm band. Recall markers
contain tool identity, size, and a first-line preview; a reread restores current
content when requested.

## See also

- `clio-coder context replay --sessions <path>...` replays Clio ledgers, and `--synthetic <ids>` replays the seeded procedural corpora, through the same fold, projection, and policy code with `none`, `random`, and `oracle` controls; `clio-coder context working-set --session <id|path>` prints one session's fold and path index. Both are described under [Working-set replay](../guide/commands-and-modes.md#working-set-replay). Reports include per-reason items and tokens, events and checkpoints per trace, modeled cache-miss cost, and overflow reductions. With `--profile data-analysis` or `--profile web-design`, a profile section lists effective settings and pairs every policy/budget row with a default-profile run over the same loaded corpus. JSON schema `clio-coder-context-replay-v3` contains the same profile fields and baseline results. Copy a changing session corpus before comparing runs.
- [context-engine.md](context-engine.md) for context window resolution, token accounting, and how this stage sits ahead of summary compaction.
- [session-lifecycle.md](session-lifecycle.md) for the ledger format, active-path lineage, and branching.
- [glossary.md](../guide/glossary.md) for the one-line definitions of these terms.
