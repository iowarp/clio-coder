---
version: 3
name: build-review
description: Implement the change, then hold it against an independent reviewer with a bounded revise loop.
steps:
  - kind: agent
    id: build
    agent: coder
    scope: workspace
    dependencies: []
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [build]
    check: {kind: agent, agent: verifier, scope: readonly}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

Implement this change so that an independent reviewer would approve it.

{{task}}

A separate read-only verifier inspects the workspace afterwards and answers a
typed pass/fail with per-check evidence. It is a different run with its own
context: it cannot see your reasoning, only the tree you leave behind and the
task above. Nothing you write here persuades it.

If it fails you, you receive its failed checks as input data and get exactly one
revision. Close the findings it reported and nothing else.
