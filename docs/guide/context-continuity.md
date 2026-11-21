# Context continuity and recovery

`compact` in [compact.ts](../../src/domains/session/compaction/compact.ts) implements summary handoff. The [context engine](../architecture/context-engine.md#threshold-and-ceiling-compaction) explains the budget and trigger.

CLIO Coder can reduce a long native session while preserving the assistant's exact handoff note and the original task. Open `/context` to inspect the next request's input, output reservation, headroom, and pending handoff. The model can read the same accounting with `context(scope="budget")`.

## Date and clock context

The Runtime block gives the main model the operator's local date, weekday and
IANA time zone. At the start of every main turn and continuation, the
`observer.local-clock` middleware also puts the full local time (with a UTC
offset when available) in the uncached message tail. If a turn crosses the
local date boundary, the first later outer tool result is annotated once with
the new date and time; a nested gateway call does not duplicate it
([local-clock-reminder.ts](../../src/domains/middleware/local-clock-reminder.ts),
[format-time.ts](../../src/core/format-time.ts)).

This is an orientation aid, not a timer or scheduling authority. It keeps
date-sensitive ids, archives and prose on the operator's calendar. Because
the Runtime block carries the date, the system prompt changes once a day, and
a turn submitted after local midnight recompiles it. It does not rewrite prior
messages, move a deadline, or replace provider/telemetry timestamps. A resumed
session receives a new turn-start clock reminder for the current local time;
workers do not receive this main-session middleware reminder.

## Choosing a reduction

| Action | Use it for |
| --- | --- |
| Automatic compaction | Routine pressure management under `context.compaction.threshold`. Pauses after 3 consecutive failures, see [Automatic compaction and its failure pause](#automatic-compaction-and-its-failure-pause). |
| `/context compact [instructions]` (or `/compact`) | An operator-directed summary, optionally focused on specific information. It skips working-set eviction and always summarizes. |
| `self_compact({"note_to_self":"…"})` | An assistant-directed handoff followed by continuation of the same task. |
| `/context recover <handoffId> <reduce\|deliver>` | Explicit recovery of an interrupted handoff. |
| Server overflow recovery | Runs by itself when a provider rejects a request for exceeding its window: one compact-and-retry. When the operator's message is already in the session, the retry continues from it instead of sending the request a second time. |
| Superseded-result eviction | Runs by itself on routes without prompt caching: tool results a later identical read covers become recallable refs. See [Superseded tool results on uncached routes](#superseded-tool-results-on-uncached-routes). |
| Step checkpoint | Runs by itself before each step turn after the first under a prompt template's `turnPolicy: step`, on a small-tier or uncached route. No summarizer call. See [Step checkpoints](#step-checkpoints). |

`self_compact` is available to the native orchestrator. Dispatched workers do not receive its host callback, and external agents that own their own loop do not receive its schema through the native session tool surface. Skill restrictions and normal tool permission checks still apply.

The assistant must call `self_compact` alone. A batch containing it and another tool, or two self-compaction calls, is rejected before any valid sibling executes. The note should preserve the objective, decisions, useful evidence, relevant paths, unresolved questions, and next steps. It must be nonblank and no larger than 8,192 UTF-8 bytes. CLIO Coder preserves the accepted text exactly and labels it as assistant-authored recall, rather than presenting it as an operator instruction.

## When the context window fills up

As the context window fills up, CLIO Coder reduces older context to make room for the next request. Automatic compaction normally triggers at 80% of the effective window, or earlier at the `context.compaction.maxTokens` working budget (default 400,000 tokens), which caps compaction on every route: working-set eviction runs first, then summarization if needed. Open `/context` to inspect the request budget, or use `/compact <what to keep>` for a directed summary. The trigger and the context gauge price the conversation at the route's measured characters per token once the route has reported usage, and at four characters per token before that. The automatic controls and failure pause are described below.

## Automatic compaction and its failure pause

Automatic reduction runs before an operator message is submitted and at settled tool-batch boundaries before each continuation request. It fires when the next request crosses `context.compaction.threshold` (default 0.8) of the effective window and `context.compaction.auto` is `true` (default). A threshold of 0 never fires on a known window. A request that reaches `context.compaction.maxTokens` fires too, which is the only automatic trigger while the serving window is unknown. A fresh prompt with no session yet has nothing to shrink and is skipped. Working-set eviction runs first. The summary runs when eviction frees too little or finds nothing evictable. On a known window under 52,428 tokens, eviction acts at the automatic trigger itself and, at the defaults (`context.workingSet.target` 0.6 over `context.compaction.threshold` 0.8), evicts history down to three quarters of the room the trigger leaves beside the system prompt and tool schemas, so a small route evicts before it pays for a summary ([pressure.ts](../../src/domains/context/fold/pressure.ts)). `context.workingSet.enabled: false` turns eviction off; the summary then runs alone. See [Threshold and ceiling compaction](../architecture/context-engine.md#threshold-and-ceiling-compaction) for the order, the ceiling and the rearm band.

A summary request can fail: a provider error, an unavailable `context.compaction.model` target, an invalid `context.compaction.model` reference, or an unreadable `context.compaction.systemPrompt` file. Each failure raises a `compaction failed: <reason>` context-activity event. Before a submit the operator also sees a warning, `[CLIO Coder] auto-compaction failed; context at <N> tokens. <reason in words>.`, followed by how to go on, and the turn proceeds without a summary. A cancelled pre-submit compaction says `auto-compaction cancelled; context at <N> tokens` unless its card already says so. At a tool-batch boundary, a failed compaction the next request did not need leaves the run going with `[CLIO Coder] automatic compaction failed: <reason>. This turn goes on without it.`; the run stops with `[CLIO Coder] post-tool context guard could not compact before continuation: <reason>` only when the next request would not fit or the compaction was cancelled. The turn context (`src/session-control/turn-context.ts`) counts consecutive automatic failures. A summary that would not reduce context is discarded and counts as a failure too. When the count reaches 3 the operator sees one more notice:

```text
automatic compaction paused after 3 consecutive failures; run /compact to retry
```

What the pause does and does not stop:

- **Paused:** automatic summaries. Working-set eviction under pressure and superseded-result eviction cost no model call and still run. Settled tool batches do not re-attempt a summarizer that fails deterministically, such as a summary request too large for its window or a broken route. No further notices follow the first one, and the `/context` overlay line `autocompact at 80% (auto)` does not change.
- **Still runs:** `/compact` and `/context compact`, overflow recovery after a server rejection, the forced fit reduction that runs when the estimated input plus output reservation exceeds the window, and `self_compact` reduction. These are forced runs. A failure in a forced run neither counts toward the 3 nor extends the pause.
- **Clears the pause:** any successful summary compaction, forced or automatic, any session change in the same process (`/new`, `/resume`, `/fork`, `/tree`, `/handoff`), and a change of the chat route (target, runtime or model, as with `/model`) or of `context.compaction.model`. The count lives in process memory, so a restart also clears it.
- **Does not count:** a short session with nothing older to summarize.

Automatic compaction does not resend a summary request that already ended without gain. When an automatic summary would not reduce context, CLIO Coder remembers that summarizer request, and a later automatic run whose request is byte-identical on the same route makes no call and settles `no change` with the reason `same history as the last summary without gain; no call made`. Forced runs and `CLIO_CODER_FORCE_COMPACT=1` always call the summarizer. The remembered request clears on the same events that clear the pause.

After each summary, automatic compaction waits until the request has grown by a summary rearm band, the larger of 8% of the trigger window and twice the summary's size in tokens, before it summarizes again, so a session does not pay for a new summary every few hundred tokens. Forced runs and overflow recovery ignore the band, and a route change clears it. A new process, such as each headless `clio-coder run` turn, and a session change read the band from the session's latest checkpoint, so it survives a restart.

## Superseded tool results on uncached routes

On a route that does not cache prompts, resending a stale copy of a result costs full price on every request. There, each automatic or fit checkpoint first evicts tool results that a later identical call already covers: the same effective tool with the same canonical arguments, where the call only reads. Reads count when they come from a builtin read-class tool, a bash command that only reads, a typed git inspection, or an extension tool declared `readOnly` or `idempotent`. A tool that returns new state for the same arguments, such as a writing bash command or a step tool, keeps every result whole.

Eviction waits until at least 32 KiB of superseded result bytes are pending, then writes one ordinary `contextEviction` record and posts a `[context engine] superseded:` notice. Each evicted result is replaced in the request by an `[evicted ref=...]` marker, the ledger keeps the full text, and `context(scope="recall")` with that ref returns it. The stage runs below the compaction trigger and with `context.compaction.auto` off, but never on a manual `/compact`. Routes that cache prompts are untouched, whatever their model tier. A session written by an older release that stubbed such results in the outgoing request adopts those stubs once as an eviction record on an uncached route. The [context engine](../architecture/context-engine.md#superseded-stage-s0) gives the selection rules.

## Step checkpoints

A prompt template with `turnPolicy: {mode: step, stepTool}` runs one step per turn. On a small-tier route, or one that does not cache prompts, each step turn after the first starts from a step checkpoint instead of the full history: the previous step's final text, the template body, and the operator notes, file facts and recallable refs a compaction keeps. An extension's pinned context block is sent again. No summarizer call is made. After writing it CLIO Coder does what it does after a native compaction: the `on_compaction` hook fires with trigger `step`, the api 2 `compaction_end` observation reports `trigger: "step"`, the checkpoint carries the loaded skills' verified text and the continuity payload, and [memory restores](proactive-memory.md#post-compaction-restoration) into the turn's tail. A turn whose loaded skill cannot be carried keeps the full history, and so does the turn after a step turn that was cancelled, failed, or stopped by the loop guard or tool budget. Cached standard and frontier routes always keep the full history. Step-chain records are stored in session format 7; see [One step per turn](extensions-and-sharing.md#one-step-per-turn) for the template side.

## Inspect what a reduction decided

Every checkpoint that reaches a reduction stage journals one `context.fold` event naming its checkpoint (`submit`, `tool_batch`, `overflow`, `operator` or `step`), the route's tier and caching facts, and each stage it reached (`superseded`, `working_set`, `step_checkpoint`, `llm_summary` or `stop`) with its outcome (`committed`, `held`, `none` or `failed`), a reason such as `below_floor` or `rearm_band`, and the id of the record a commit wrote. After a committed summary, the `compaction.settled` record carries `headroomTokens`, the room left below the automatic trigger; a negative value means the cut stayed above it. Each dispatched request also journals a receipt of what it sent. To check a session after the fact:

```sh
clio-coder context working-set --session <id>   # the working-set fold and path index
clio-coder context working-set --verify <id>    # each attempt against its receipt; exits 1 on a mismatch
```

`--verify` reports each attempt as verified, not-verifiable (with the reason), external, or mismatch, and reconciles the fold decisions against the fold records on the ledger.

## `/compact` instructions

`/compact <text>` and `/context compact <text>` pass the text to the summarizer twice.

1. **Binding block.** The summarizer's user message ends with the text inside `<operator-instructions>…</operator-instructions>`, followed by a sentence stating that the operator wrote the instructions for this checkpoint, that they override the default scope above, and that every fact, value and decision they name must be kept even when the conversation does not show it. Both the full-history prompt and the split-turn prompt carry the block.
2. **Verbatim operator note.** The same text, prefixed `/compact: `, joins the operator notes described in [What a compaction leaves behind](#what-a-compaction-leaves-behind). A summarizer that ignores the block therefore cannot lose the instruction, and later compactions carry it forward.

The block holds the full instruction text. The operator note keeps the instruction verbatim as one note, line breaks included, up to 8,000 characters with its prefix. A `/compact` with no text adds neither. Source: `buildOperatorInstructions` in [compaction-prompts.ts](../../src/domains/memory/compaction-prompts.ts) and `extractOperatorNotes` in [compact.ts](../../src/domains/session/compaction/compact.ts).

## What a compaction leaves behind

An automatic compaction and `/context compact` each emit one canonical compaction notice and leave a persistent row in the transcript, for example `Clio compacted 36.2K → 28.6K tokens: 42 earlier messages now read as one summary` (`src/session-control/compaction-lines.ts`). A run that saved nothing adds `; the context is no smaller`. A cut that lands mid-turn appends ` (the cut fell inside a turn)`, and the summarizer is given that turn's operator message as the active request so the summary's Goal states it. Later notices do not replace it. The two figures are the ones the footer shows: the whole next request, with the system prompt, tool schemas, summary and retained suffix, not the summary alone. After `/resume` the stored summary renders as `[compaction summary] compacted 36.2K → 28.6K tokens, cont. at turn <id>`, with ` via <trigger>` appended where the entry recorded `auto`, `force`, `overflow` or `step`. A summary stored before the after figure was recorded shows `~<tokens> tokens before` instead.

The settled `Context compact` card in the transcript adds `· no summary` when the run completed without a summarizer checkpoint, so an eviction pass, whose output stays recallable, does not read like a summary (`src/interactive/context-operation-view.ts`).

A compaction that reduces nothing leaves no transcript card. Its rail above the composer settles as `Context compact · no change`, and the rail's message row leads with the measured context size before the reason, for example `141.9K tokens · nothing older than the protected skill turn to summarize`.

| Reason | Meaning |
| --- | --- |
| `summary would not reduce context (usage recorded)` | The summarizer ran and its checkpoint was discarded. |
| `same history as the last summary without gain; no call made` | An automatic run skipped the call under the repeat rule in [Automatic compaction and its failure pause](#automatic-compaction-and-its-failure-pause). |
| `nothing older than the protected skill turn to summarize` | The cut stops at the turn that loaded a skill, and nothing before that turn is left to summarize. |
| `nothing older than the protected recent window to summarize` | Everything since the last checkpoint sits inside the recent context a cut keeps. |

A summary cut never removes the turn that loaded a skill unless the checkpoint carries that skill. A skill load folded in from a dispatched worker does not hold the main session's cut. A slice that holds only bookkeeping, such as custom records, worker settlements and model changes, counts as nothing to summarize, so no summarizer call is paid for it.

Other outcomes have their own notices:

| Outcome | Notice |
| --- | --- |
| Working-set eviction applied | `[context engine] working set: N items evicted by <policy>; ~X -> ~Y tokens, recall by ref with context(scope="recall")` |
| Superseded results evicted on an uncached route | `[context engine] superseded: N results a later identical call covers evicted; ~X -> ~Y tokens, recall by ref with context(scope="recall")` |
| Eviction considered and declined before a summary | `[context engine] working set: nothing evictable …; llm_summary runs instead`, or the same line naming `context.workingSet.enabled false` |
| Checkpoint would not shrink the context | `compaction would not reduce context; checkpoint discarded (usage recorded)`. The paid summary call stays in the usage totals. |
| Nothing older to summarize | `[/context compact] too short to compact (<used> of <window> tokens used); no older history can be summarized yet`, or `session is empty; start a conversation first` |
| Server rejected the request | `Server rejected this request for exceeding its context window; compacting and retrying once.` With an unknown window the notice adds that the serving limit is unknown. |
| The summary that should clear an overflow was refused or failed | `[CLIO Coder] overflow summary failed (<reason>); the request was fitted by evicting older observations instead, without a summary.` The turn continues when eviction alone fits the request. |

The summarizer writes a fixed checkpoint shape: Goal, Constraints & Preferences, Progress (Done, In Progress, Blocked), Key Decisions, Next Steps, Critical Context. A cut never separates a tool result from its call, and the suffix after the cut keeps at least 20,000 estimated tokens of recent context. On a small window it keeps 30% of the history room below the automatic trigger instead, less whatever the current checkpoint takes past its own 30% (never under 10%), so checkpoint and suffix land near 60% of that room every cycle and the next summary waits for growth. The summary output cap is sized from the model's output limit and the share of its recent summary output that went to reasoning on that route; a route with no reported output limit gets no explicit cap. Tool results and shell output enter the summarizer request whole when it fits the summary model's window beside that output room (at most half the window), with a 20% margin on the estimate; otherwise each body is cut to the largest common length that fits, never below 2,000 characters, and a code read over that length goes in as its signatures, every function body reduced to one marker line, before any cut. When the request still does not fit, any oversized message is cut the same way to its head and tail with a note that the full text is in the session ledger, so one very large message no longer makes compaction fail; the session keeps the full text. A previous checkpoint and its retained suffix enter the next summarizer call as `<previous-context>`, so each compaction produces one cumulative replacement. When a cut splits a turn, only the history call carries that block; the split-turn call carries it only when no history call runs, so the checkpoint never holds the previous one twice. The summarizer's system prompt is built in; `context.compaction.systemPrompt` replaces it with the text of a UTF-8 file of at most 64 KiB, resolved against the session workspace when the path is relative.

Sentences in which you asked CLIO Coder to remember something (starting `remember`, `keep in mind` or `don't forget`, optionally after `please`) are copied verbatim into an `<operator-notes encoding="xml">` block beside the generated summary, and the summarizer is told to keep every literal you stated. Each note is cut at 400 characters (a `/compact` note at 8,000), the newest 30 are kept across later compactions, and `&`, `<` and `>` are escaped so a note cannot close the block. A model that declined to store a value as memory therefore does not lose it to a summary.

CLIO Coder appends an `<exact-facts source="clio">` block after the summary. The block is measured at the cut, and the summarizer never writes it. It lists each file the summarized span read or modified, modified first, as `modified <path>` or `read <path>`. The first 24 files carry `lines=<N> sha256=<12 hex>`, `bytes=<N>` for a file over 2 MiB, or `missing`, `unreadable` or `not-a-file`. A file line also ends `ref=<id>` when its newest read is hidden, and up to 8 other hidden tool results follow under `refs:`; `context(scope="recall")` with that ref returns the result's text, and without a ref lists every recallable result (see [Working Set](../architecture/context-working-set.md#recall)). A `results:` section follows with up to 8 of the newest numeric tool results: `exit=<code>`, `timed-out`, match totals and test-runner tallies, each with the call that produced it. A shell `exit=` appears only when the status speaks for the whole command, not after `;`, `||`, `&`, a newline or `set +o pipefail`. The block replaces the former `<read-files>` and `<modified-files>` lists. Later checkpoints carry its paths and results forward and measure the files again, and a copy the summarizer echoes is dropped. The summarizer is told to mark a count it worked out itself `(unverified)`. Source: [exact-facts.ts](../../src/domains/session/compaction/exact-facts.ts).

After a compaction the main session cannot `edit` a file the latest checkpoint's exact-facts block names until the model sees the file again. A read, grep, write or edit of it, a shell command naming it, or a recall of an earlier read counts. An observation the working set has since evicted does not. The refusal reads `re-read <path> before editing it: …`. Dispatched workers do not run this guard. Source: [stale-edit-guard.ts](../../src/domains/session/compaction/stale-edit-guard.ts).

With `context.memory.surfaces.observe: on`, the summarizer request can carry prepared observation notes in place of the history they cover, but only when the substituted request fits and is smaller than the ordinary one; see [Prepare observation notes for compaction](proactive-memory.md#prepare-observation-notes-for-compaction).

The summarizer runs on the chat route unless `context.compaction.model` names a `target/model` reference that matches exactly one configured model. The portable summary request runs with thinking off, passes the session's information-flow admission, and is checked against the session cost ceiling (`safety.limits.sessionCostUsd`) on every route, priced or not. A session already at its ceiling waits for a raise when attended and stops when headless, instead of summarizing past it. The summary and its usage stay attributed to the executing target and model. A summary request too large for the compaction model stops before it is sent and says to choose a larger compaction model; on Copilot, pick one with a larger prompt budget.

When the summary model is the chat model and the provider still holds the conversation in its prompt cache, CLIO Coder can ask for the summary inside that cached prefix instead. The live call resends the next turn's request unchanged plus one instruction, and keeps the turn's own thinking level so the prefix does not move. CLIO Coder takes it only when its estimated cost is below the portable request's input and it fits the window, and falls back to the portable request when it fails or returns no usable checkpoint. [Context engine](../architecture/context-engine.md#3-llm-summary-handoff-last-resort) lists the conditions.

## Route sources survive compaction

A session-only route, such as a model chosen for one session, lives in process memory and in no settings file. A compaction summary cannot be trusted to remember it. The attended prompt therefore reads route provenance from live settings state instead of from history, and it holds the result for the route identity (target, runtime and wire model) so a thinking-only change does not rewrite it. It reads the sources again after a completed compaction or a session switch. Its Runtime block carries one line:

```text
Routes: chat session, memory user, compaction =chat, fleet project.
```

The four routes are `chat`, `memory`, `compaction` and `fleet`. Each source is `session` (applied to this session only and not saved), `user` (saved user settings), `project` (this workspace's `.clio-coder` settings), `built-in` (default), or `=chat` (unset, follows the chat route). `context(scope="settings")` reports the same `source` on `routing.chat`, `routing.memory`, `routing.compaction` and `routing.fleetDefault`, plus a `saved` block with the saved route whenever a session override hides one. `fleetDefault` is the worker route and is never the saved chat route. Headless runs carry no route line. Source: `src/core/route-provenance.ts`.

## What the receipt means

The tool's first receipt means that the note was prepared and flushed to the session ledger. Reduction happens after that receipt has been persisted. CLIO Coder records the reduction attempt before invoking the summarizer, checkpoints the outcome, and records delivery intent before allowing another foreground request.

A final, nonempty, successful assistant response acknowledges that delivery. Intermediate tool calls, empty responses, errors, cancellation, and a generic end-of-run event do not acknowledge it. Continuation does not append another operator turn or create a fresh durable-memory selection attempt.

Each handoff allows at most two reduction attempts, with at most two summary calls per attempt and four summary stream invocations in total. The automatic window is bounded to 15 minutes (`HANDOFF_MAX_WINDOW_MS`). A new operator recovery request may renew that window, but does not refund spent attempts or mint a replacement handoff identity. Summarizer calls, including failed calls with known usage, remain attributable to their originating session.

### Handoff phases

`handoffTransaction` entries record these phases. The `/context` overlay's Next request section shows `handoff pending` (or the last outcome) with the pending ID and the recovery command.

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

If the continuation still cannot fit, use `/context compact` to reduce more history before trying delivery again. Missing or conflicting storage evidence can prevent recovery. CLIO Coder retains uncertainty instead of silently creating a new transaction. A missing commit can be reconstructed only from a validated summary carry, using its original reserved identity and an exact storage check.

Session forks inherit notes as recall only. They do not inherit permission to resume the parent's handoff, and a fork drops handoff records, recovery requests and compaction summaries written after its fork point. Ordinary summaries persist in the session ledger and replay after `/resume`. To move work to another session or agent, `/handoff <goal>` mints a successor session (see [Session lifecycle](../architecture/session-lifecycle.md#handoff-with-handoff)), and task-memory handoff exports live under `.clio-coder/handoffs/` (see [Proactive memory](proactive-memory.md)).

## Request budgets and memory

Submission and native continuation require estimated input plus the resolved output reservation to fit the effective window. On `openai-completions` and `ollama-native`, which shrink `max_tokens` to the room left, the reservation never falls below one eighth of the window, capped by the output budget, so a near-full request compacts or is refused instead of going out with a starved response allowance ([Context engine](../architecture/context-engine.md#context-window-resolution)). Pending user-message framing and images count. A final check inspects the actual request after steering has been drained. Ordinary automatic-compaction preferences remain separate from this hard admission check: disabling automatic compaction, or pausing it after failures, cannot authorize an oversized request. A request that does not fit forces a reduction (working-set eviction down to fit, then a summary) even while automatic compaction is off or paused. Such a pass, and overflow recovery, rewrites the previous checkpoint even when little work follows it. An automatic pass rewrites it only when the retained suffix is at least twice the checkpoint's size. When the reduction cannot make it fit, CLIO Coder refuses the request with `Request exceeds the available context window (input N + output M, window W)` and runs nothing. `CLIO_CODER_FORCE_COMPACT=1` forces the summary before every interactive turn, see [Environment variables](environment-variables.md). Tool output has its own per-turn byte budget that scales with the window, described under [Tool output accounting](../architecture/context-engine.md#tool-output-accounting).

Successful durable reductions invalidate older private-memory content jobs and queued memory reminders. Their known usage still counts. Restoration retains the private bank, selects a bounded set of remembered facts and procedures, and suppresses stale private status when an authoritative summary or handoff is available. The full reminder wrapper must fit, and restoration is consumed only after installation in an admitted context. Independent verification retains its own evidence and review records.

Approved durable-memory selection is frozen for a prepared turn and its continuations. Changes in session, repository, runtime, model, or memory configuration invalidate that authority. A subsequent turn reads the current bounded store contents; a same-size rewrite cannot hide behind a file-size cache key. Default selection limits remain five records and 400 tokens. Main sessions also gate the selection on the turn: a record is carried only when it names one of the turn's active paths or symbols, or shares at least two distinctive terms with the operator's request, and a record carried five turns running without use needs four. `memory_recall` still reaches every eligible record. See [Prompt injection rules](../architecture/evidence-and-memory.md#prompt-injection-rules).

Request admission combines provider token observations with estimates for unmeasured content. Ledger flushes and checkpoints record local persistence; remote delivery recovery uses the stored handoff phase and requires the explicit operator command described above.
