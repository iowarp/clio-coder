# Project Status

Last updated: 2026-04-24

## Release State

- Public releases: none.
- Current package version: `0.2.0-dev`.
- Current development branch in this checkout: `v0.2/parity`.
- Baseline branch: `main` at `747f71c`.
- Active source range: `747f71c..9c59275`.

## Current Focus

- Stabilize the v0.2 development surface before any public release.
- Keep CLI lifecycle, provider targets, worker dispatch, session restore,
  TUI overlays, and self-development mode coherent.
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
