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
11. Never move a published tag, rebuild a qualified candidate, or republish different bytes: release artifacts are immutable and a partial publish is resumed from the original artifact (`CONTRIBUTING.md`).
12. Do not add tracked paths that differ only by case (files or module stems): they collide on case-insensitive filesystems and break extensionless imports; Linux CI never sees it, so the case-portable-paths check in `scripts/check-hygiene.ts` is the only guard.
13. Only the telemetry domain writes under the telemetry root; every other module goes through the telemetry writers (rule11), and the producer path from `src/core/telemetry/producer.ts` may not import persistence or do synchronous I/O (rule13).
14. Provider usage must never be mutated or put on a ledger payload: Clio accounting stays beside the raw usage and links the call journal (rule12 in `tests/boundaries/check-boundaries.ts`).
15. Do not run `npm publish` directly: `prepublishOnly` in `package.json` throws; publication happens only through the approved GitHub release job.
16. Never join a gitignored literal onto this checkout's own root in `scripts/` or `src/`: it works in your working copy but is absent on a fresh clone (gitignored-reference check, #84).
17. Do not restore retired HTML documentation: `docs/html/` must not exist, no Markdown may link into it, and `package.json` files must not ship `docs/html/**` (docs-source and prompts checks).

## Conventions

- `tsconfig.json` enables `exactOptionalPropertyTypes` (an optional property is omitted, never assigned `undefined`), `noUncheckedIndexedAccess` (an index access yields `T | undefined`), `noImplicitOverride` (an overriding member is marked `override`).
- Formatting is tabs, double quotes, trailing commas, 120 columns per `biome.json`; `pnpm run lint` runs `biome check .` plus `scripts/check-hygiene.ts`, so a biome-clean file can still fail the gate on hygiene rules.
- Money is formatted only in `src/core/telemetry/render.ts` via `renderPricing`, `renderUsdSum` or a DTO display; GUI browser code consumes server-rendered display strings (rule10).
- Token and cost figures in `src/interactive/**`, `src/engine/acp/**` and `src/cli/**` must be the read model's quantity displays, never fresh sums of token/cost fields, unless the function is named with a reason in `SURFACE_TOTAL_EXEMPTIONS` (rule14).
- Terminal colors live only under `src/interactive/theme/`: raw SGR escapes, `38;2;`/`38;5;` fragments and hex colors anywhere else in `src/interactive/**` fail the theme-discipline check in `scripts/check-hygiene.ts`.

## Change recipes

- Adding or changing a setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in `src/core/defaults.ts` together (the defaults-yaml check parses the YAML and deep-compares it to the object), add an inventory row for every new leaf path under `## Settings inventory` in `docs/guide/configuration-and-targets.md` with its default and an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, `restart`), and keep the section at 40+ rows.
- Adding a `CLIO_*` environment variable read in `src/`: add a row to `docs/guide/environment-variables.md`; removing a read requires deleting its row. The check scans both directions, so a comment naming a removed variable does not keep a row alive.
- Writing a new entry under the state root (`clioStateDir()`, `stateRoot`, etc.): name it in `docs/architecture/artifact-placement.md` or the state-root-inventory check fails.
- Resolving a new path from `resolvePackageRoot()` in `src/`: add that file or tree to the `files` allowlist in `package.json` (and to `scripts/release-manifest.json` if it is release-required); bare root-only use must be one of the files in `ROOT_ONLY_RESOLVERS`.
- Editing any `library/skills/<name>/SKILL.md`: rerun `pnpm run skills:pin` to regenerate `library/skills/registry.yaml`; adding or editing any curated package under `library/` requires `pnpm run library:pin`. Both `--check` modes fail CI on drift.
- Editing the README install steps: the npm block must install `@iowarp/clio-coder`, and the From-source block must keep the exact `export PATH=` line `scripts/install-local.sh` prints, a `--version` verification by installed path after that export, and a clone pinned to the current version branch; the Get started section must ask `command -v clio-coder`.

## Tests

- Ordinary CI runs only the explicit file lists in `scripts/ci-tests.mjs`: core is 25 named files in `tests/contracts/`, gui is 8 named files in `tests/` run from `apps/clio-coder-gui`, package is two files in `tests/smoke/`. A new regression test must be added to the matching list there or CI will not run it.
- `pnpm run test:full` and `pnpm run test:package` are broader investigation commands, not part of ordinary CI; use them when a change touches behavior outside the core lists.
- Run single files with `pnpm run test:file -- tests/contracts/<name>.test.ts`; it preloads `tests/harness/tmp-root.ts`, and state isolation comes from `tests/harness/scratch-env.ts`. Never mutate `process.stdout.write` across async test boundaries.

## Docs and prose

- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/**/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; the documentation-links check fails on a missing target, anchor, or cited path.
- Project state paths use the `clio-coder` namespace: `.clio` (without `-coder`) is banned in tracked text files by the product-namespace check, except `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, and `.github/releases/` which quote the old names.
- New Markdown docs must be reachable by the docs corpus: the prompts check fails if a file under `docs/` (outside `docs/html/` and `docs/wiki/`) is missing from the `context(scope="docs")` corpus or vice versa.

## Git and release

- Work on a focused branch cut from the current version branch (e.g. `v062` for 0.6.2) and open the pull request against it; `main` moves only by fast-forward when a stable release completes.
- Publish order is npm first, then the GitHub tag/release, then promote `main` and `gh-pages`; there is no atomic transaction across services, so resume a partial failure with the original artifact.
- The `release` environment in `.github/workflows/release.yml` requires the owner as reviewer; agents must leave npm publish and that approval to the owner. Preserve the required check names `ci (22)` and `ci (24)`.

## Gotchas

- Keep CLI subcommands dynamically imported to preserve fast `--help` and startup (`CONTRIBUTING.md`).
- A function used only by its own file must not carry the `export` keyword: export-hygiene sweeps `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, and `src/domains`.
- An entry in `SURFACE_TOTAL_EXEMPTIONS` that no longer matches a token/cost fold fails the boundary check; the list only shrinks, so remove stale exemptions.

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
