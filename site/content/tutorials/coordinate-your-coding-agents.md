You can use CLIO Coder to coordinate the coding agents you already have installed. Give a peer a focused assignment, follow a managed run where the connector supports it, and review its output before accepting the change.

::: note Version scope
In v0.8.0 the supported peer family includes Claude Code, Codex, OpenCode, Pi, and Antigravity. Their modes and controls differ. Install and authenticate each peer's own CLI before configuring it in CLIO Coder.
:::

::: needs
- CLIO Coder with one working model connection. The [first session](/tutorials/first-session.html) covers it.
- A peer's CLI installed and signed in under its own account.
- An assignment whose answer you can check against the repository.
:::

## See which peers CLIO Coder can use

```sh
clio-coder interop inspect --json
clio-coder configure --interop
```

The first command reports what CLIO Coder can find; the second configures interoperability. In a terminal conversation, `/library interop` shows the available connections. The [interoperability guide](/docs/guide/interop.html) covers the mode for each peer.

::: capture tui-interop cli-interop-inspect
What CLIO Coder detected on a machine with three peer CLIs installed but not signed in.
:::

## Choose managed work or an interactive handoff

The three commands answer different needs. Pick by whether you want a recorded run or a place to work with the peer yourself.

::: compare
| Command | What happens | What CLIO Coder records |
| --- | --- | --- |
| `/run <agent-id> <task>` | A configured ACP peer runs the task; `acp:<id>` names one explicitly | The result and a sealed run record |
| `/run --target <target> <agent> <task>` | A configured headless target runs it | The result and a sealed run record |
| `/panes peer <agent> [brief]` | A pane opens beside the conversation for you to work in | No run record |
:::

The [panes guide](/tutorials/panes-and-docks.html) covers the pane host. Do not infer that a pane completed a task because it opened. Do not infer that a run record contains every internal reasoning step or mediates every operation inside a peer-owned loop.

## Give one bounded assignment

::: prompt Assign to a peer
Inspect the parser's handling of empty input. Identify the existing tests and propose a regression test. Do not edit files.
:::

That last sentence is a task instruction, not an enforced boundary. For an enforced one, put `--read-only` before the task, as in `/run --read-only <agent> <task>`; an option typed after the task text becomes part of the task. CLIO Coder admits a read-only run only on a peer whose own sandbox refuses every write, and refuses it before launch on every other peer, ACP peers included.

## Keep worker authority separate

A native worker inherits the main session's level inside its own permit and OS sandbox. At contained `yolo`, which is yolo's default, workers are dispatched as at `default`; at unconfined `yolo` a mediated worker runs the yolo way within its dispatch scope. A read-only worker stays at `default`.

Managed peer dispatches run at default permissions, even when the main session uses `yolo`, and each external agent runs its own tool loop.

A read-only run must leave every file outside CLIO Coder's home unchanged. It is admitted only where the peer's own sandbox guarantees that, so check the peer before you rely on it.

::: compare
| Peer | Read-only headless run in v0.8.0 |
| --- | --- |
| Codex | Runs under its read-only sandbox mode |
| Claude Code | Refused before launch |
| Antigravity | Refused before launch |
| Pi | Refused before launch |
| OpenCode | Refused before launch |
:::

ACP peers may own their tools. Explicitly permitting peer-owned tools changes what CLIO Coder can observe and mediate, so read the guide's permission limits before using such a peer on sensitive work. CLIO Coder's own shell commands and native workers' commands run in an OS sandbox when one is available. External peers keep their own authority.

## Separate changes with a worktree

For supported headless dispatch, `--worktree` keeps a Git task branch for review. That helps you compare two proposed changes without mixing their working files.

A worktree is an organizational boundary. It does not confine a peer's filesystem or network access. Keep assignments narrow, inspect the branch and diff, and run the repository's checks before merging a result.

## Review before combining

::: result What to look for
A useful result may be a diagnosis, a patch, or a failed attempt that reveals a missing dependency. Look for the files it touched, the checks it ran, and the limits of its report. A claimed test result and an observed check are different evidence.
:::

When comparing agents, give them the same task and evaluate the actual output. Record the model, connector, setup, check results, and any costs you can substantiate. CLIO Coder coordinating two peers does not make either one better.

::: limits
- Supported modes differ by peer, and some cannot receive live steering.
- A pane is an interactive handoff; it produces no run record.
- Peer accounts, subscriptions, and usage limits stay with each peer's own provider.
:::

::: next
- [Your first session with CLIO Coder](/tutorials/first-session.html)
- [Project quality checks](/docs/guide/quality-policy.html)
- [Interoperability guide](/docs/guide/interop.html)
:::
