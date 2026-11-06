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
17. Do not add `continue-on-error`, `--ignore-scripts`, or unpinned `uses:` to `.github/workflows/ci.yml` or `release.yml`; keep job names `ci (22)` and `ci (24)`, both consuming one prepared package, per check-hygiene's ci-scripts rule.
18. Do not write under the telemetry root outside `src/domains/telemetry/` (rule11), import persistence or do synchronous I/O on the telemetry producer path (rule13), or mutate provider usage / put usage-shaped keys on ledger payloads outside `src/engine/` (rule12) in `tests/boundaries/check-boundaries.ts`.
19. Publication is one-way: never move a published tag, rebuild a qualified candidate, or republish different bytes (`CONTRIBUTING.md`); publish npm first, then the GitHub tag/release, then promote `main` and `gh-pages`, resuming a partial failure with the original artifact.
20. Provider usage inside message/ledger payloads is immutable outside `src/engine/**`: keep Clio accounting beside the raw usage and link the call journal; the ledger is the conversation record, the call journal owns usage (rule12 in `tests/boundaries/check-boundaries.ts`).

## Conventions

- `tsconfig.json` enables `noImplicitOverride` (an overriding member is marked `override`).
- Formatting is tabs, double quotes, trailing commas, 120 columns per `biome.json`; `pnpm run lint` runs `biome check .` plus `scripts/check-hygiene.ts`, so a style-only diff still fails the gate.
- TypeScript is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noUnusedLocals` in `tsconfig.json`; index access returns `T | undefined` and unused locals are compile errors, not warnings.
- `src/interactive/**` outside `theme/` carries no raw SGR escapes, `38;2;`/`48;5;` fragments or hex colors (`scripts/check-hygiene.ts` theme-discipline); take colors from the theme module.
- Project state paths use the `clio-coder` namespace: a `.clio` path (not followed by `coder`) in any tracked text file fails product-namespace in `scripts/check-hygiene.ts`; only `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/` and `.github/releases/` may quote the old name.
- Tracked paths must not differ only by case, including module stems (`approval.ts` vs `Approval.tsx`), because extensionless imports resolve to the wrong file on case-insensitive filesystems (case-portable-paths in `scripts/check-hygiene.ts`).
- An `export function` used only by its own file fails export-hygiene in `scripts/check-hygiene.ts`; drop the keyword when a helper is local.
- Markdown links and backticked `src/`, `tests/`, `scripts/`, `apps/` paths in `docs/**`, `README.md` and `CONTRIBUTING.md` must resolve to real files and heading anchors (documentation-links in `scripts/check-hygiene.ts`).

## Change recipes

- Add or change a setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` together in `src/core/defaults.ts` (the YAML must parse to exactly the object, defaults-yaml), add or edit the row for the dotted path in the `## Settings inventory` section of `docs/guide/configuration-and-targets.md` with its default value and an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, `restart`), and keep the inventory at least 40 rows (settings-inventory in `scripts/check-hygiene.ts`).
- Read a new `CLIO_*` environment variable from `src/`: add its row to `docs/guide/environment-variables.md`; when you remove the last read, delete the row. The page must keep the sentence "The render trace takes a path, not `1`" (environment-variable-inventory in `scripts/check-hygiene.ts`).
- Write a new entry under the state root via `clioStateDir()`, `stateRoot` or `resolveClioDirs().state`: name that entry in `docs/architecture/artifact-placement.md` (state-root-inventory in `scripts/check-hygiene.ts`).
- Add a file the installed package resolves from its root: add it to `files` in `package.json` and, if the release gate needs it, to `scripts/release-manifest.json`; never ship gitignored generated state (packaging in `scripts/check-hygiene.ts`).
- Change the README install steps or `scripts/install-local.sh`: keep the npm block installing the package from `package.json`, cloning with `--branch v<installable version>`, verifying by the installer's bin-dir path, and asking `command -v clio-coder` (readme-install-block in `scripts/check-hygiene.ts`).
- Adding a new doc page: it must land in the `context(scope="docs")` corpus (`listDocsCorpus` in `src/tools/context/docs-engine.ts`) or the prompts check fails; never link to retired HTML docs (`docs-source`).

## Tests

- Run a single file with `pnpm run test:file -- tests/contracts/<name>.test.ts`; it preloads `tests/harness/tmp-root.ts` for state isolation, and use `tests/harness/scratch-env.ts` for environment isolation (`CONTRIBUTING.md`) (unverified: `tests/harness/scratch-env.ts` is not preloaded by a package script).
- Never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`).

## Git and release

- Work on a focused branch cut from the current version branch (e.g. `v062`) and open the pull request against it; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Qualification is a manual `ci.yml` dispatch with the exact candidate sha; `release.yml` reuses that qualification run's artifact without installing, building or testing, and its release job needs the protected `release` environment with owner approval (`CONTRIBUTING.md`, `.github/workflows/release.yml`).
- Agents must leave npm publish and the release approval to the owner (`CONTRIBUTING.md`); `prepublishOnly` in `package.json` throws for direct `npm publish`.

## Gotchas

- A function used only by its own file must not carry the `export` keyword: export-hygiene sweeps `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, and `src/domains`.

## Docs and prose

- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/**/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; the documentation-links check fails on a missing target, anchor, or cited path.
- New Markdown docs must be reachable by the docs corpus: the prompts check fails if a file under `docs/` (outside `docs/html/` and `docs/wiki/`) is missing from the `context(scope="docs")` corpus or vice versa.

## Checker-enforced invariants

Rules the project's checks declare that the rules above do not state, each in its checker's words. A change that breaks one fails that check.
- Root and GUI monetary display uses core/telemetry/render.ts; browser code consumes display strings rendered by the server. Checked as `rule10` by `tests/boundaries/check-boundaries.ts`.
- `src/interactive/**`, `src/engine/acp/**` and `src/cli/**` sum no token or cost field: their figures are the read model's quantity displays, except the functions `SURFACE_TOTAL_EXEMPTIONS` names with a reason. Checked as `rule14` by `tests/boundaries/check-boundaries.ts`.

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
