## Pick up a conversation

In the terminal, use `/resume` to choose a previous session, or `/rename` first so you can resume it by name. On the desktop, open a saved conversation from **Overview** or **Sessions**. Saved history lets you continue with the context of earlier work.

Use `/tree` to inspect terminal conversation branches and `/fork [name]` to fork from an assistant turn into a new session, optionally named. `/tree` rewinds the conversation; `/rewind` restores files. On the desktop, open **Branches** in the Session column. Branches let you explore another direction while preserving the earlier conversation.

## Find sessions from the shell

`clio-coder session list` shows open sessions on this state directory, from any host that shares it, with host, pid, and last heartbeat. `clio-coder session terminate <id>` asks the owning process to exit. `clio-coder session history` lists saved sessions, `clio-coder --resume <id or prefix>` reopens one, and `clio-coder --continue` reopens the most recent session for the project.

## Keep long work focused

Open `/context` to inspect context usage, output reservation, remaining headroom, and any pending handoff. CLIO Coder compacts a long native session automatically when context use crosses its configured threshold, or you can request a focused summary:

```text
/context compact Keep the objective, decisions, changed files, test results, and remaining work.
```

For a fresh session with a stated goal, use `/handoff <goal>`. When moving work between agents, make sure the handoff includes evidence and unresolved questions, then review what the receiving agent does.

To keep a session well under the model's window, start it with `clio-coder --max-context-tokens <N>`. `clio-coder run` takes the same flag. It caps the context budget and never enlarges the server's window.

## Recover an interrupted handoff

If `/context` shows a pending handoff, use its exact ID:

```text
/context recover <handoffId> reduce
/context recover <handoffId> deliver
```

Choose `reduce` when the reduction has not committed and another attempt remains; choose `deliver` when a validated commit exists. If the continuation still cannot fit, compact more history first.

A restarted process records an interrupted handoff as paused and waits for your recovery command. A fork receives earlier notes as recall; it does not inherit permission to resume the parent's handoff.
