# Tools and permissions

Read, search, edit, and run commands with Clio's repository tools.

## Ask for a bounded change

Clio can read and search files, make edits, run shell commands, and execute declared project checks. Give it a concrete scope and an outcome you can review:

> Fix the parser's handling of empty input. Keep the public API unchanged, add the relevant regression test, and run the project's test check. Show the diff and result.

A useful sequence is **inspect → change → verify → review**. Inspect the actual diff before committing. The `git` tool can also run `add` and `commit`, and the safety rules judge those like the matching shell command.

## Understand permission requests

**default** is the supervised mode. Reads, workspace edits, and commands Clio recognizes, such as read-only inspection and the project's test runners, run without a prompt. Unrecognized shell commands and outward actions such as a push wait for your approval. **yolo** allows work without ordinary confirmation prompts; hard blocks and damage-control questions still apply. Set autonomy in **Permissions & Limits**.

Read each requested command and its working directory before approving it. In the terminal, a shell approval card also shows an **Effect** line that says in plain words what the command would do. It is a reading aid; admission does not depend on it.

Asking for a plan or saying “do not edit” guides the task; it does not establish a technical read-only boundary. Use the explicit tool restrictions or read-only dispatch options when you need that boundary.

## Verify using your project's checks

Ask Clio to discover available checks, then run the relevant one with `verify`. It uses declared scripts and supported build/CI definitions rather than treating arbitrary output as a test result.

> Discover this project's verification checks. Run the test check through verify and report the exit status, failures, and anything you could not check.

On the desktop, the Session column's **Artifacts** card lists tool output, receipts, and session records, and **Changes** lists the files a turn changed. In the terminal, use `/view` to browse artifacts and receipts.

For checks that must accompany specific changes, add a [project quality policy](/docs/guide/quality-policy.html). For a worked example, follow [the temperature-calibration tutorial](/tutorials/temperature-calibration.html).
