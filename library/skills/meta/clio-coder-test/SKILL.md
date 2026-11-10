---
name: clio-coder-test
description: "Validate Clio Coder changes: pick checks from the diff, know what each test tier proves, keep runs isolated, verify behaviour live in a candidate build and report evidence without claiming unrun coverage. Use when developing or diagnosing Clio itself."
triggers:
  - validate a Clio change
  - test Clio context compaction or memory
  - verify Clio skill activation
  - choose Clio test gates
version: 0.5.0
license: Apache-2.0
clio-coder:
  registry-id: iowarp/clio-coder
  source-url: https://github.com/iowarp/clio-coder/tree/main/library/skills/meta/clio-coder-test
  audit: pass
  model-size: any
---

# Clio validation

Choose checks from the diff and from the code that actually executes. The
lane brief and `.clio-coder/rules/` set host rules (scratch root, locks, which
live model); this skill sets the method. It is usable alone; `clio-coder-dev`
covers implementation.

## What each command proves

| Command | Runs | Needs `dist/` | Proves |
| --- | --- | --- | --- |
| `pnpm run typecheck` | src, tests, scripts | no | types |
| `pnpm run lint` | biome, then `scripts/check-hygiene.ts` (formatting, export hygiene, inventories, packaging, every boundary rule) | no | static contracts |
| `pnpm run test:file -- <files>` | the named files, from the repo root | if the file spawns the CLI | one behaviour |
| `pnpm run test` | the curated `coreTests` list in `scripts/ci-tests.mjs`, about one file in seven | no | the default contracts only |
| `pnpm run test:gui` | the curated `guiTests` list, including the OpenAPI contract | no | GUI API and models |
| `pnpm run test:package` | four files against the packed build | yes, current | the installed artifact |
| `pnpm run test:full` | every root test file | yes, built from HEAD | everything, slowly |
| `pnpm run check:gui` | GUI types and lint | no | GUI static |

`pnpm run ci` is release qualification on a clean tree with two Node
versions. It is not a routine check. Suites, builds and browser checks are
heavy: run one at a time and follow the brief's lock rule.

## Pick checks from the diff

1. TypeScript changed: `pnpm run typecheck` and `pnpm run lint`.
2. Find the tests that exercise the change, in every directory:
   `grep -rl "<module stem>" tests apps/clio-coder-gui/tests`. Run them with
   `test:file`. Most regressions live in `tests/extended/`, which the core
   list never runs.
3. A test that spawns `dist/cli/index.js` sees the last build, not your edit.
   Build first. No test command rebuilds a stale `dist/`.
4. Contract seams: a change to a type the GUI server exposes needs the
   OpenAPI file regenerated and `test:gui`'s `openapi` test green.
5. Run the affected files on Node 22 as well as Node 24 when the change
   touches timers, `unref`, event-loop lifetime, streams, child processes or
   signals. Node 22.19 is the supported floor and the gate runs both.
6. A new test file must be added to `coreTests`, `guiTests` or
   `packageTests`, or no gate runs it. `pnpm run test:list` shows what is
   omitted.
7. A red test is yours until you have run the same file on the lane's base
   commit and seen it fail there. Say which commit you compared against.
8. A run with skipped tests is missing evidence. Sandbox tests skip when the
   OS sandbox cannot start; rerun them, do not count them.
9. No wall-clock thresholds. A timing failure under load needs a rerun on a
   quiet host before it is called a flake, and then evidence for the claim.

For a bug, reproduce it first or say why you could not. Assert state a user
or caller can observe: provider payload, persisted record, filesystem
outcome, event order, exit code. Do not write tests that match prose.

## Keep runs isolated

Run tests only through the pnpm scripts; they preload
`tests/harness/tmp-root.ts`. A bare `node --test` writes the operator's real
home. Export `TMPDIR` to your lane's scratch directory before tests, builds
or `mktemp`; the harness nests its root under it. Never write system `/tmp`.

Under `git bisect run` or any git-driven runner, unset `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` and `GIT_PREFIX` for the
test command. Afterwards confirm the shared config:
`git config --get core.bare` is `false` and `user.name` is the operator's.

Use [references/harness.md](references/harness.md) for scratch homes,
fixtures and process drivers, [references/test-map.md](references/test-map.md)
to find test files, and
[references/lifecycle-validation.md](references/lifecycle-validation.md) for
compaction, replay, memory, tools and dispatch.

## Verify live

Tests passing is not the behaviour working. Before READY, exercise what a
user would see, in a candidate built from your workspace:

1. `pnpm run build` in the workspace.
2. Run `node <workspace>/dist/cli/index.js`, never the installed
   `clio-coder`, with a fresh home: set `CLIO_CODER_HOME`,
   `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`,
   `CLIO_CODER_CACHE_DIR` to directories under your scratch root and
   `CLIO_CODER_INTEROP_HOME=none`.
3. Drive the surface you changed:
   - headless: `run --json ... -- "<task>"`; check the exit code and the
     final frame;
   - a recipe: `run --agent <id>`;
   - ACP: stdio, with the client pattern in `tests/smoke/acp-boundary.test.ts`;
   - TUI: its own pane or tab, never your own pane (see harness.md);
   - GUI: `pnpm run check:gui`, then the page in a browser whose profile and
     temp directory are under your scratch root;
   - an external CLI such as `gh`: the real program against a disposable
     target, or say it was not exercised.
4. A loopback fixture proves machinery. A live model is used only on the
   route the brief names, and the report names target, model and runtime.

## Report

List each command with its outcome and counts (pass, fail, skipped), the
Node version, the commit tested, and whether the evidence is source, built
process, installed package or live model. Name every check you did not run
and why. Passing checks authorize no extra commit, push or release step.
