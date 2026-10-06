---
version: 3
name: build-test
description: "Implement the change, then run the suite with a bounded fix loop. Registry commands required: test."
steps:
  - kind: agent
    id: build
    agent: coder
    scope: workspace
    dependencies: []
  - kind: loop
    id: suite
    maxAttempts: 3
    dependencies: [build]
    check: {kind: code, command: test, scope: workspace}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

Implement this change and leave the suite green.

{{task}}

The suite is run by code: after you finish, a deterministic check step runs the
repository's registered `test` command, shown below with its exact arguments,
and reports its exit code and output verbatim. The check also runs test files
you create or change and name in your mutation report through the project's
recognized test runner. If no runner is recognizable, the check records that
limitation and runs the registered command. Do not invent another test command.
For a reported defect, put your reproduction test beside the project's tests
and report its path, so it gates the result even when the registered command
names only existing test files.

If the suite comes back red you receive its output and the previous attempt's report as input data. Repair
exactly what it reported. Do not restate the failure, do not weaken or delete a
test to make it pass, and do not widen the change beyond the repair. You get at
most two repair attempts before the run fails with the suite still red.
