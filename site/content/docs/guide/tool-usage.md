# Tools and permissions

Read, search, edit, and run commands with Clio's repository tools.

## Ask for a bounded change

Clio can read and search files, make edits, run shell commands, and execute declared project checks. Give it a concrete scope and an outcome you can review:

> Fix the parser's handling of empty input. Keep the public API unchanged, add the relevant regression test, and run the project's test check. Show the diff and result.

A useful sequence is **inspect → change → verify → review**. Clio's native Git inspection is read-only; inspect the actual diff before committing with your usual Git workflow.

## Understand permission requests

**default** is the supervised mode for workspace edits and approved execution. **yolo** allows work without ordinary confirmation prompts; hard blocks and damage-control questions still apply. Set autonomy in **Permissions & Limits**.

Read each requested command and its working directory before approving it. Asking for a plan or saying “do not edit” guides the task; it does not establish a technical read-only boundary. Use the explicit tool restrictions or read-only dispatch options when you need that boundary.

## Verify using your project's checks

Ask Clio to discover available checks, then run the relevant one with `verify`. It uses declared scripts and supported build/CI definitions rather than treating arbitrary output as a test result.

> Discover this project's verification checks. Run the test check through verify and report the exit status, failures, and anything you could not check.

On the desktop, open **Artifacts → Results** beside the conversation to inspect tool output. **Files** shows paths and changes recorded by tools. In the terminal, use `/view` to browse artifacts and receipts.

For checks that must accompany specific changes, add a [project quality policy](/docs/guide/quality-policy.html). For a worked example, follow [the temperature-calibration tutorial](/tutorials/temperature-calibration.html).
