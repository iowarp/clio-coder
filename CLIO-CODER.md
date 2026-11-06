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
18. Keep `.github/workflows/ci.yml` and `.github/workflows/release.yml` dispatch-only with read-only contents, SHA-pinned actions, no `continue-on-error`, and job names `ci (22)` / `ci (24)`: `checkCiScripts` in `scripts/check-hygiene.ts` encodes the branch-protection contract.
19. Do not join a gitignored literal onto this checkout's own root (`import.meta.url`-anchored) in `scripts/` or `src/`: it is absent on a fresh clone and fails `gitignored-reference` in `scripts/check-hygiene.ts`; use `resolvePackageRoot()` for installed-package resources.
20. Telemetry: only the telemetry domain writes under the telemetry root (rule11), the producer path never imports persistence or does synchronous I/O (rule13), money is formatted only through `renderPricing`/`renderUsdSum` in `src/core/telemetry/render.ts` (rule10), and surfaces show the read model's quantity display instead of summing token/cost fields (rule14, exemptions in `SURFACE_TOTAL_EXEMPTIONS`).

## Conventions

- `biome.json` formats with tabs, double quotes, trailing commas, 120-column lines; `apps/clio-coder-gui` is excluded from the root Biome config, so run `pnpm run check:gui` for GUI code.
- `tsconfig.json` enables `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `noImplicitOverride`; type-check with `pnpm run typecheck` (`tsc -p tsconfig.tests.json`).
- Keep CLI subcommands dynamically imported to preserve fast `--help` and startup (`CONTRIBUTING.md`).
- Terminal colors live in `src/interactive/theme`: no raw SGR escapes, `38;2;`/`48;5;` fragments, or hex colors anywhere else under `src/interactive` (`theme-discipline` in `scripts/check-hygiene.ts`).
- Project state paths use the `clio-coder` namespace; the legacy `.clio` form fails `product-namespace` in `scripts/check-hygiene.ts` (exempt: `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, `.github/releases/`).

## Change recipes

- Change a settings default: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` together in `src/core/defaults.ts` (the `defaults-yaml` check requires the YAML to parse to exactly the object), add or update the row for that path in the `## Settings inventory` section of `docs/guide/configuration-and-targets.md` with its default value and an effect timing (`immediately`, `next turn`, `next session`, `next dispatch`, or `restart`), and if a new `CLIO_*` variable is read, add it to `docs/guide/environment-variables.md`.
- Add a state-root entry under the Clio state directory in `src/`: name the entry in `docs/architecture/artifact-placement.md` (`state-root-inventory` in `scripts/check-hygiene.ts`).
- Ship a new runtime resource: add it to the `files` allowlist in `package.json` and to `requiredFiles`/`requiredPrefixes` in `scripts/release-manifest.json`; `checkPackaging` cross-checks both against every `resolvePackageRoot()` join in `src/`, and `patches/`, `scripts/`, `tests/` must stay checkout-only.
- Add a bundled doc: create the Markdown under `docs/` (never `docs/html/`), keep `docs/**/*.md` in `package.json` `files`, and make sure it lands in the `context(scope="docs")` corpus (`prompts` check in `scripts/check-hygiene.ts`).
- Add a skill or library payload: re-pin with `pnpm run skills:pin` / `pnpm run library:pin`; `library/registry.yaml` pins must match repository content (`library-pin` check).
- Adding or changing a setting: update `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in `src/core/defaults.ts` together (the defaults-yaml check parses the YAML and deep-compares it to the object), add an inventory row for every new leaf path under `## Settings inventory` in `docs/guide/configuration-and-targets.md` with its default and an effect timing word (`immediately`, `next turn`, `next session`, `next dispatch`, `restart`), and keep the section at 40+ rows.
- Writing a new entry under the state root (`clioStateDir()`, `stateRoot`, etc.): name it in `docs/architecture/artifact-placement.md` or the state-root-inventory check fails.

## Tests

- Ordinary CI runs the explicit file lists in `scripts/ci-tests.mjs`: core is a fixed set of `tests/contracts/*.test.ts`, gui is a fixed set under `apps/clio-coder-gui/tests/` (React-rendering checks are `.tsx`), and package is `tests/smoke/installed-package.test.ts` plus `tests/smoke/native-call-timing.test.ts`. A new regression test must be added to the matching list in `scripts/ci-tests.mjs` or CI will not run it; other files in `tests/contracts/`, `tests/extended/`, and `tests/smoke/` are full-investigation only (`pnpm run test:full`).
- Run one file with `pnpm run test:file -- tests/contracts/<name>.test.ts`; the script preloads `tests/harness/tmp-root.ts` for state isolation, and `tests/harness/scratch-env.ts` is available for more (unverified: `tests/harness/scratch-env.ts` is not preloaded by a package script).
- `scripts/check-dist.mjs` (pretest gate) builds a missing `dist/` but refuses a `dist/` built from another commit; do not silently rebuild before binary-driven tests.

## Docs and prose

- Every relative link, heading anchor, and backticked `src/`, `tests/`, `scripts/`, or `apps/` path in `docs/*.md`, `README.md`, and `CONTRIBUTING.md` must resolve; `documentation-links` in `scripts/check-hygiene.ts` checks all three files.
- `docs/guide/environment-variables.md` is bidirectional: every `CLIO_*` variable read in `src/` (as `env.NAME`, a quoted name, or `$NAME` in generated shell) needs a row, and every backticked variable on the page must still be read; comment lines do not count as reads.
- The README `## Get started` block is checked against `scripts/install-local.sh`: it must install the package from npm, clone with the pinned version branch, verify via the installer's bin dir path, and ask `command -v clio-coder` (`readme-install-block`).
- Project state paths use the `clio-coder` namespace: `.clio` (without `-coder`) is banned in tracked text files by the product-namespace check, except `CHANGELOG.md`, `CLIO-CODER.md`, `docs/history/`, and `.github/releases/` which quote the old names.
- New Markdown docs must be reachable by the docs corpus: the prompts check fails if a file under `docs/` (outside `docs/html/` and `docs/wiki/`) is missing from the `context(scope="docs")` corpus or vice versa.

## Git and release

- Work on a focused branch cut from the current version branch (e.g. `v062`) and open the pull request against it; `main` moves only by fast-forward when a stable release completes (`CONTRIBUTING.md`).
- Publish order is npm first, then the GitHub tag/release, then promote `main` and `gh-pages`; there is no atomic transaction, so resume a partial failure with the original artifact.
- Agents must leave npm publish and the owner approval of the `release` environment to humans (`CONTRIBUTING.md`).

## Gotchas

- `export-hygiene` fails on an `export` keyword for a function used only by its own file; drop the keyword rather than adding a consumer.
- `scripts/check-release.mjs` must keep reading `scripts/release-manifest.json` rather than its own copy (`checkPackaging` asserts this).
- The render-trace env var takes a path, not `1`; that exception sentence must stay in `docs/guide/environment-variables.md`.
- A function used only by its own file must not carry the `export` keyword: export-hygiene sweeps `src/entry`, `src/cli`, `src/core`, `src/engine`, `src/tools`, `src/interactive`, and `src/domains`.

## Verification expectations

Available static checks: `pnpm run typecheck`, `pnpm run lint`. Build command: `pnpm run build`; rebuild when the selected validation consumes compiled output. Declared test command: `pnpm run test`. Exact package.json#scripts.test: `node scripts/ci-tests.mjs core`. Other test scripts have separate selection; follow CI calls before claiming coverage. Full CI command, when requested: `pnpm run ci`. Choose checks relevant to the change within the user-authorized scope and authored project policy. `verify` can run declared checks; an authorized command it cannot run can be executed through `bash`.
