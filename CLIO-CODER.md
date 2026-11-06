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
10. Never commit or push a path that `.gitignore` excludes: `scripts/git-guard.mjs` refuses it locally and `tracked-ignored` in `scripts/check-hygiene.ts` fails CI; unstage with `git rm --cached <path>` (agent plans under an ignored dir reached public history this way, purged in 0.5.9).
11. Never move a published tag, rebuild a qualified candidate, or republish different bytes; publish order is npm first, then the GitHub tag/release, then promote `main` and `gh-pages`, resuming a partial failure with the original artifact (`CONTRIBUTING.md`).
12. Only the telemetry domain writes under the telemetry root; every other module goes through the telemetry writers, and the producer path imports no persistence or synchronous I/O (rules 11 and 13 in `tests/boundaries/check-boundaries.ts`).
13. Format money only through `src/core/telemetry/render.ts` (`renderPricing`, `renderUsdSum` or a DTO display); rule10 fails any other monetary formatting, and surfaces under `src/interactive/`, `src/engine/acp/`, `src/cli/` must not sum token or cost fields (rule14).
14. Provider usage in message/ledger payloads is immutable outside `src/engine/**`: keep Clio accounting beside the raw usage and link the call journal; the ledger is the conversation record, the call journal owns usage (rule12, `tests/boundaries/check-boundaries.ts`).
15. CI workflows must stay `workflow_dispatch`-only with read-only contents permissions; only the approved release job may write contents or mint publishing identity, and gate jobs must propagate failures (`checkCiScripts` in `scripts/check-hygiene.ts`).

## Conventions

- `tsconfig.json` enables `noImplicitOverride` (an overriding member is marked `override`).
- Formatting is tabs, double quotes, trailing commas, 120 columns per `biome.json`; `pnpm run lint` runs `biome check .` plus `scripts/check-hygiene.ts`, so a style-only diff still fails CI.
- Project state paths must use the `clio-coder` namespace; `checkProductNamespace` in `scripts/check-hygiene.ts` fails on any legacy `.clio` path form in tracked or new text files (excluding `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, `.github/releases/`).
- No raw SGR escapes, SGR color fragments (`38;2;`, `48;5;`) or hex colors outside `src/interactive/theme/`; `checkThemeDiscipline` in `scripts/check-hygiene.ts` scans every other `src/interactive/**` file.
- Do not add tracked paths that differ only by case, including module stems like `approval.ts` vs `Approval.tsx`; `checkCasePortablePaths` fails because extensionless imports resolve to the wrong file on case-insensitive filesystems.
- Tests use `pnpm test:file` (which preloads `tests/harness/tmp-root.ts`) and `tests/harness/scratch-env.ts` for state isolation, and never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`).
- Keep CLI subcommands dynamically imported to preserve fast `--help` and startup (`CONTRIBUTING.md`); dynamic imports are followed by the Stage 0 closure in `tests/boundaries/check-boundaries.ts`, so a static import of a subcommand module changes the cold-start chunk graph.
- Docs links must resolve: `checkDocumentationLinks` in `scripts/check-hygiene.ts` verifies every markdown/HTML target, heading anchor, and backticked `src|tests|scripts|apps` path cited in `docs/**`, `README.md`, `CONTRIBUTING.md`.

## Change recipes

- Adding or changing a setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` together in `src/core/defaults.ts` (the YAML must parse to exactly the object, `checkDefaultsYaml`), add or edit its row in the `## Settings inventory` section of `docs/guide/configuration-and-targets.md` with the exact default and an effect timing (`immediately`, `next turn`, `next session`, `next dispatch`, or `restart`; `checkSettingsInventory`).
- Adding a `CLIO_*` environment variable read in `src/**`: add its row to `docs/guide/environment-variables.md`; removing a read requires removing the row too, since `checkEnvironmentVariableInventory` fails in both directions (a comment naming a removed variable does not keep a row alive).
- Writing a new entry under the state root via `clioStateDir()`, `stateRoot`, or `resolveClioDirs().state`: name that entry in `docs/architecture/artifact-placement.md` (`checkStateRootInventory`).
- Resolving a new file from the installed package root with `resolvePackageRoot()` in `src/**`: add the path to the `files` allowlist in `package.json` (or to `scripts/release-manifest.json` if it is release-gate required); `checkPackaging` reads every literal join off the package root and fails on unshipped paths, and a bare root use must be in `ROOT_ONLY_RESOLVERS`.
- Adding a prompt fragment: register it via `loadFragments` so `identity.self-awareness` and `identity.docs-routing` resolve (`checkPromptsDocLinks`); any doc named in `identity.self-awareness` must exist, ship under `docs/**/*.md`, and be in the `context(scope="docs")` corpus.

## Tests

- `pnpm run test:full` covers all of `tests/contracts`, `tests/extended`, `tests/smoke` and `tests/extended-smoke`; use it for investigation, not as the CI gate. `pnpm run test:list` prints which files are default versus full-investigation-only.

## Git and release

- Work on a focused branch cut from the current version branch (e.g. `v062`) and open the pull request against that branch; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Publication is owner-approved: agents must leave the npm publish and the `release` environment approval to the owner, and never grant an App blanket bypass of published-tag immutability (`CONTRIBUTING.md`).

## Gotchas

- Do not join a gitignored literal onto this checkout's own root in `scripts/**` or `src/**` (the `fileURLToPath(new URL(..., import.meta.url))` idiom); it works in your working copy and throws ENOENT on a fresh clone (`gitignored-reference`, `scripts/check-hygiene.ts`).
- `patches/`, `scripts/` and `tests/` are checkout-only: the `package.json` allowlist must not ship them, and gitignored generated state on the publish path fails `checkPackaging`.
- Do not add a function-level `export` in `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive` or `src/domains` unless used by more than one file; `checkExportHygiene` fails on exports referenced only by their declaring file.
- Retired HTML documentation must not return: no `docs/html/` directory, no links to it from any `docs/**.md`, and no `docs/html/**` in the package (`checkDocsSource`, `checkPromptsDocLinks`).
- The README's Get started install block is checked against `scripts/install-local.sh`: the npm block must install the package named in `package.json`, verify with the launcher path from the installer's default bin dir, and ask which file the bare name reaches via `command -v clio-coder` (`checkReadmeInstallBlock`).

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
