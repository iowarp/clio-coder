# Repository tooling

These files belong to a source checkout, not the npm package. Runtime behavior
belongs in `src/`; scripts call its validators and indexer instead of copying them.
Use Node >=22.19 and the pnpm version pinned in `package.json`.

| Entry point | Purpose | Writes / external access | Gate |
| --- | --- | --- | --- |
| `pnpm build`, `pnpm dev` | `build.ts` wraps tsup; `build-codewiki-asset.ts` uses the production indexer and npm file list | Build output in `dist/`; no model calls | CI build |
| `pnpm lint` | `check-hygiene.ts`: source boundaries, documentation/configuration consistency, library and eval validation, packaging and Pi API checks | Temporary fixtures and installer dry runs; no model calls | Routine CI |
| `pnpm evals:check` | Validate committed eval suites with the production loader | Reads only; never runs suites or models | Included in lint |
| `pnpm library:pin` / `library:check` | `pin-library.ts`, `pin-skills.ts`, `generate-library-marketplace.ts`: validate packages and generate catalogs | Pin rewrites versioned catalogs; check only reads | Check included in lint |
| `pnpm skills:pin` / `skills:check` | Skill-only authoring commands; use library:pin to refresh the complete catalog after changes | Same as above | Via library check |
| `pnpm pi:surface-diff` / `pi:surface-snapshot` | Compare / deliberately refresh the consumed dependency API snapshot | Snapshot writes `docs/pi-surface.json` | Comparison included in lint, including same-version patches |
| `pnpm test:maintenance` | Focused keyboard/patch and tool-surface grader contracts | Isolated deterministic fixtures; no model calls | Routine CI |
| `pnpm ci:release` | `release-candidate.mjs`: clean committed source, CI, package audit, installed-package checks, exact tarball qualification | npm registry audit; scratch installs; receipt and tarball in user cache | Release qualification |
| `pnpm release:preflight` | Check source, Node version, age and package digest against the qualified artifact | Temporary tarball; no rebuild | Publication |
| `node scripts/check-release.mjs` | Package contents, budgets, versions, recipe contracts and dependency advisories | npm pack dry run and registry audit | Called by qualification |
| `bash scripts/install.sh --dry-run` | Preview public npm installer | Actual install accesses npm and selected prefix; dry run previews | Installer contract checks in routine CI |
| `pnpm install:local --dry-run` | Preview checkout installation | Actual install can sync dependencies, build, replace launcher symlink and run doctor repair | Dry-run/launcher checks in lint |
| `node --import tsx scripts/decision-probe.ts <fixture> --profile <name>` | Score a decision site's wording against its labeled fixture under `evals/fixtures/decision-cases/` | **Calls the configured decision model**; binds the fixture's sites to the profile in memory only | Explicit operator run only |
| `pnpm smoke:real-home --target <id>` | Manual smoke with an isolated copy of operator settings | **Calls the configured model**, copies credentials to private scratch, cleans up | Explicit operator run only |
| `bash scripts/verify-portable-hosts.sh [output-directory]` | Exercise installed Claude/Codex host interoperability | Requires host CLIs; isolated homes, local package install and saved evidence; no model calls | Optional integration evidence |

`configuration-reference.ts`, `release-audit.mjs`, `release-version-policy.mjs`,
their declaration files and `release-manifest.json` support these entry points.
They are not separate command frameworks.

## Adding tooling

A retained utility needs an entry point, a caller or documented workflow, and a
clear output location. Put transient probes and reports in ignored `tmp/` or an
OS temporary directory. Never commit run outputs here. Generated catalogs stay
versioned only with a deterministic generator and a drift check. All TypeScript
scripts are included explicitly in `pnpm typecheck`.
