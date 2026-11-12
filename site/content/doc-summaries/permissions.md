## Ask for a bounded change

CLIO Coder can read and search files, make edits, run shell commands, and execute declared project checks. Give it a concrete scope and an outcome you can review:

> Fix the parser's handling of empty input. Keep the public API unchanged, add the relevant regression test, and run the project's test check. Show the diff and result.

A useful sequence is **inspect → change → verify → review**. Inspect the actual diff before committing. The `git` tool can also run `add` and `commit`, and the safety rules judge those like the matching shell command.

## Understand permission requests

**default** follows one rule: containment first, judgment second, asking last. Workspace edits run. Shell commands run inside an OS sandbox when the host has one. In a Git work tree, CLIO Coder snapshots your files before the first change of a turn, and `/rewind` restores them. A safety judge reviews what would otherwise ask against your own messages, and you are asked when it has no verdict or the decision is yours.

**yolo** is for long jobs you leave running: nothing waits for you. It is contained by default, so the sandbox, snapshots, and safety judge work as at `default`, and a call that would have asked you is refused back to CLIO Coder. It needs a one-time acceptance. Set the level in Settings, with `--autonomy`, or with the leader key.

Unconfined yolo is the skip-permissions mode for a container or another disposable environment. Commands run unsandboxed as you, and only a short floor, your project rules, and the run's ceilings block. It takes effect only with `safety.yoloConfinement: unconfined` in your user settings and its own one-time acceptance. See [the containment tutorial](/tutorials/let-it-work-with-containment-and-rewind.html).

When a card reaches you, read the command and its working directory before approving it. A card nobody answers within `safety.unattendedAfterSeconds` (300 by default) is denied and the turn continues. In the terminal, a shell approval card also shows an **Effect** line that says in plain words what the command would do. It is a reading aid; admission does not depend on it.

Asking for a plan or saying “do not edit” guides the task; it does not establish a technical read-only boundary. Use the explicit tool restrictions or read-only dispatch options when you need that boundary.

## What the sandbox hides

A sandboxed command writes only to your project, the temp directories, your scratch roots, a private tool cache and the repository's Git data. It cannot read your SSH keys, cloud and code-host logins, registry tokens or the project's `.env` and key files, and credential variables are removed. A push, a publish or a cluster scheduler command needs those credentials, so it leaves the sandbox only once the safety judge or you allow it.

## Verify using your project's checks

Ask CLIO Coder to discover available checks, then run the relevant one with `verify`. It uses declared scripts and supported build/CI definitions rather than treating arbitrary output as a test result.

> Discover this project's verification checks. Run the test check through verify and report the exit status, failures, and anything you could not check.

On the desktop, the Session column's **Artifacts** card lists tool output and session records, and **Changes** lists the files a turn changed. In the terminal, use `/view` to browse artifacts and run records.

For checks that must accompany specific changes, add a [project quality policy](/docs/guide/quality-policy.html). For a worked example, follow [the temperature-calibration tutorial](/tutorials/temperature-calibration.html).

## How tools reach the model

A main session starts with a small set of tools attached: `read`, `bash`, `edit`, `write`, `verify`, `ask_user`, and `gateway`, plus `dispatch` when workers are available and `consult` when a decision model is configured. The model finds every other capability through `gateway`, which can search the catalog, describe a tool's arguments, and call it. This keeps the request small while search, Git, web reading, data inspection, and MCP server tools stay one call away. Workers instead receive the tools their agent recipe admits.

Tool results are bounded. Each reading tool has a size cap per call, and all of them share a budget per turn that grows with the model's context window. A cut result ends with one notice line that says how much was shown and gives the exact argument for the next page. When the cap cut content that was already collected, the notice also names a read-only overflow copy in CLIO Coder's state directory, outside your workspace. The permission rules above apply to every tool, whether it is attached or reached through `gateway`.

The full guide lists every tool and its limits. Developers can read [how the prompt and tool surface are assembled](../architecture/prompt-envelope-and-tools.md).
