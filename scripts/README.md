# Repository tooling

These files belong to a source checkout, not the npm package. Runtime behavior
belongs in `src/`; scripts call its validators and indexer instead of copying them.
Use Node >=22.19 and the pnpm version pinned in `package.json`.

| Entry point | Purpose | Writes / external access | Gate |
| --- | --- | --- | --- |
| `pnpm build`, `pnpm dev` | `build.ts` wraps tsup; `build-codewiki-asset.ts` uses the production indexer and npm file list | Build output in `dist/`; no model calls | CI build |
| `pnpm lint` | `check-hygiene.ts`: source boundaries, documentation/configuration consistency, library validation, packaging and Pi API checks | Temporary fixtures and installer dry runs; no model calls | Routine CI |
| `pnpm library:pin` / `library:check` | `pin-library.ts`, `pin-skills.ts`, `generate-library-marketplace.ts`: validate packages and generate catalogs | Pin rewrites versioned catalogs; check only reads | Check included in lint |
| `pnpm skills:pin` / `skills:check` | Skill-only authoring commands; use library:pin to refresh the complete catalog after changes | Same as above | Via library check |
| `pnpm pi:surface-diff` / `pi:surface-snapshot` | Compare / deliberately refresh the consumed dependency API snapshot | Snapshot writes `docs/pi-surface.json` | Comparison included in lint, including same-version patches |
| `pnpm test:maintenance` | Focused keyboard routing and draft contracts | Isolated deterministic fixtures; no model calls | Routine CI |
| `pnpm test:package` | Installed tarball and native call timing contracts | Scratch installs from an absolute `CLIO_CODER_RELEASE_TARBALL`; no model calls | Hosted CI on pushes and pull requests; release qualification |
| `pnpm ci:release` | `release-candidate.mjs`: clean committed source, CI, package audit, installed-package checks, exact tarball qualification | npm registry audit; scratch installs; receipt and tarball in user cache | Release qualification |
| `pnpm release:readiness` / `pnpm release:readiness -- --release` | Check package/README/site versions, docs provenance, tracked media, and an isolated website build; immutable mode also requires dated release state | Read-only; temporary website output | Release preparation |
| `pnpm release:preflight` | Check source, Node version, age and package digest against the qualified artifact | Temporary tarball; no rebuild | Publication |
| `python3 scripts/media-assets.py --check` / `--sync` | Check media hashes/dimensions and synchronize manifest-declared website/GUI delivery copies | Check is read-only; sync writes only declared copies | Website/media preparation |
| `node site/render-cards.mjs` | Render four social cards at declared dimensions after fonts load and record source/export hashes | Writes PNG exports and `assets/media-manifest.json`; no network | Website/media preparation |
| `node scripts/check-release.mjs` | Package contents, budgets, versions, recipe contracts and dependency advisories | npm pack dry run and registry audit | Called by qualification |
| `bash scripts/install.sh --dry-run` | Preview public npm installer | Actual install accesses npm and selected prefix; dry run previews | Installer contract checks in routine CI |
| `pnpm install:local --dry-run` | Preview checkout installation | Actual install can sync dependencies, build, replace launcher symlink and run doctor repair | Dry-run/launcher checks in lint |
| `node --import tsx scripts/decision-probe.ts <fixture> --engine <name>` | Score a System One site's wording against its labeled fixture under `tests/fixtures/decision-cases/` (`turn`, `turn-end`, `tool-calls`, `tool-results`, `capabilities`); reports agree, abstain, wrong and confident-wrong per key, the positive and negative ranges per run, and a suggested cut with its margins; `--cases` also writes each call's values to stderr; `--kind`, `--target` and `--model` build an engine that `systemOne.engines` lacks | **Calls the named engine**; the engine and its site binding exist in memory only, and nothing is written to settings | Explicit operator run only |

Hosted CI runs the source checks and three shards of the core tests in parallel.
The `ci (22)` status combines those results with Windows subprocess tests and a six-minute installed-package job that builds, packs into a temporary directory, and runs `pnpm run test:package` with an absolute tarball path; the
separate `ci (24)` status covers the newer Node runtime. A tag release calls that
same CI workflow, then rebuilds and audits the exact tarball before publishing
it. The local `pnpm ci:release` command still runs the complete gate and records
a receipt for `release:preflight`.

`configuration-reference.ts`, `release-audit.mjs`, `release-version-policy.mjs`,
their declaration files and `release-manifest.json` support these entry points.
They are not separate command frameworks.

## Adding tooling

A retained utility needs an entry point, a caller or documented workflow, and a
clear output location. Put transient probes and reports in ignored `tmp/` or an
OS temporary directory. Never commit run outputs here. Generated catalogs stay
versioned only with a deterministic generator and a drift check. All TypeScript
scripts are included explicitly in `pnpm typecheck`.
