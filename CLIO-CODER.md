# Clio Coder

Clio Coder is a TypeScript/Node.js project. It is an open-source coding agent for scientific software, in your terminal, in headless runs, over ACP and in the browser: your models, bounded workers, and inspectable evidence.

## Hard invariants

1. Only `src/engine/**` may import `@earendil-works/pi-*` at all. Since the 0.83.0 engine-boundary rework there is no type-only exception either: domains take erased engine shapes from `src/engine/types.ts`. Checked as `rule1` by `tests/boundaries/check-boundaries.ts`.
2. `src/worker/**` never value-imports `src/domains/**` EXCEPT the worker-safe provider runtime registry, builtin descriptors, and plugin loader used to rehydrate runtime descriptors from stdin. Type-only imports are allowed because they erase at compile time. Checked as `rule2` by `tests/boundaries/check-boundaries.ts`.
3. `src/domains/<x>` never imports `src/domains/<y>/extension.ts` for y != x. Checked as `rule3` by `tests/boundaries/check-boundaries.ts`.
4. `src/tools/**` never imports `src/interactive/**`. The tool substrate is surface-agnostic: headless, interactive, ACP, and worker runs share it, so a tool reaching into TUI code would make one surface's presentation a dependency of every surface's execution. Checked as `rule4` by `tests/boundaries/check-boundaries.ts`.
5. The chat loop's turn modules (`src/session-control/turn-*.ts`, `chat-loop.ts`) never import `src/entry/**`. Composition flows one way: the entry point composes the loop, never the reverse. Checked as `rule5` by `tests/boundaries/check-boundaries.ts`.
6. Any value importer outside the computed Stage 0 closure and its `src/interactive/**`, `src/session-control/**` and `src/engine/**` trees reaches those trees only through a declared seam in `STAGE0_SEAMS`. A seam may not lead back into Stage 0 unless that existing composition-root overlap is explicitly declared. CLI type edges retain the older declaration requirement. Both halves protect the instant shell's cold-start chunk graph, pinned by `tests/contracts/instant-shell-import-graph.test.ts`. Checked as `rule6` by `tests/boundaries/check-boundaries.ts`.
7. `src/domains/turn-control/**` imports no interactive, engine, tools or worker modules, and reaches other domains only through `index.ts`. Checked as `rule7` by `tests/boundaries/check-boundaries.ts`.
8. `src/session-control/**` never imports `src/interactive/**`, type-only included. It is the one session contract the TUI, headless run and the ACP server all call, so a render module in its graph would make the terminal a dependency of every surface. Checked as `rule8` by `tests/boundaries/check-boundaries.ts`.
9. `src/engine/**` never imports `src/interactive/**`, type-only included. The ACP server reaches session behavior through `src/session-control`. Checked as `rule9` by `tests/boundaries/check-boundaries.ts`.
10. Never commit or push a path that `.gitignore` excludes: `scripts/git-guard.mjs` refuses it locally and the tracked-ignored check fails CI; agents once shipped private plans this way (purged in 0.5.9). Unstage with `git rm --cached <path>`.
11. Do not add tracked paths that differ only by case (files or module stems): they collide on case-insensitive filesystems and break extensionless imports; Linux CI never sees it, so the case-portable-paths check in `scripts/check-hygiene.ts` is the only guard.
12. Only the telemetry domain writes under the telemetry root; every other module goes through the telemetry writers (rule11), and the producer path from `src/core/telemetry/producer.ts` may not import persistence or do synchronous I/O (rule13).
13. Provider usage must never be mutated or put on a ledger payload: Clio accounting stays beside the raw usage and links the call journal (rule12 in `tests/boundaries/check-boundaries.ts`).
14. Do not run `npm publish` directly: `prepublishOnly` in `package.json` throws; publication happens only through the approved GitHub release job.
15. Never join a gitignored literal onto this checkout's own root in `scripts/` or `src/`: it works in your working copy but is absent on a fresh clone (gitignored-reference check, #84).
16. Do not restore retired HTML documentation: `docs/html/` must not exist, no Markdown may link into it, and `package.json` files must not ship `docs/html/**` (docs-source and prompts checks).
17. Never move a published tag, rebuild a previously qualified candidate, or republish different bytes (`CONTRIBUTING.md`); publish order is npm first, then the GitHub tag/release, then promote `main` and `gh-pages`, resuming a partial failure from the original artifact.
18. Do not add `continue-on-error`, `--ignore-scripts`, or unpinned `uses:` to `.github/workflows/ci.yml` or `release.yml`; keep job names `ci (22)` and `ci (24)`, both consuming one prepared package, per check-hygiene's ci-scripts rule.
19. Do not write under the telemetry root outside `src/domains/telemetry/` (rule11), import persistence or do synchronous I/O on the telemetry producer path (rule13), or mutate provider usage / put usage-shaped keys on ledger payloads outside `src/engine/` (rule12) in `tests/boundaries/check-boundaries.ts`.
20. Never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`); use `pnpm run test:file` with the preloaded `tests/harness/tmp-root.ts` and `tests/harness/scratch-env.ts` for state isolation.

## Conventions

- `tsconfig.json` enables `exactOptionalPropertyTypes` (an optional property is omitted, never assigned `undefined`), `noUncheckedIndexedAccess` (an index access yields `T | undefined`), `noImplicitOverride` (an overriding member is marked `override`).
- Formatting is tabs, double quotes, trailing commas, 120 columns per `biome.json`; `pnpm run lint` runs `biome check .` plus `scripts/check-hygiene.ts`, so a style-only diff still fails CI.
- Money is rendered only by `renderPricing`/`renderUsdSum` in `src/core/telemetry/render.ts`; any other `$`-prefixed template, `toFixed` on a cost-like value, or `style: "currency"` outside that file fails rule10.
- Surfaces under `src/interactive/`, `src/engine/acp/`, and `src/cli/` must not sum token or cost fields (rule14); show the read model's quantity display instead, or add a reasoned entry to `SURFACE_TOTAL_EXEMPTIONS` in `tests/boundaries/check-boundaries.ts`.
- Terminal colors live only under `src/interactive/theme/`: raw SGR escapes, `38;2;`-style fragments, and hex colors anywhere else in `src/interactive/**` fail the theme-discipline check in `scripts/check-hygiene.ts`.
- Project state paths use the `clio-coder` namespace; a bare `.clio` path or directory name fails product-namespace in `scripts/check-hygiene.ts` (only `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, and `.github/releases/` may quote the old names).
- Keep CLI subcommands dynamically imported so `--help` and startup stay fast, per `CONTRIBUTING.md`; the instant-shell Stage 0 closure is pinned to 32 chunks / 1,400,000 total bytes by `tests/contracts/instant-shell-import-graph.test.ts`, which only fails after a full build.

## Change recipes

- Adding or changing a setting key: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` together in `src/core/defaults.ts` (they must deep-equal, defaults-yaml check), add a row to the `## Settings inventory` table in `docs/guide/configuration-and-targets.md` with its default and an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, or `restart`), and keep the table at 40+ rows.
- Adding a `CLIO_*` environment variable read in `src/`: document it in `docs/guide/environment-variables.md`; removing a read requires deleting its row. The page must keep the sentence "The render trace takes a path, not `1`".
- Writing a new entry under the state root via `clioStateDir()`/`stateRoot` joins: name that entry in `docs/architecture/artifact-placement.md` (state-root-inventory check).
- Adding a runtime resource resolved from the installed package root with `resolvePackageRoot()`: add it to the `files` allowlist in `package.json`, or record why the bare root is the resource in `ROOT_ONLY_RESOLVERS` in `scripts/check-hygiene.ts`; `scripts/check-release.mjs` must keep reading the shared `release-manifest.json`.
- Adding a new doc page: it must land in the `context(scope="docs")` corpus (`listDocsCorpus` in `src/tools/context/docs-engine.ts`) or the prompts check fails; never link to retired HTML docs (`docs-source`).

## Tests

- A regression test for ordinary CI must be added to the `coreTests` list in `scripts/ci-tests.mjs` as `tests/contracts/<name>.test.ts`; files dropped from that list still exist but are "full investigation only" and never run in qualification.
- GUI regressions go in `apps/clio-coder-gui/tests/` and must be added to the `guiTests` list in `scripts/ci-tests.mjs` (paths written as `tests/<name>.test.ts` relative to that package).
- Use `pnpm run test:file -- <files>` for a single file; it preloads `tests/harness/tmp-root.ts`, which redirects state into a private temp root.

## Git and release

- Work on a focused branch (`fix/session-resume`, `feat/cli-inspect`) cut from the current version branch (e.g. `v062` for 0.6.2) and open the PR against that branch; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Qualification is a manual `ci.yml` dispatch with the exact candidate `sha` (must be the branch head); rehearsal writes are allowed only on `ci-scratch-*` branches. Release reuses that qualification run's artifact and never installs, builds, or tests again.
- Agents must leave npm publish and the owner approval gate to humans (`CONTRIBUTING.md`); do not claim a prerelease is verified by `npm publish --dry-run`, since its bytes exist only inside the candidate.

## Gotchas

- `tsconfig.json` maps `@iowarp/clio-coder/extensions` to `src/domains/extensions/public-api.ts` and `@iowarp/clio-coder/extensions/testing` to `src/domains/extensions/authoring/test-api.ts`, so the checkout type-checks against source without a build; do not import those specifiers from inside `src/`.
- `scripts/check-hygiene.ts` documentation-links also validates backticked `src/`, `tests/`, `scripts/`, and `apps/` paths in `docs/**.md`, `README.md`, and `CONTRIBUTING.md`; a cited path that does not exist fails CI even when the prose is correct.
- A function used only by its own file must not carry the `export` keyword: export-hygiene sweeps `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, and `src/domains`.

## Docs and prose

- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/**/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; the documentation-links check fails on a missing target, anchor, or cited path.
- New Markdown docs must be reachable by the docs corpus: the prompts check fails if a file under `docs/` (outside `docs/html/` and `docs/wiki/`) is missing from the `context(scope="docs")` corpus or vice versa.

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
