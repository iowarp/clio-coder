# Save and resume work

Resume conversations, manage context, and prepare a handoff.

## Pick up a conversation

In the terminal, use `/resume` to choose a previous session. On the desktop, open a saved conversation from **Overview** or **Sessions**. Saved history lets you continue with the context of earlier work.

Use `/tree` to inspect terminal conversation branches and `/fork` to branch from an assistant turn. On the desktop, open the conversation's **Context & branches** view. Branches let you explore another direction while preserving the earlier conversation.

## Keep long work focused

Open `/context` to inspect context usage, output reservation, remaining headroom, and any pending handoff. Clio can compact a long native session automatically under its configured threshold, or you can request a focused summary:

```text
/context compact Keep the objective, decisions, changed files, test results, and remaining work.
```

For a fresh session with a stated goal, use `/handoff <goal>`. When moving work between agents, make sure the handoff includes evidence and unresolved questions, then review what the receiving agent does.

## Recover an interrupted handoff

If `/context` shows a pending handoff, use its exact ID:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

Choose `reduce` when the reduction has not committed and another attempt remains; choose `deliver` when a validated commit exists. If the continuation still cannot fit, compact more history first.

A restarted process records an interrupted handoff as paused and waits for your recovery command. A fork receives earlier notes as recall; it does not inherit permission to resume the parent's handoff.
