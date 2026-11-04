# Tools and permissions

Read, search, edit, and run commands with Clio Coder's repository tools.

## Ask for a bounded change

Clio Coder can read and search files, make edits, run shell commands, and execute declared project checks. Give it a concrete scope and an outcome you can review:

> Fix the parser's handling of empty input. Keep the public API unchanged, add the relevant regression test, and run the project's test check. Show the diff and result.

A useful sequence is **inspect → change → verify → review**. Inspect the actual diff before committing. The `git` tool can also run `add` and `commit`, and the safety rules judge those like the matching shell command.

## Understand permission requests

**default** follows one rule: containment first, judgment second, asking last. Workspace edits run. Shell commands run inside an OS sandbox when the host has one. In a Git work tree, Clio Coder snapshots your files before the first change of a turn, and `/rewind` restores them. A safety judge reviews what would otherwise ask against your own messages, and you are asked when it has no verdict or the decision is yours.

**yolo** is a skip-permissions mode for long jobs in a container. Nothing asks and commands run unsandboxed as you; only a short floor, your project rules, and the run's ceilings block. It needs a one-time acceptance. Set the level in **Permissions & Limits**, with `--autonomy`, or with the leader key. See [the containment tutorial](/tutorials/let-it-work-with-containment-and-rewind.html).

When a card reaches you, read the command and its working directory before approving it. A card nobody answers within `safety.unattendedAfterSeconds` (300 by default) is denied and the turn continues. In the terminal, a shell approval card also shows an **Effect** line that says in plain words what the command would do. It is a reading aid; admission does not depend on it.

Asking for a plan or saying “do not edit” guides the task; it does not establish a technical read-only boundary. Use the explicit tool restrictions or read-only dispatch options when you need that boundary.

## Verify using your project's checks

Ask Clio Coder to discover available checks, then run the relevant one with `verify`. It uses declared scripts and supported build/CI definitions rather than treating arbitrary output as a test result.

> Discover this project's verification checks. Run the test check through verify and report the exit status, failures, and anything you could not check.

On the desktop, the Session column's **Artifacts** card lists tool output and session records, and **Changes** lists the files a turn changed. In the terminal, use `/view` to browse artifacts and run records.

For checks that must accompany specific changes, add a [project quality policy](/docs/guide/quality-policy.html). For a worked example, follow [the temperature-calibration tutorial](/tutorials/temperature-calibration.html).
