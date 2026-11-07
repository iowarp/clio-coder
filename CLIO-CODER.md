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
18. Never commit or push a path that `.gitignore` excludes: `scripts/git-guard.mjs` refuses the commit/push and check-hygiene's tracked-ignored rule fails; unstage with `git rm --cached <path>`.
19. Do not move a published tag, rebuild a published candidate, or republish different bytes (`CONTRIBUTING.md`); publish order is npm first, then the GitHub tag/release, then promote `main` and `gh-pages`, resuming a partial failure from the original artifact.
20. Provider usage in message/ledger payloads is immutable outside `src/engine/**`: rule12 in `tests/boundaries/check-boundaries.ts` forbids mutating it or putting usage-shaped fields on ledger payloads; keep Clio accounting beside the raw usage and link the call journal.

## Conventions

- `tsconfig.json` enables `noImplicitOverride` (an overriding member is marked `override`).
- Formatting is tabs, double quotes, trailing commas, 120 columns per `biome.json`; `pnpm run lint` runs `biome check .` plus `scripts/check-hygiene.ts`, so a formatting-only diff still fails the gate.
- TypeScript is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and `noUnusedLocals` in `tsconfig.json`; index access returns `T | undefined` and optional properties must not be assigned `undefined` explicitly.
- Terminal colors live in `src/interactive/theme/`: raw SGR escapes, `38;2;`-style fragments and hex colors anywhere else under `src/interactive/**` fail the theme-discipline check in `scripts/check-hygiene.ts`.
- Money is formatted only through `renderPricing`, `renderUsdSum` or a DTO display in `src/core/telemetry/render.ts` (rule10); GUI code consumes server-rendered display strings.

## Change recipes

- Adding or changing a setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in `src/core/defaults.ts` together (the defaults-yaml check parses the YAML and deep-compares it to the object), add an inventory row for every new leaf path under `## Settings inventory` in `docs/guide/configuration-and-targets.md` with its default and an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, `restart`), and keep the section at 40+ rows.
- Writing a new entry under the state root (`clioStateDir()`, `stateRoot`, etc.): name it in `docs/architecture/artifact-placement.md` or the state-root-inventory check fails.
- New setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in `src/core/defaults.ts`, add a row with default value and effect timing to the `## Settings inventory` section of `docs/guide/configuration-and-targets.md`; if it reads an env var, also add a row to `docs/guide/environment-variables.md`.
- New runtime resource resolved from the installed package root: add the path to the `files` allowlist in `package.json` and to `requiredFiles`/`requiredPrefixes` in `scripts/release-manifest.json`; `checkPackaging` in `scripts/check-hygiene.ts` cross-checks both against every `resolvePackageRoot()` join in `src/**`, and a bare root use must be listed in `ROOT_ONLY_RESOLVERS`.
- New state-root entry: write the file under the state root, then name the entry in `docs/architecture/artifact-placement.md` (state-root-inventory).
- New skill or library payload: re-pin with `pnpm run skills:pin` / `pnpm run library:pin`; check-hygiene's library-pin rule runs `scripts/pin-library.ts --check` against `library/registry.yaml`.

## Tests

- Ordinary development checks are the explicit lists in `scripts/ci-tests.mjs`: `pnpm run test` runs only the named `tests/contracts/*.test.ts` core files, and `pnpm run test:gui` runs the named GUI tests. A new regression test must be added to the matching list in `scripts/ci-tests.mjs` or it will not run; `pnpm run test:list` shows which `tests/contracts` files are omitted from the default tier.
- `test:full`, `test:package` and `tests/extended/**` are full-investigation tiers, not part of the ordinary core list; `tests/contracts/instant-shell-import-graph.test.ts` (package tier) only fails after a full build because it walks built chunks.
- Use `pnpm run test:file -- <paths>` for single files; it preloads `tests/harness/tmp-root.ts`, and `tests/harness/scratch-env.ts` provides state isolation (unverified: `tests/harness/scratch-env.ts` is not preloaded by a package script). Never mutate `process.stdout.write` across async test boundaries (`CONTRIBUTING.md`).

## Git and release

- Work on a focused branch cut from the current version branch (e.g. `v062`) and open the pull request against it; `main` moves only when a release ships (`CONTRIBUTING.md`).
- Install git hooks with `pnpm run hooks:install` so `scripts/git-guard.mjs` blocks ignored paths before they leave the machine.
- Publication is the approved GitHub release job only: `prepublishOnly` in `package.json` throws, and agents must leave npm publish and its approval to that job (`CONTRIBUTING.md`).

## Docs and prose

- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/**/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; the documentation-links check fails on a missing target, anchor, or cited path.
- Project state paths use the `clio-coder` namespace: `.clio` (without `-coder`) is banned in tracked text files by the product-namespace check, except `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, and `.github/releases/` which quote the old names.
- New Markdown docs must be reachable by the docs corpus: the prompts check fails if a file under `docs/` (outside `docs/html/` and `docs/wiki/`) is missing from the `context(scope="docs")` corpus or vice versa.
- Links in `docs/**`, `README.md` and `CONTRIBUTING.md` are checked by check-hygiene's documentation-links rule: targets must exist, heading anchors must match the slugified heading, and backticked `src/`, `tests/`, `scripts/`, `apps/` paths must resolve in the checkout.
- The README `## Get started` block is held to `scripts/install-local.sh`: it must contain the installer's exact `export PATH="<bin_dir>:$PATH"` line, verify with the installed launcher by path (not bare `clio-coder --version`), and clone with `--branch v<installable version>`; the npm block must install `@iowarp/clio-coder`.
- Retired HTML documentation must not return: no `docs/html/` directory, no links to it from Markdown, and no `docs/html/**` in the package `files` (docs-source and prompts rules).

## Gotchas

- A function used only by its own file must not carry the `export` keyword: export-hygiene sweeps `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, and `src/domains`.
- Export hygiene: a function used only by the file that declares it must not carry the `export` keyword; check-hygiene sweeps `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, `src/domains` and fails on dead exports.
- Scripts under `scripts/**` and `src/**` must not join a gitignored literal onto the checkout root (the `fileURLToPath(new URL(..., import.meta.url))` idiom): it works in your working copy but throws ENOENT on a fresh clone (gitignored-reference).
- `biome.json` excludes `apps/clio-coder-gui`, `.claude`, `.clio-coder` and `dist`; GUI code is checked by its own workspace scripts (`pnpm run check:gui`).

## Checker-enforced invariants

Rules the project's checks declare that the rules above do not state, each in its checker's words. A change that breaks one fails that check.
- `src/interactive/**`, `src/engine/acp/**` and `src/cli/**` sum no token or cost field: their figures are the read model's quantity displays, except the functions `SURFACE_TOTAL_EXEMPTIONS` names with a reason. Checked as `rule14` by `tests/boundaries/check-boundaries.ts`.

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
