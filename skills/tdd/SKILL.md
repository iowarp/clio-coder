---
name: tdd
description: Use when the user wants to build a feature or fix a bug test-first, says "TDD", "red-green", or "write the test first", or when a change to tricky logic needs its behavior pinned before implementation. Runs the red → green loop at pre-agreed public seams, one vertical slice at a time. Not for designing benchmark criteria; use experiment-protocol.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - grep
  - find
  - ls
  - git
  - bash
  - write
  - edit
  - ask_user
clio:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/skills/tdd
  audit: pass
  provenance: adapted
  origin: https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd
  eval-status: untested
  model-size: any
  agents:
    - main
    - coder
---

# Test-Driven Development

The red → green loop, run so it produces tests worth keeping. A good test
verifies behavior through a public interface and reads like a
specification: "user can checkout with valid cart" names a capability. The
implementation can change entirely; the test should not.

## Step 1 — Agree the seams

A seam is the public boundary you test at, observing behavior without
reaching inside. Before writing any test:

1. Read the project's instruction file and existing tests so names and
   vocabulary match the project's language and test conventions.
2. Write down the seams under test and confirm them with the user
   ("What's the public interface, and which seams should we test?").

No test is written at an unconfirmed seam. You cannot test everything;
agreeing seams up front is what lands the effort on critical paths instead
of every edge case.

## Step 2 — The loop

Per cycle, exactly:

1. **Red.** Write one failing test for the next thinnest slice of
   behavior. Run it; watch it fail for the expected reason. A test that
   passes immediately tested nothing — fix the test before proceeding.
2. **Green.** Write only enough implementation to pass it. No speculative
   features, no anticipating future tests.
3. Run the suite; all green → next slice.

One seam, one test, one minimal implementation per cycle. Refactoring is a
separate later pass with its own review, not part of this loop.

Vertical slices only: one test → one implementation → repeat, each test a
tracer bullet informed by the last cycle. Writing all tests first then all
code ("horizontal slicing") tests imagined behavior and locks in structure
before the implementation has taught you anything.

## Anti-patterns (reject the test, not the code)

- **Implementation-coupled**: mocks internal collaborators, tests private
  functions, or asserts through a side channel (querying the DB instead of
  the interface). Tell: the test breaks on refactor while behavior is
  unchanged.
- **Tautological**: the assertion recomputes the expected value the same
  way the code does (`expect(add(a,b)).toBe(a+b)`), so it passes by
  construction. Expected values come from an independent source: a
  known-good literal, a worked example, the spec.
- **Mock-everything**: when the tests use heavy mocking or the mocking
  strategy is in question, read `references/mocking.md`. For worked
  examples of good versus bad tests, read `references/tests.md`.

## Done when

Every agreed seam has its behaviors covered by tests that were each seen
red before green, the full suite passes, and no test in the diff trips an
anti-pattern above. Report which seams are covered and which were
deliberately left untested.

## Red flags

- A test written after the implementation it claims to drive.
- A cycle that added two tests or two behaviors at once.
- Green on first run, accepted without investigation.
- Tests asserting internal call sequences instead of outcomes.
