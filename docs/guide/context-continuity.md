# Context continuity and recovery

`compact` in [compact.ts](../../src/domains/session/compaction/compact.ts) implements summary handoff. The [context engine](../architecture/context-engine.md#single-threshold-compaction) explains the budget and trigger.

Clio Coder can reduce a long native session while preserving the assistant's exact handoff note and the original task. Open `/context` to inspect the next request's input, output reservation, headroom, and pending handoff. The model can read the same accounting with `context(scope="budget")`.

## Choosing a reduction

| Action | Use it for |
| --- | --- |
| Automatic compaction | Routine pressure management under `context.compaction.threshold`. Pauses after 3 consecutive failures, see [Automatic compaction and its failure pause](#automatic-compaction-and-its-failure-pause). |
| `/context compact [instructions]` (or `/compact`) | An operator-directed summary, optionally focused on specific information. It skips working-set eviction and always summarizes. |
| `self_compact({"note_to_self":"…"})` | An assistant-directed handoff followed by continuation of the same task. |
| `/context recover <handoffId> <reduce\|deliver>` | Explicit recovery of an interrupted handoff. |
| Server overflow recovery | Runs by itself when a provider rejects a request for exceeding its window: one compact-and-retry. |

`self_compact` is available to the native orchestrator. Dispatched workers do not receive its host callback, and external agents that own their own loop do not receive its schema through the native session tool surface. Skill restrictions and normal tool permission checks still apply.

The assistant must call `self_compact` alone. A batch containing it and another tool, or two self-compaction calls, is rejected before any valid sibling executes. The note should preserve the objective, decisions, useful evidence, relevant paths, unresolved questions, and next steps. It must be nonblank and no larger than 8,192 UTF-8 bytes. Clio Coder preserves the accepted text exactly and labels it as assistant-authored recall, rather than presenting it as an operator instruction.

## Automatic compaction and its failure pause

Automatic reduction runs before an operator message is submitted and at settled tool-batch boundaries before each continuation request. It fires when the next request crosses `context.compaction.threshold` (default 0.8) of the effective window and `context.compaction.auto` is `true` (default). A threshold of 0 never fires, and an unknown window never fires. Working-set eviction runs first. The summary runs when eviction frees too little or finds nothing evictable. See [Single-threshold compaction](../architecture/context-engine.md#single-threshold-compaction) for the order and the rearm band.

A summary request can fail: a provider error, an unavailable `context.compaction.model` target, an invalid `context.compaction.model` reference, or an unreadable `context.compaction.systemPrompt` file. Each failure raises a `compaction failed: <reason>` context-activity event. Before a submit the operator also sees `[Clio Coder] auto-compaction failed: <reason>` and the turn proceeds. At a tool-batch boundary the continuation stops with `[Clio Coder] post-tool context guard could not compact before continuation: <reason>`. The turn context (`src/session-control/turn-context.ts`) counts consecutive automatic failures. When the count reaches 3 the operator sees one more notice:

```text
automatic compaction paused after 3 consecutive failures; run /compact to retry
```

What the pause does and does not stop:

- **Paused:** the whole automatic path, working-set eviction included. Settled tool batches do not re-attempt a summarizer that fails deterministically, such as a summary request too large for its window or a broken route. No further notices follow the first one, and the `/context` overlay line `autocompact at 80% (auto)` does not change.
- **Still runs:** `/compact` and `/context compact`, overflow recovery after a server rejection, the forced fit reduction that runs when the estimated input plus output reservation exceeds the window, and `self_compact` reduction. These are forced runs. A failure in a forced run neither counts toward the 3 nor extends the pause.
- **Clears the pause:** any successful summary compaction, forced or automatic, and any session change in the same process (`/new`, `/resume`, `/fork`, `/tree`, `/handoff`). The count lives in process memory, so a restart also clears it.
- **Does not count:** a short session with nothing older to summarize, and a discarded no-gain checkpoint.

## `/compact` instructions

`/compact <text>` and `/context compact <text>` pass the text to the summarizer twice.

1. **Binding block.** The summarizer's user message ends with the text inside `<operator-instructions>…</operator-instructions>`, followed by a sentence stating that the operator wrote the instructions for this checkpoint, that they override the default scope above, and that every fact, value and decision they name must be kept even when the conversation does not show it. Both the full-history prompt and the split-turn prompt carry the block.
2. **Verbatim operator note.** The same text, prefixed `/compact: `, joins the operator notes described in [What a compaction leaves behind](#what-a-compaction-leaves-behind). A summarizer that ignores the block therefore cannot lose the instruction, and later compactions carry it forward.

The block holds the full instruction text. The operator note, prefix included, is cut at 400 characters. A `/compact` with no text adds neither. Source: `buildOperatorInstructions` and `extractOperatorNotes` in [compact.ts](../../src/domains/session/compaction/compact.ts).

## What a compaction leaves behind

An automatic compaction and `/context compact` each emit one canonical compaction notice and leave a persistent row in the transcript, for example `[context engine] compacted 36.2K → 28.6K tokens; 42 messages summarized to 1823 chars`. A cut that lands mid-turn appends ` (split turn)`. Later notices do not replace it. The two figures are the ones the footer shows: the whole next request, with the system prompt, tool schemas, summary and retained suffix, not the summary alone. After `/resume` the stored summary renders as `[compaction summary] compacted 36.2K → 28.6K tokens, cont. at turn <id>`, with ` via <trigger>` appended where the entry recorded `auto`, `force` or `overflow`. A summary stored before the after figure was recorded shows `~<tokens> tokens before` instead.

Other outcomes have their own notices:

| Outcome | Notice |
| --- | --- |
| Working-set eviction applied | `[context engine] working set: N items evicted by <policy>; ~X -> ~Y tokens, recall by ref with context(scope="recall")` |
| Eviction considered and declined before a summary | `[context engine] working set: nothing evictable …; llm_summary runs instead`, or the same line naming `context.workingSet.enabled false` |
| Checkpoint would not shrink the context | `compaction would not reduce context; checkpoint discarded (usage recorded)`. The paid summary call stays in the usage totals. |
| Nothing older to summarize | `[/context compact] too short to compact (<used> of <window> tokens used); no older history can be summarized yet`, or `session is empty; start a conversation first` |
| Server rejected the request | `Server rejected this request for exceeding its context window; compacting and retrying once.` With an unknown window the notice adds that the serving limit is unknown. |

The summarizer writes a fixed checkpoint shape: Goal, Constraints & Preferences, Progress (Done, In Progress, Blocked), Key Decisions, Next Steps, Critical Context. A cut never separates a tool result from its call, and the suffix after the cut keeps at least 20,000 estimated tokens of recent context (less when the request budget is tight). The summary output is capped at 8,192 tokens. A previous checkpoint and its retained suffix enter the next summarizer call as `<previous-context>`, so each compaction produces one cumulative replacement. The summarizer's system prompt is built in; `context.compaction.systemPrompt` replaces it with the text of a UTF-8 file of at most 64 KiB, resolved against the session workspace when the path is relative.

Sentences in which you asked Clio Coder to remember something (starting `remember`, `keep in mind` or `don't forget`, optionally after `please`) are copied verbatim into an `<operator-notes encoding="xml">` block beside the generated summary, and the summarizer is told to keep every literal you stated. Each note is cut at 400 characters, the newest 30 are kept across later compactions, and `&`, `<` and `>` are escaped so a note cannot close the block. A model that declined to store a value as memory therefore does not lose it to a summary. The summary also lists the files read and modified in the summarized span, and a bounded `<recallable-refs>` preview of tool results the cut hid (see [Working Set](../architecture/context-working-set.md#recall)).

The summarizer runs on the chat route unless `context.compaction.model` names a `target/model` reference that matches exactly one configured model. It always runs with thinking off, passes the session's information-flow admission, and waits for paid-request admission when its cost is known or estimated. The summary and its usage stay attributed to the executing target and model.

## Route sources survive compaction

A session-only route, such as a model chosen for one session, lives in process memory and in no settings file. A compaction summary cannot be trusted to remember it. The attended prompt therefore recomputes route provenance on every compile instead of reading it from history. Its Runtime block carries one line:

```text
Routes: chat session, memory user, compaction =chat, fleet project.
```

The four routes are `chat`, `memory`, `compaction` and `fleet`. Each source is `session` (applied to this session only and not saved), `user` (saved user settings), `project` (this workspace's `.clio-coder` settings), `built-in` (default), or `=chat` (unset, follows the chat route). `context(scope="settings")` reports the same `source` on `routing.chat`, `routing.memory`, `routing.compaction` and `routing.fleetDefault`, plus a `saved` block with the saved route whenever a session override hides one. `fleetDefault` is the worker route and is never the saved chat route. Headless runs carry no route line. Source: `src/core/route-provenance.ts`.

## What the receipt means

The tool's first receipt means that the note was prepared and flushed to the session ledger. Reduction happens after that receipt has been persisted. Clio Coder records the reduction attempt before invoking the summarizer, checkpoints the outcome, and records delivery intent before allowing another foreground request.

A final, nonempty, successful assistant response acknowledges that delivery. Intermediate tool calls, empty responses, errors, cancellation, and a generic end-of-run event do not acknowledge it. Continuation does not append another operator turn or create a fresh durable-memory selection attempt.

Each handoff allows at most two reduction attempts, with at most two summary calls per attempt and four summary stream invocations in total. The automatic window is bounded to 15 minutes (`HANDOFF_MAX_WINDOW_MS`). A new operator recovery request may renew that window, but does not refund spent attempts or mint a replacement handoff identity. Summarizer calls, including failed calls with known usage, remain attributable to their originating session.

### Handoff phases

`handoffTransaction` entries record these phases. The `/context` overlay shows `Handoff: pending` (or the last outcome) with the pending ID and the recovery command.

| Phase | Meaning |
| --- | --- |
| `prepared` | The exact note is accepted and flushed to the ledger. |
| `reducing` | A reduction attempt is running. |
| `ready` | A validated `continuityCommit` exists with outcome `summarized`, `evicted` or `continuity_only`. |
| `delivered` | The continuation request has been sent. |
| `acknowledged` | A final, nonempty, successful assistant response came back. |
| `paused` | Operator cancel (`operator_cancelled`), a changed origin (`origin_changed`), or an uncertain delivery (`delivery_uncertain`). Accepts operator recovery. |
| `failed` | `invalid_note`, `note_exceeds_replay_budget`, `budget_unsafe_no_material`, `durability_unresolved`, `state_root_removed`, `origin_changed`, `provider_failed`, `attempts_exhausted` or `deadline_exceeded`. Accepts operator recovery. |
| `resumed` | The operator command recorded authority to continue. |

Source: `src/session-control/continuity-controller.ts` owns the live transaction. `src/domains/session/continuity/` holds the record shapes, fold and validation.

## Recovering an interrupted handoff

The `/context` overlay shows the pending handoff ID with the recovery command. Use the exact ID:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

`reduce` is available when the handoff has not committed and an attempt remains. `deliver` is available when a validated commit exists. Only a `paused` or `failed` handoff accepts recovery. A restarted process first records the interrupted state as paused; it does not automatically repeat an uncertain delivery. Recovery authority comes from the operator command and its durable control record, never from a tool argument or text found in a note.

If the continuation still cannot fit, use `/context compact` to reduce more history before trying delivery again. Missing or conflicting storage evidence can prevent recovery. Clio Coder retains uncertainty instead of silently creating a new transaction. A missing commit can be reconstructed only from a validated summary carry, using its original reserved identity and an exact storage check.

Session forks inherit notes as recall only. They do not inherit permission to resume the parent's handoff, and a fork drops handoff records, recovery requests and compaction summaries written after its fork point. Ordinary summaries persist in the session ledger and replay after `/resume`. To move work to another session or agent, `/handoff <goal>` mints a successor session (see [Session lifecycle](../architecture/session-lifecycle.md#handoff-with-handoff)), and task-memory handoff exports live under `.clio-coder/handoffs/` (see [Proactive memory](proactive-memory.md)).

## Request budgets and memory

Submission and native continuation require estimated input plus the resolved output reservation to fit the effective window. Pending user-message framing and images count. A final check inspects the actual request after steering has been drained. Ordinary automatic-compaction preferences remain separate from this hard admission check: disabling automatic compaction, or pausing it after failures, cannot authorize an oversized request. A request that does not fit forces a reduction (working-set eviction down to fit, then a summary) even while automatic compaction is off or paused. When the reduction cannot make it fit, Clio Coder refuses the request with `Request exceeds the available context window (input N + output M, window W)` and runs nothing. `CLIO_CODER_FORCE_COMPACT=1` forces the summary before every interactive turn, see [Environment variables](environment-variables.md). Tool output has its own per-turn byte budget that scales with the window, described under [Tool output accounting](../architecture/context-engine.md#tool-output-accounting).

Successful durable reductions invalidate older private-memory content jobs and queued memory reminders. Their known usage still counts. Restoration retains the private bank, selects a bounded set of remembered facts and procedures, and suppresses stale private status when an authoritative summary or handoff is available. The full reminder wrapper must fit, and restoration is consumed only after installation in an admitted context. Independent verification retains its own evidence and review records.

Approved durable-memory selection is frozen for a prepared turn and its continuations. Changes in session, repository, runtime, model, or memory configuration invalidate that authority. A subsequent turn reads the current bounded store contents; a same-size rewrite cannot hide behind a file-size cache key. Default selection limits remain five records and 400 tokens. Experimental lexical ranking is not enabled by default.

Request admission combines provider token observations with estimates for unmeasured content. Ledger flushes and checkpoints record local persistence; remote delivery recovery uses the stored handoff phase and requires the explicit operator command described above.
