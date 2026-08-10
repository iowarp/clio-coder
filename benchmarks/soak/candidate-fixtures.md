# Candidate soak fixtures

Five fixtures worth building, harvested from a scientific-acceptance prompt that
was otherwise dropped as overscoped. Each one's subject is Clio's refusal, not a
model's output, which is what makes it a soak fixture rather than a benchmark.
Nothing here is scheduled. This file exists so the ideas are not re-derived.

The existing fixtures under `fixtures/` are the shape to follow: a deterministic
registry command in `.clio/fleets/commands.yaml` so the reading never depends on
talking a model into misbehaving, a `test/known-answers.test.mjs` that reads the
tree the verdict claims to describe, and metrics that read the sealed verdict.

## 1. Numerical parity with explicit tolerance semantics

A parity check where the tolerance carries its kind: absolute, relative, or ULP.
A bare `tolerance: 1e-6` is ambiguous about which of the three it means and must
be rejected at parse time rather than resolved by a default.

This is the one genuinely scientific check in the whole discarded document, and
it is the only item on this list that needs new machinery rather than exercising
what already exists. Everything else here builds on shipped code. Absent is
never false: a parity check whose tolerance could not be interpreted is not a
failed comparison, it is a contract that did not parse.

## 2. A tolerance widened after results are observed

The fixture observes a failing numerical result, then widens the tolerance so
the same result passes. Clio must refuse the second run rather than record a
green.

The refusal has to come from provenance rather than from comparing two numbers:
the contract that was sealed against the evidence is not the contract now being
evaluated. This is the adversarial case that makes idea 1 worth having, because
a tolerance nobody can change after the fact is the only kind that means
anything.

## 3. Green evidence a later mutation invalidated

Evidence goes green, a later workspace step mutates something the verification
measured, and the earlier green must stop counting.

Clio already enforces this. `src/domains/dispatch/execution-scheduler.ts`
re-runs a verification whose measured workspace a later step changed, bounded by
`STALENESS_REVALIDATION_LIMIT`. The fixture tests machinery that exists rather
than adding any, which is exactly why it is cheap.

## 4. Source checkout passes, clean install fails

A check that passes against the repository working tree and fails against an
installed package, because it reaches something the package does not ship.

`scripts/check-release.mjs` already audits the packed tarball for missing
runtime resources and forbidden files, and the release gate already runs the
packed CLI. The fixture's job is to make the divergence deterministic and to
assert Clio reports the install failure rather than the checkout success.

## 5. A faster implementation that violates a conserved quantity

A replacement that is measurably faster and breaks an analytical or
conserved-quantity invariant. Correctness and performance stay separate
accounts, and the fixture's subject is that Clio refuses the speedup rather than
trading the invariant for the number.

Pairs naturally with idea 1: the invariant is checked with the same explicit
tolerance semantics, and a conserved quantity that drifts outside tolerance is a
refusal, not a rounding note.

## Deliberately not harvested

The prompt this came from also specified a five-level readiness taxonomy,
software-stewardship metadata (accountable owner, compatibility horizon, upstream
status, migration and rollback, deprecation policy), and a forensic attribution
artifact with dual-evaluator consensus behind a deterministic agreement reducer.

Those are left out. The stewardship layer is governance metadata rather than
anything a coding harness executes, and the consensus reducer is a research
project wearing a work item's clothes. If they are ever wanted they are a
separate project with its own justification, not a fixture.
