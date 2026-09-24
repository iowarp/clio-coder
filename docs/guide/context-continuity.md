# Context continuity and recovery

`compact` in [compact.ts](../../src/domains/session/compaction/compact.ts) implements summary handoff. The [context engine](../architecture/context-engine.md#single-threshold-compaction) explains the budget and trigger.

Clio can reduce a long native session while preserving the assistant's exact handoff note and the original task. Open `/context` to inspect the next request's input, output reservation, headroom, and pending handoff. The model can read the same accounting with `context(scope="budget")`.

## Choosing a reduction

| Action | Use it for |
| --- | --- |
| Automatic compaction | Routine pressure management under your configured threshold. |
| `/context compact [instructions]` | An operator-directed summary, optionally focused on specific information. |
| `self_compact({"note_to_self":"…"})` | An assistant-directed handoff followed by continuation of the same task. |
| `/context recover <handoffId> <reduce\|deliver>` | Explicit recovery of an interrupted handoff. |

`self_compact` is available to the native orchestrator. Dispatched workers do not receive its host callback, and external agents that own their own loop do not receive its schema through the native session tool surface. Skill restrictions and normal tool permission checks still apply.

The assistant must call `self_compact` alone. A batch containing it and another tool, or two self-compaction calls, is rejected before any valid sibling executes. The note should preserve the objective, decisions, useful evidence, relevant paths, unresolved questions, and next steps. It must be nonblank and no larger than 8,192 UTF-8 bytes. Clio preserves the accepted text exactly and labels it as assistant-authored recall, rather than presenting it as an operator instruction.

## What the receipt means

The tool's first receipt means that the note was prepared and flushed to the session ledger. Reduction happens after that receipt has been persisted. Clio records the reduction attempt before invoking the summarizer, checkpoints the outcome, and records delivery intent before allowing another foreground request.

A final, nonempty, successful assistant response acknowledges that delivery. Intermediate tool calls, empty responses, errors, cancellation, and a generic end-of-run event do not acknowledge it. Continuation does not append another operator turn or create a fresh durable-memory selection attempt.

Each handoff allows at most two reduction attempts, with at most two summary stream invocations per attempt. The automatic window is bounded to 15 minutes. A new operator recovery request may renew that window, but does not refund spent attempts or mint a replacement handoff identity. Summarizer calls, including failed calls with known usage, remain attributable to their originating session.

## Recovering an interrupted handoff

The `/context` overlay shows the pending handoff ID and its phase. Use the exact ID:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

`reduce` is available when the handoff has not committed and an attempt remains. `deliver` is available when a validated commit exists. A restarted process first records the interrupted state as paused; it does not automatically repeat an uncertain delivery. Recovery authority comes from the operator command and its durable control record, never from a tool argument or text found in a note.

If the continuation still cannot fit, use `/context compact` to reduce more history before trying delivery again. Missing or conflicting storage evidence can prevent recovery. Clio retains uncertainty instead of silently creating a new transaction. A missing commit can be reconstructed only from a validated summary carry, using its original reserved identity and an exact storage check.

Session forks inherit notes as recall only. They do not inherit permission to resume the parent's handoff. Ordinary summaries persist in the session ledger and replay after `/resume`; a separate handoff file remains useful when moving work to another session or another agent.

## Request budgets and memory

Submission and native continuation require estimated input plus the resolved output reservation to fit the effective window. Pending user-message framing and images count. A final check inspects the actual request after steering has been drained. Ordinary automatic-compaction preferences remain separate from this hard admission check: disabling automatic compaction cannot authorize an oversized request.

Successful durable reductions invalidate older private-memory content jobs and queued memory reminders. Their known usage still counts. Restoration retains the private bank, selects a bounded set of remembered facts and procedures, and suppresses stale private status when an authoritative summary or handoff is available. The full reminder wrapper must fit, and restoration is consumed only after installation in an admitted context. This does not make remembered claims independently verified.

Approved durable-memory selection is frozen for a prepared turn and its continuations. Changes in session, repository, runtime, model, or memory configuration invalidate that authority. A subsequent turn reads the current bounded store contents; a same-size rewrite cannot hide behind a file-size cache key. Default selection limits remain five records and 400 tokens. Experimental lexical ranking is not enabled by default.

Token counts remain estimates unless a provider has attested the relevant prefix. Flush and checkpoint success establish the filesystem durability available to the running process; they do not guarantee survival of every hardware or power failure, or exactly-once execution by a remote provider.
