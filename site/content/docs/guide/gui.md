# The desktop app

Open the desktop alpha, keep tasks in one window, and read the Session column.

## Open the desktop app

The desktop app is in alpha. It is a local web application: Clio Coder serves it from your own machine on `127.0.0.1`, and it opens in your browser. It shares the terminal's saved connections and settings and covers a subset of terminal workflows.

```sh
clio-coder gui --open
```

Started this way, the app runs while that terminal stays open. On Linux with a systemd user session, including WSL, you can keep it running in the background instead. It then starts at login and appears in your app menu, or in the Windows Start Menu under WSL:

```sh
clio-coder gui background install --open
```

The installer offers the same step. The background app listens on port 4343, or 7373 when another program holds 4343. It uses saved credentials, so store a key that lives only in your shell with `clio-coder auth login <target>`.

## One window, many tasks

Launching again brings the open Clio Coder window forward instead of opening another. Open a second window on purpose with **Open in new window** in a task's menu.

Any number of tasks can be open. Up to four turns run at once; a further turn shows **Waiting for a slot** and starts when one frees. A task with no running turn that no window has shown for five minutes is paused. Its conversation stays readable, and **Resume session** continues it.

## Read the Session column

Beside each conversation, the Session column shows the workspace's path, branch and Git state, the model and its health, context, tokens and cost, the plan, artifacts, changed files, branches, agents, and evidence from receipts. It updates as the task runs. **App activity** counts working, queued, and approval-waiting tasks across workspaces.

Type `/` in the composer for session commands such as `/context`, `/usage`, `/tree`, `/fork`, and `/handoff`.

## Approvals

With **Ask first**, reads, edits, and recognized commands run, and unrecognized shell commands, large dispatch plans, and anything that publishes outside the project wait on a card. The card states what the call is, what allowing it authorizes, and what it can affect. Choose **Allow once** or **Reject**.

**Run without asking** turns approvals off for one task after a second confirmation. It lasts until the task closes or is paused.

If a project carries settings, hooks, safety rules, extensions, or plugins you have not approved, the app lists the ignored files above the conversation with the command that reviews them.
