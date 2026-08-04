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

The suite is run by code, not by you. Do not try to discover, invent, or run the
test command yourself; a deterministic step runs the repository's registered
`test` command after you finish and reports its exit code and output verbatim.

If the suite comes back red you will receive its output as input data. Repair
exactly what it reported. Do not restate the failure, do not weaken or delete a
test to make it pass, and do not widen the change beyond the repair. You get at
most two repair attempts before the run fails with the suite still red.

Answer with your `mutation-report`. Include `commitMessage`: one imperative
subject line describing this change, as you would write it in the log.
