---
version: 3
name: bounded-repair
description: "A deterministic known-answer check with a bounded agent repair. Registry commands required: test."
steps:
  - kind: loop
    id: repair
    maxAttempts: 3
    dependencies: []
    check: {kind: code, command: test, scope: workspace}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

`rollingMean` in `src/window.mjs` drops the final complete window: the loop
bound is `start < values.length - size`, but a complete window ends at
`start === values.length - size`.

The suite is run by code, not by you. A deterministic step runs the
repository's registered `test` command and reports its exit code and output
verbatim. Repair exactly what it reports in `src/window.mjs`. Do not weaken or
delete the test to make it pass.

Answer with your `mutation-report`.
