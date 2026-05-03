# clio-coder test suite audit

Date: 2026-05-03

Scope: local hardening of `codex/test-suite-ci-redesign`; no pushes, PRs, tag changes, or remote branch edits.

## Current CI Shape

- `npm run ci` is the single local and GitHub confidence gate.
- It runs typecheck, lint, unit/integration/boundary tests, build, then e2e.
- `.github/workflows/ci.yml` has one job: checkout, setup Node 24 with npm cache, install `fd-find`, `npm ci`, then `npm run ci`.
- `fd-find` stays because slash autocomplete discovers `fd`/`fdfind`, and the CI install keeps that path exercised.

## What Was Wrong

- The previous local commit made `npm run ci` skip e2e.
- GitHub only ran e2e on tags, schedules, or manual dispatch, which made the default PR/push gate weaker than the product-facing test surface.
- The audit doc and contributor docs described e2e as optional despite no measured flake or unacceptable timing.
- The bash abort test added a production-facing kill-grace option only to shorten a test.

## What Changed

- Restored e2e to the default `npm run ci` contract without adding `ci:local`, `ci:full`, or diagnostic script sprawl.
- Removed the separate conditional e2e workflow step; the workflow trusts the package script.
- Kept `test`, `test:e2e`, and `check:boundaries` as the only test helper scripts.
- Kept integration-shaped test moves where they touch XDG state, filesystem state, subprocesses, HTTP servers, provider registries, or command surfaces.
- Kept deterministic timer injection for pure unit tests and preserved loose stable-text PTY e2e matching.
- Reworked the bash abort escalation test to wait for a readiness file and exercise the public `bashTool` surface.

## Measurements

Before final cleanup on the branch:

| Command | Wall time | Result | Note |
| --- | ---: | --- | --- |
| `npm run test` | 9.73s | passed | unit, integration, and boundary tests |
| `npm run test:e2e` | 66.29s | passed | includes build |
| `npm run ci` | 19.03s | passed | suspect contract; skipped e2e |

Final validation:

| Command | Wall time | Result | Note |
| --- | ---: | --- | --- |
| `npm run test` | 9.82s | passed | unit, integration, and boundary tests |
| `npm run test:e2e` | 59.19s | passed | includes build |
| `npm run ci` | 79.17s | passed | full gate including e2e |

## Remaining Risks

- E2E currently costs about one minute on this workstation. That is acceptable for the default gate until there is repeated CI evidence of flake or excessive queue time.
- The bash abort escalation test still validates a real 5s grace period because that timing is the behavior under test.
- Broad unit-to-integration moves increase the integration bucket, but the single `npm run test` command keeps the default non-e2e contract simple.

## Follow-ups

- If GitHub wall time becomes a problem, measure multiple PR runs first and split jobs only around a clear bottleneck.
- If e2e flakes, fix the unstable interaction or add deterministic waiting at the harness layer before considering a narrower gate.

Boundary rules remain enforced by `tests/boundaries/check-boundaries.ts`; no ignores, excludes, or softened invariants were added.
