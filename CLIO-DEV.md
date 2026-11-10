# Clio Coder

Clio Coder (`@iowarp/clio-coder`) is a TypeScript and Node.js coding-agent harness with terminal, headless, ACP and browser surfaces on the Pi SDK. `src/` is authoritative for behavior. This handbook is written by hand for work on this repository.

## Hard invariants

Rule ids are checked by `tests/boundaries/check-boundaries.ts`, which `pnpm run lint` runs.

1. Only `src/engine/**` imports `@earendil-works/pi-*`, `import type` included; other code takes erased shapes from `src/engine/types.ts` and TUI primitives from `src/engine/tui.ts` (rule1).
2. `src/worker/**` value-imports `src/domains/**` only through the allow-listed provider rehydration modules; an inline `{ type X }` counts as a value import in every rule, so write `import type` (rule2). Worker stdout is NDJSON only.
3. A domain never imports another domain's `extension.ts`; go through `src/domains/<name>/index.ts` (rule3).
4. Layering: `src/tools/**` never imports `src/interactive/**` (rule4); `src/session-control/turn-*.ts` and `chat-loop.ts` never import `src/entry/**` (rule5); `src/session-control/**` and `src/engine/**` never import `src/interactive/**`, type-only included (rule8, rule9); `src/domains/turn-control/**` imports no interactive, engine, tools or worker module and reaches other domains only through their `index.ts` (rule7).
5. Value imports from outside the Stage 0 closure, and every import from `src/cli/**`, reach `src/interactive/**`, `src/session-control/**` and `src/engine/**` only through a module in `STAGE0_SEAMS` (rule6); the instant-shell budget test fails only after a full build.
6. `src/entry/orchestrator.ts` only wires services: no feature-internal imports, no new module-scope function or arrow constant, at most 4800 lines, and it is one line under that. Put new logic and its wiring in the owning domain (rule15).
7. Only `src/session-control/chat-loop.ts` composes `ChatTurnState`; other modules take the view `src/session-control/turn-state.ts` declares, and naming the type anywhere else fails (rule16).
8. Owner capabilities such as `MiddlewareRegistrar` go only to the composition that owns the domain, and `getContract(name)` takes its type from `DomainContractMap`, never from a type argument (rule17).
9. Only the telemetry domain writes under the telemetry root (rule11); the import closure of `src/core/telemetry/producer.ts` does no persistence, no `JSON.stringify` and no synchronous write (rule13).
10. Outside `src/engine/**` provider usage is never mutated or put on a ledger payload (rule12); money renders only through `src/core/telemetry/render.ts` (rule10); `src/interactive/**`, `src/engine/acp/**` and `src/cli/**` sum no token or cost field (rule14).
11. Tests and dev runs never touch the operator's real home or the host's `/tmp`: run tests only through the root pnpm test scripts with `TMPDIR` exported to a scratch directory. A bare `node --test` writes the real home.
12. Never commit a path `.gitignore` excludes (lint's tracked-ignored check fails it), never add tracked paths that differ only by case, and never join a gitignored literal onto the checkout root in `scripts/` or `src/`.
13. Published tags and artifacts are immutable, `npm publish` is never run directly, and nothing is pushed, tagged or released without the maintainer's instruction.

## Map

- `src/entry/orchestrator.ts` is the composition root (`bootOrchestrator`). The TUI, headless `run` and ACP boot through it; `run --agent` does not and composes its own domain set in `src/cli/run.ts`.
- `src/session-control/` holds the chat loop (`chat-loop.ts`), the turn modules (`turn-*.ts`) and slash commands (`slash-commands.ts`), shared by TUI, `run` and ACP. Older notes place these in `src/interactive/`.
- `src/engine/` is the Pi boundary: model and tool loop (`agent.ts`), provider wire adapters (`apis/`, `claude/`, `codex/`, `copilot/`), ACP server (`acp/server.ts`), session files on disk (`session.ts`), worker runtime (`worker-runtime.ts`).
- `src/domains/<name>/` holds feature logic. A loaded domain has `manifest.ts`, `extension.ts`, `contract.ts`, `index.ts` and a row in `DomainContractMap`; the rest are plain modules behind `index.ts`. Owners: `dispatch` (worker runs, `worker-spawn.ts`), `safety` (admission, `policy-engine.ts`), `prompts` (`compiler.ts`, `fragments/`), `session` (contract, compaction, tree), `telemetry` (journals, read model), `config` (live snapshot, `classify.ts`), `context` (handbook generator, codewiki, working set), `providers` (targets, runtimes, auth), `resources` (skills and library loaders), `agents` (recipes in `builtins/`, playbooks), `mux` (panes).
- `src/tools/` holds tool specs, `registry.ts`, placement (`surface.ts`) and planes (`policy.ts`). `src/tools/gateway/` is the gateway tool; the MCP client is `src/domains/gateway/mcp/`.
- `src/interactive/` is the terminal UI only: `interactive-application.ts`, `chat-panel.ts`, `overlays/`, `footer/`, `theme/`.
- `src/cli/` has one lazily imported file per subcommand, listed in `COMMAND_HANDLERS` in `src/cli/index.ts`; headless modes are in `src/cli/modes/`.
- `src/core/` holds shared leaves: `config.ts` (schema, validation), `defaults.ts`, `tool-names.ts`, `domain-loader.ts`, `telemetry/` (hub, producer, renderer; no I/O).
- `src/worker/entry.ts` is the worker subprocess. Workers, the GUI server and smoke tests execute `dist/`, not source.
- `apps/clio-coder-gui/` is the browser app (Hono server, React client, typebox contracts). It reaches Clio over ACP and through the shims in `apps/clio-coder-gui/server/clio/`.
- One feature often has same-named files in `src/cli/`, `src/tools/`, `src/interactive/overlays/` and `src/engine/acp/`; the logic is in the domain.
- Tests are flat `<topic>-<aspect>.test.ts` files with no source mirroring: `tests/contracts/` and `tests/extended/` import source, `tests/smoke/` and `tests/extended-smoke/` drive the built CLI, `tests/harness/` holds helpers. Find the tests for a module with `grep -rl "<module>.js" tests`.

## Tests
<!-- clio: paths=none -->

- `pnpm run test` runs only the curated `coreTests` list in `scripts/ci-tests.mjs`, about one root test file in seven, and `pnpm run test:gui` the curated `guiTests` list. A new test file is added to a list there or no gate runs it.
- Most regressions are caught by the extended tests, which only `pnpm run test:file -- <files>` and `pnpm run test:full` run. Find the tests that import what you changed, in every test directory, and run them with `test:file` from the repository root.
- A test that spawns the built CLI sees the last build, not your edit; run `pnpm run build` first. Only `test:full` checks `dist/`, and it cannot see uncommitted edits.
- `pnpm run ci` is release qualification on a clean tree with two Node versions; run it only when asked.
- A run with skipped tests is missing evidence, and a red test is yours until the same file fails on your base commit.
- No wall-clock thresholds, and never swap `process.stdout.write` across an `await`.
- Fixtures isolate Clio state with `isolateClioEnv` from `tests/harness/scratch-env.ts` and never create `.git` at the temp root. A headless subprocess uses `runCli` from `tests/harness/headless-run.ts`.
- When the brief is silent: at most one focused regression test per defect, in the nearest existing test file.

## Gotchas
<!-- clio: paths=none -->

- Export hygiene: an `export function` in product source whose name occurs in only one `.ts` file across `src/`, `tests/` and `apps/` fails lint; a `.tsx` use does not count. Remove the keyword, then run `pnpm exec biome check --write <file>`.
- Parallel changes collide in `src/session-control/slash-commands.ts`, `src/domains/report/index.ts`, `src/interactive/interactive-application.ts`, `src/domains/dispatch/extension.ts`, `src/interactive/overlay-lifecycle.ts` and `src/entry/orchestrator.ts`. Add one hunk, leave neighbours as they are, and never add a required field to a shared entry type inside a feature commit.
- `pnpm run build` empties `dist/` first, so every process started from that tree fails on the next module it has not loaded. Never build the tree another session runs from.
- "Gateway" means three things: the `gateway` tool, the MCP client domain, and upstream routing in `src/core/gateway-routing.ts`. "Fleet" is a multi-worker run; a saved multi-step workflow is a playbook.
- Module stems must differ by more than case.

## Conventions
<!-- clio: paths=none -->

- Formatting is tabs, double quotes, trailing commas, 120 columns and organized imports (`biome.json`); a formatting-only diff fails `pnpm run lint`. Biome skips the GUI app, which `pnpm run check:gui` covers.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals` and `noImplicitOverride`: pass an optional as `...(x !== undefined ? { x } : {})`, never `x: undefined`. Relative imports end in `.js`, in the GUI client too.
- Errors read `err instanceof Error ? err.message : String(err)`; an empty `catch {}` carries a comment saying why ignoring is safe. Comments explain why and cite the issue.
- One namespace: `.clio-coder/`, `CLIO_CODER_*`, `clio_coder_*` events.
- Durable Clio state is written with `safeResourceWrite` or `safeResourceWriteAsync`; tool subprocesses spawn through `runCommandVector`.
- Terminal colors come from the theme tokens; raw SGR escapes and hex colors outside a `theme/` directory fail the theme-discipline check.
- Supported Node is 22.19 and later; landing gates run on Node 22 and Node 24, so code that depends on timer, stream or child-process lifetime is checked on both.

## Change recipes

- Settings key, all in one change: the field on its settings type, `DEFAULT_SETTINGS` and `DEFAULT_SETTINGS_YAML` in `src/core/defaults.ts`; in `src/core/config.ts` the matching `issues.unknownKeys` list and a parse branch in `validateSettings` (without it the key validates and is silently ignored); the leaf name in `SETTINGS_FIELD_NAMES` in `src/core/settings-fields.ts`; an effect-timing set in `src/domains/config/classify.ts` (unlisted means restart); a label, and `CHOICES` for an enum, in `src/core/settings-controls.ts`; a placement in `src/core/settings-areas.ts`; its row with default and effect timing under `## Settings inventory` in `docs/guide/configuration-and-targets.md`.
- Removed settings key: record it in `SETTINGS_V1_PATH_MOVES` or `SETTINGS_V1_RETIRED_PATHS` in `src/core/config.ts`; never just delete it.
- Environment variable: read it as `process.env.CLIO_CODER_X` and add its row to `docs/guide/environment-variables.md`; a row for a variable no code reads also fails lint.
- State file: a new entry under the state root is named in `docs/architecture/artifact-placement.md`.
- Tool: name in `src/core/tool-names.ts`; plane in `src/tools/policy.ts` and a matching case in `src/domains/safety/action-classifier.ts` (a mismatch fails at boot); placement in `src/tools/surface.ts`; metadata in `src/tools/builtin-tool-catalog.ts`; a row in `src/tools/presentation.ts`; registration in `src/tools/core-bootstrap.ts` or `src/tools/bootstrap.ts`; a heavy implementation loads through `src/tools/lazy-tool.ts`.
- CLI subcommand: one lazy row in `COMMAND_HANDLERS` in `src/cli/index.ts` plus its help line; a static import breaks the instant shell.
- Slash command: an entry in `src/session-control/slash-commands.ts` needs `name`, `description`, `group`, `rank`, `acp`, `kinds` and `handle`; add it as one hunk. A retired name goes in `RETIRED_COMMANDS` with the current release as `since`.
- Prompt fragment: a Markdown file under `src/domains/prompts/fragments/` with frontmatter `id`, `version: 1` and `description`, selected by id in `src/domains/prompts/compiler.ts`; an unreferenced fragment never renders.
- GUI contract: after changing `src/core/telemetry/dto.ts` or the schema modules it imports, `src/engine/acp/types.ts` or `apps/clio-coder-gui/contracts/*.ts`, run `pnpm --filter @iowarp/clio-coder-gui run openapi` and commit `apps/clio-coder-gui/contracts/openapi.json`; only `pnpm run test:gui` catches a stale file.
- GUI server code imports root `src/` only through the shims in `apps/clio-coder-gui/server/clio/`; a new symbol is added to that shim's allow-list in `apps/clio-coder-gui/tests/boundaries.test.ts`.
- Packaged resource: a path resolved from `resolvePackageRoot()` must be covered by `package.json` `files`; `scripts/`, `tests/` and `patches/` do not ship.
- Library package: after changing one under `library/`, bump its version in `SKILL.md` and `plugin.json`, run `pnpm run library:pin` and commit the four regenerated registry files; never hand-edit them.
- Keybinding: the key table in `docs/guide/commands-and-modes.md` must equal the registry (`tests/contracts/keyboard-model.test.ts`).

## Git and release
<!-- clio: paths=none -->

- Work on a branch cut from the current version branch (`v` plus the digits of the `package.json` version, `v071` for 0.7.1); `main` moves only when a release ships.
- Conventional commits; a tracked-issue fix ends with `fixes #N`, one issue per commit. Never hand-write attribution trailers or set the author: Clio's commit hook appends its own trailers and authors worker and headless commits.
- All worktrees share one `.git/config`, stash and object store: never `git stash`, never move a branch by relative ref, never amend a commit you did not just make, and unset `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_PREFIX` for any command a git-driven runner such as `git bisect run` executes.
- Publication is the maintainer's release flow in `CONTRIBUTING.md`; CI never publishes to npm.

## Docs and prose
<!-- clio: paths=none -->

- No `docs/` edits unless the brief includes docs, except the inventory rows lint demands; `CHANGELOG.md` belongs to release work. Put proposed changelog lines and deferred docs in your report.
- Links, heading anchors and backticked source paths in `docs/**`, `README.md` and `CONTRIBUTING.md` must resolve, and any Markdown page under `docs/` outside the generated wiki joins the bundled docs corpus automatically.
- Refer to Clio by name, never with gendered pronouns. CLIO is the ecosystem, Clio Coder the product, `clio-coder` the command. Never write the dash interjection (`noun - clause`); use a full sentence.

## Operating Clio on this repository

- The running Clio and the workspace are usually different trees: prompt fragments, built-in recipes and tool code come from the build that started the session (`clio-coder --version` shows its commit), while this handbook, `.clio-coder/rules/` and the two self-development skills come from the workspace. Test a workspace edit in a candidate built from the workspace (`pnpm run build`, then `node dist/cli/index.js` with an isolated home), never by rebuilding or relinking the running install.
- Load `clio-coder-dev` before the first edit to this repository and `clio-coder-test` when choosing checks.
- A dispatched worker receives this handbook's invariants and the sections for its role, cut to 6000 characters and filtered by the paths its task declares; it does not receive your loaded skills. Declare the paths, put any other rule it needs in the task, and write gate commands for a verifier in backticks.
- Headless `clio-coder run` denies every permission ask and has no `ask_user`; put decisions in the task text.
