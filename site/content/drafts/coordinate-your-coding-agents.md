You can use Clio Coder to coordinate supported coding agents you already have installed. Give a peer a focused assignment, follow a managed run where the connector supports it, and review its output before accepting the change.

In v0.5.7, the supported peer family includes Claude Code, Codex, OpenCode, Pi, and Antigravity. Their supported modes and controls differ. Install and authenticate a peer's own CLI before configuring it in Clio.

## Inspect your available peers

```sh
clio-coder interop inspect --json
clio-coder configure --interop
```

The first command reports what Clio can find. The second helps configure interoperability. In a terminal conversation, `/interop` shows available connections. Use the [interoperability guide](/docs/guide/interop.html) to select the mode for the specific peer.

Start with an assignment whose answer you can check:

> Inspect the parser's handling of empty input. Identify the existing tests and propose a regression test. Do not edit files.

That last sentence is a task instruction. It does not create an enforced read-only boundary. Where supported, select the actual read-only dispatch restriction and inspect the admission preview. A connector that cannot enforce the requested restriction should not be treated as equivalent to one that can.

## Choose managed work or an interactive handoff

A managed ACP or headless run records its result and receipt. Clio can follow the run through the supported connector. In the terminal, `/delegate` uses a configured ACP peer; `/run` can select a configured headless target.

An interactive `/peer` handoff opens a Herdr pane. You work directly with that peer. It does not produce a managed Clio receipt. This is useful when you want another agent's interactive environment, but it answers a different need from delegating an inspectable run.

Do not infer that a pane completed a task because it opened successfully. Do not infer that a managed receipt contains every internal reasoning step or mediates every operation inside a peer-owned loop.

## Keep worker authority separate

Dispatched workers and external peers run at `default`, even when the main session uses `yolo`. Read-only is a dispatch restriction. Clio does not carry the main session's unrestricted setting into every worker.

Peers expose different mechanisms. In the current headless integrations, Codex uses its read-only sandbox mode, Claude Code uses plan mode with read tools, Antigravity uses its plan/sandbox route, and Pi uses read tools. OpenCode refuses a read-only headless run. Check the mode you are actually selecting rather than assuming every peer has the same contract.

ACP peers may own their tools. Explicitly permitting peer-owned tools changes what Clio can observe and mediate. See the guide's permission limits before using such a peer on sensitive work. Clio's coordination is not an operating-system sandbox.

## Separate changes with a worktree

For supported headless dispatch, `--worktree` preserves a Git task branch for review. That can help compare two proposed changes without mixing their working files.

A worktree is an organizational boundary. It does not confine a peer's filesystem or network access. Keep assignments narrow, inspect the resulting branch and diff, and run the repository's relevant checks before merging a result into your work.

When comparing agents, give them the same task and evaluate the actual output. Record the model, connector, setup, check results, and costs you can substantiate. Clio does not establish that one peer is universally better because it can coordinate both.

## Review before combining

A peer's useful result may be a diagnosis, a patch, or a failed attempt that reveals a missing dependency. Look for the files it touched, the checks it ran, and the limits of its report. A claimed test result and an observed check are different evidence.

You do not need several agents to begin. [Install Clio](/#start), connect one suitable model, and complete the [first session](/tutorials/first-session.html). Add a peer when a particular task benefits from it; use [project quality checks](/docs/guide/quality-policy.html) to define what must accompany an accepted change.
