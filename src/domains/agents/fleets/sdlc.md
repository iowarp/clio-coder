---
version: 3
name: sdlc
description: "Plan, build, test with a bounded fix loop, review with a bounded revise loop, then document. Three commits, three authors. Registry commands required: test, commit."
steps:
  - kind: agent
    id: plan
    agent: architect
    scope: workspace
    dependencies: []
  - kind: code
    id: commit-plan
    command: commit
    scope: workspace
    dependencies: [plan]
    commitFrom: [plan]
  - kind: agent
    id: build
    agent: coder
    scope: workspace
    dependencies: [plan, commit-plan]
  - kind: loop
    id: suite
    maxAttempts: 3
    dependencies: [build]
    check: {kind: code, command: test, scope: workspace}
    repair: {kind: agent, agent: coder, scope: workspace}
  - kind: loop
    id: review
    maxAttempts: 2
    dependencies: [suite]
    check: {kind: agent, agent: verifier, scope: readonly}
    repair: {kind: agent, agent: coder, scope: workspace}
  - kind: code
    id: commit-code
    command: commit
    scope: workspace
    dependencies: [suite, review]
    commitFrom: [review, suite, build]
  - kind: agent
    id: document
    agent: documenter
    scope: workspace
    dependencies: [commit-plan, commit-code]
  - kind: code
    id: commit-docs
    command: commit
    scope: workspace
    dependencies: [document]
    commitFrom: [document]
maxWorkers: 1
onFailure: stop
---

{{task}}

This is one chain with several authors. Do only the step you were given.

Plan. Turn the request above into an implementable plan and write it to the
artifact your contract names. The plan is committed before any code exists to
blur it, so write the specification you want held against the result.

Build. Implement that plan exactly. The plan is provided to you as input data.

Verify. Two different questions get asked, in order, and neither can answer the
other's. The suite asks whether it runs: code executes the repository's
registered `test` command and hands you its verbatim output if it is red. The
reviewer asks whether this is what was asked for: an independent read-only
verifier grades the tree against the plan. A revision that lands after the last
green suite invalidates that green, and the suite is re-run before anything is
committed.

Repair. When either question comes back negative you receive its report as
input data and get a bounded number of attempts. Fix what was reported. Never
weaken a test, delete a check, or edit the plan to match the code.

Document. Write up the completed change. Your input includes this run's commit
reports; the run's baseline is the parent of the plan commit named in the
commit-plan report, because the run itself has moved the branch head since.
Describe only what the diff since that baseline actually shows.

Every agent that produces a work product answers `commitMessage` on its result:
one imperative subject line, in your own words, describing what you produced.
Code commits it. You never run git. Nothing is committed for the code until both
verification questions have passed, so a failed run leaves the plan committed and
the working tree dirty on purpose.
