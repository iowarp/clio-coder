---
version: 3
name: hoare-build-review
description: Implement a change, then hold it against an independent Hoare-logic reviewer with a bounded revise loop.
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
    check: {kind: agent, agent: hoare-verifier, scope: readonly}
    repair: {kind: agent, agent: coder, scope: workspace}
maxWorkers: 1
onFailure: stop
---

Implement this change so that an independent Hoare-logic reviewer can establish
its correctness.

{{task}}

State the contract of each function you add or change, as a docstring or comment
next to it. Give its precondition, its postcondition, what it may modify, and what
it raises or returns on error. The reviewer takes its specification from the task
and from those comments, never from the implementation, so a contract you leave
out is one it cannot check.

A separate read-only reviewer then derives the proof obligations: loop invariants
and variants, callee preconditions, and the language's hazards (overflow, bounds,
aliasing, undefined behavior). It discharges each one by a declared prover check or
a written argument. It is a different run with its own context. It sees only the
tree you leave and the task above.

If it fails you, you receive its failed and unknown obligations as input data and
get exactly one revision. Fix the code, or correct a contract that was wrong. Do
not weaken a contract to make an obligation pass.
