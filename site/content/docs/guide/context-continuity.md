# Save and resume work

Resume conversations, manage context, and prepare a handoff.

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

## Recovering an interrupted handoff

The `/context` overlay shows the pending handoff ID and its phase. Use the exact ID:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

`reduce` is available when the handoff has not committed and an attempt remains. `deliver` is available when a validated commit exists. A restarted process first records the interrupted state as paused; it does not automatically repeat an uncertain delivery. Recovery authority comes from the operator command and its durable control record, never from a tool argument or text found in a note.

If the continuation still cannot fit, use `/context compact` to reduce more history before trying delivery again. Missing or conflicting storage evidence can prevent recovery. Clio retains uncertainty instead of silently creating a new transaction. A missing commit can be reconstructed only from a validated summary carry, using its original reserved identity and an exact storage check.

Session forks inherit notes as recall only. They do not inherit permission to resume the parent's handoff. Ordinary summaries persist in the session ledger and replay after `/resume`; a separate handoff file remains useful when moving work to another session or another agent.
