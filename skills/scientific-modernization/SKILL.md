---
name: scientific-modernization
description: Use when modernizing, porting, rewriting, packaging, accelerating, or replacing established scientific software, especially across languages, build systems, CPU/GPU backends, or maintained forks. Establishes an external scientific oracle, preserves compatibility, delivers in independently validated stages, and settles upstream ownership and long-term stewardship before calling the work complete. Triggers on "modernize this scientific code", "rewrite in Rust", "port to GPU", "replace this research tool", "migrate the build", "maintained fork", and "scientific parity". Not for an isolated benchmark; use experiment-protocol. Not for diagnosing wrong results; use scientific-debugging.
version: 0.1.0
license: Apache-2.0
allowed-tools:
  - read
  - write
  - grep
  - ls
  - find
  - git
  - context
  - code_nav
  - bash
registry-id: iowarp/clio-coder
source-url: https://github.com/iowarp/clio-coder/tree/main/skills/scientific-modernization
audit: pass
---

# Scientific Modernization

Treat modernization as preservation of scientific behavior and stewardship,
not source translation. Faster code, a clean build, and passing self-authored
unit tests do not establish scientific equivalence.

## 1. Decide whether this work should exist

Identify the upstream project, active maintainers, license, release cadence,
supported users, and existing contribution path. Prefer improving the original
project when coordination is viable. If a separate implementation is needed,
name its owner, compatibility promise, maintenance horizon, and handoff path.
Do not begin a rewrite whose only durable plan is "the community can maintain
it later."

Record this decision before implementation:

- upstream contribution, maintained successor, or explicitly scoped fork;
- accountable maintainer or organization;
- compatibility surface that users already rely on;
- release, deprecation, and migration intent.

## 2. Establish an independent scientific oracle

Write the acceptance contract in `.clio/validation.yaml` (preferred) or
`VALIDATION.md` before changing behavior. Select at least one oracle that does
not depend on the new implementation agreeing with itself:

- exact outputs from a trusted reference implementation;
- parity against the established tool over a representative corpus;
- known statistical behavior with pre-registered bounds;
- simulated data whose correct answer is fixed in advance;
- conserved quantities, analytical solutions, or domain invariants.

Define numerical semantics per output: units, shapes, ordering, missing-value
behavior, determinism, absolute and relative tolerances, and allowed platform
variation. Include adversarial and historically troublesome inputs. If no
credible oracle exists, stop and report that limitation; implementation
velocity cannot repair an undefined scientific truth condition.

Keep performance acceptance separate from correctness. Use
`experiment-protocol` to pre-register performance thresholds and environment
pins when speed or scale is part of the claim.

## 3. Freeze the compatibility envelope

Inventory observable behavior before migration:

- CLI and API contracts, file formats, schemas, defaults, and error behavior;
- packaging, fresh-install, upgrade, and uninstall paths;
- supported platforms, compilers, runtimes, accelerators, and schedulers;
- resource scaling, reproducibility controls, and provenance;
- undocumented conventions captured by downstream tests and real workflows.

Capture reference outputs and installation evidence from released artifacts,
not only the source checkout. Mature scientific software carries user trust and
operational conventions that a line-by-line translation will miss.

## 4. Deliver in independently valid stages

Split the work into the smallest stages that can each be checked against the
oracle. Give every stage a before/after boundary, acceptance command, retained
artifact, and rollback point. Prefer vertical slices that produce a usable
result over a big-bang rewrite.

At each stage:

1. Capture the reference result on the pinned corpus and environment.
2. Make one bounded change.
3. Run compatibility and scientific-oracle checks.
4. Preserve raw outputs, discrepancies, and provenance.
5. Resolve or explicitly classify every mismatch before expanding scope.

An agent's confidence is not evidence. A reviewer who cannot reconstruct the
comparison from retained artifacts must mark the stage unverified.

## 5. Budget explicitly for the last mile

Expect initial implementation to be faster than convergence. Reserve work for
edge cases, subtle numerical differences, nondeterminism, fresh environments,
large inputs, interrupted runs, packaging metadata, documentation, and user
migration. Re-run the full oracle matrix after optimization: correctness proven
before an optimization is not inherited by the optimized implementation.

Use `scientific-debugging` when a mismatch needs causal diagnosis. Do not widen
tolerances or discard inconvenient corpus entries merely to obtain parity.

## 6. Ship only with evidence and stewardship

A completion claim must include:

- the oracle and compatibility matrix that passed, plus retained artifacts;
- unresolved differences and their user-visible consequences;
- fresh-install and documented-workflow results;
- performance results, if claimed, under their registered protocol;
- upstream status or the named owner and maintenance plan;
- migration, rollback, release, and deprecation instructions.

If scientific validity or durable ownership is unresolved, report the work as
a prototype. Do not describe it as a replacement, successor, or production
release.

## Red Flags

- A rewrite begins before maintainers or downstream users are consulted.
- Tests are derived only from the new implementation.
- "The outputs look close" replaces declared tolerance semantics.
- Performance wins are reported before scientific parity.
- One final comparison substitutes for staged validation.
- A passing happy path hides fresh-install, scale, or edge-case failures.
- A fork ships without an accountable owner and maintenance horizon.
