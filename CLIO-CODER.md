# Clio Coder

Clio Coder is a TypeScript/Node.js project. It is an open-source coding agent for scientific software, in your terminal, in headless runs, over ACP and in the browser: your models, bounded workers, and inspectable evidence.

## Hard invariants

1. Never commit or push a path that `.gitignore` excludes: `scripts/git-guard.mjs` refuses the `commit/push` and the `tracked-ignored` check fails CI; unstage with `git rm --cached <path>`.
2. Only `src/engine/**` may import `@earendil-works/pi-*` packages, including type imports (rule1 in `tests/boundaries/check-boundaries.ts`); worker value imports from domains are limited to provider runtime rehydration modules (rule2).
3. Domains communicate only through contracts and events: never cross-import another domain's `extension.ts`; use the contract exported from that domain's `index.ts` (rule3, `tests/boundaries/check-boundaries.ts`).
4. `src/tools/**` must not import `src/interactive` (rule4) and turn-runtime modules must not import `src/entry/**` (rule5); entry points compose dependencies, never the reverse.
5. Do not add a new disjoint reacher into the Stage 0 closure (`src/interactive/**`, `src/engine/**`) outside seams declared in `STAGE0_SEAMS` in `tests/boundaries/check-boundaries.ts`; esbuild splits the merged chunk and `tests/contracts/instant-shell-import-graph.test.ts` fails after a full build (32 chunks, 1,400,000 total bytes, 350,000 Clio source bytes).
6. Never mutate provider usage or put usage-shaped fields on a ledger payload (rule12); the ledger is the conversation record and the call journal owns usage (`tests/boundaries/check-boundaries.ts`).
7. Only the telemetry domain writes under the telemetry root; other modules go through the telemetry writers, and the telemetry producer path must not import persistence or do synchronous `I/O` (rules 11 and 13 in `tests/boundaries/check-boundaries.ts`).
8. Format money only through `renderPricing`/`renderUsdSum` in `src/core/telemetry/render.ts` or a DTO display, and show the read model's quantity display instead of summing `token/cost` fields on surfaces (rules 10 and 14 in `tests/boundaries/check-boundaries.ts`).
9. Never move a published tag, rebuild a published candidate, or republish different bytes; publish npm first, then the `GitHub` `tag/release`, then promote `main` and `gh-pages`, resuming a partial failure with the original artifact (`CONTRIBUTING.md`).
10. Agents must leave npm publish and release approval to the owner: the `release` environment requires the owner as required reviewer in `.github/workflows/release.yml`; never grant an App blanket bypass of published-tag immutability.

## Conventions

- Biome formats with tabs, double quotes, trailing commas, 120 columns (`biome.json`); `apps/clio-coder-gui` is excluded from Biome entirely, so check GUI code with `pnpm run check:gui`.
- `TypeScript` is strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and `noImplicitOverride` (`tsconfig.json`): index access yields `T | undefined` and optional properties must not be assigned `undefined` explicitly.
- Terminal colors live only in `src/interactive/theme`; raw SGR escapes, `38;2;`/`48;5;` fragments, and hex colors anywhere else in `src/interactive` fail the `theme-discipline` check in `scripts/check-hygiene.ts`.
- Project state paths use the `.clio-coder` namespace; a bare `.clio` path or directory fails the `product-namespace` check in `scripts/check-hygiene.ts` (except `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, `.github/releases/`).
- Prompt fragments are Markdown files under `src/domains/prompts/fragments/**` loaded by `loadFragments` in `src/domains/prompts/fragment-loader.ts`; duplicate fragment ids throw, and `identity.self-awareness` plus `identity.docs-routing` must stay registered for the `prompts` check.
- Keep CLI subcommands dynamically imported to preserve fast `--help` and startup (`CONTRIBUTING.md`).
- Tests use `pnpm run test:file` (preloads `tests/harness/tmp-root.ts`) with `tests/harness/scratch-env.ts` for state isolation; never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`).

## Change recipes

- Change a setting default: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` together in `src/core/defaults.ts` (the `defaults-yaml` check parses the YAML and deep-compares it), add or update the row in the `## Settings inventory` section of `docs/guide/configuration-and-targets.md` with the exact default and an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, or `restart`); the inventory needs at least 40 rows.
- Read a new environment variable in `src/**`: add its row to `docs/guide/environment-variables.md`; the check scans both directions, so a documented name no source reads (as `env.NAME`, `"NAME"`, or `$NAME`) also fails. The page must keep the sentence "The render trace takes a path, not `1`".
- Write a new entry under the state root via `clioStateDir()`, `clioStatePath()`, `stateDir`, `stateRoot`, `dirs.state`, or `resolveClioDirs().state`: add its name to `docs/architecture/artifact-placement.md` in the same commit (`state-root-inventory`).
- Resolve a new literal path from `resolvePackageRoot()` in `src/**`: ship it via the `files` allowlist in `package.json`, and if the release gate needs it, list it in `scripts/release-manifest.json`; bare root-only use is allowed only in `ROOT_ONLY_RESOLVERS` files (`src/core/running-build.ts`, `src/cli/components.ts`, `src/domains/lifecycle/install-method.ts`).
- Add a prompt fragment: create the Markdown file under `src/domains/prompts/fragments/**` with a unique id; docs named in `identity.self-awareness` must exist in the checkout and every bundled doc must be in the `context(scope="docs")` corpus (`listDocsCorpus` in `src/tools/context/docs-engine.ts`).

## Docs and prose

- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/**/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; the `documentation-links` check in `scripts/check-hygiene.ts` verifies targets, anchors, and cited paths.
- Source code, `TypeScript` types, and schemas are authoritative over prose; prefer `rg` and targeted source reads, and do not invent commands, configuration settings, or benchmark numbers (`CONTRIBUTING.md`).

## Git and release

- Work on a focused branch cut from the current version branch (e.g. `v062` for 0.6.2) and open the pull request against that branch; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Direct `npm publish` is blocked: `prepublishOnly` in `package.json` throws, so publication requires the approved `GitHub` release job.
- Install git hooks with `pnpm run hooks:install` (`node scripts/git-guard.mjs install`) so ignored paths are refused before they leave the machine.

## Gotchas

- Two tracked paths or module stems that differ only by case fail `case-portable-paths` in `scripts/check-hygiene.ts`; Linux CI never sees the collision, but extensionless imports resolve to the wrong file on case-insensitive filesystems.
- An `export` keyword on a function used only by its own file fails `export-hygiene` for the areas `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, and `src/domains`; drop the keyword rather than adding a use.
- `patches/`, `scripts/`, and `tests/` are checkout-only: the `packaging` check fails if the `package.json` `files` allowlist ships them, and gitignored generated state on the publish path also fails it.
- Nothing under `scripts/` or `src/` may join a literal onto the dev-checkout root that lands in a gitignored directory (`gitignored-reference`); use `resolvePackageRoot()` for installed-package paths instead.

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
