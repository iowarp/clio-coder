# Project Status

Last updated: 2026-04-24

## Release State

- Public releases: none.
- Current package version: `0.1.0-dev`.
- Current protected branch: `main`.
- Baseline before governance setup: `747f71c`.

## Current Focus

- Stabilize the v0.1 development surface before any public release.
- Keep CLI lifecycle, provider config, native worker dispatch, session restore,
  TUI overlays, and developer workflow coherent.
- Prepare the repo for outside contributors and coding agents.

## Required Gates

Run before review:

```bash
npm run ci
```

Useful targeted checks:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:e2e
```

Optional live smoke when runtimes are configured:

```bash
npm run smoke:workers:live
```

## Ownership

- Maintainer and required reviewer for main: `@akougkas`.
- Organization/lab attribution: IOWarp, iowarp.ai, Gnosis Research Center.
- License posture: Apache-2.0 with project attribution in `NOTICE`.

## Agent Update Rules

- Update `CHANGELOG.md` for user-visible changes and release status changes.
- Update this file when version, release posture, active branch, or gates
  change.
- Keep this file factual. Do not use roadmap language here.
