---
title: "Contract tests"
summary: "The contract test suite that guards Clio's behavioral invariants, covering state isolation, dispatch routing, engine lifecycle, smoke tests of the built binary, ACP boundary behavior, and import-boundary enforcement."
sources:
  - "tests/harness/tmp-root.ts"
  - "tests/harness/scratch-env.ts"
  - "tests/harness/dispatch.ts"
  - "tests/harness/receipt.ts"
  - "tests/harness/run-journal.ts"
  - "tests/harness/headless-run.ts"
  - "tests/boundaries/check-boundaries.ts"
  - "tests/contracts/engine-lifecycle.test.ts"
  - "tests/contracts/fleet-dock.test.ts"
  - "tests/contracts/quota-claude-code-provider.test.ts"
  - "tests/smoke/acp-boundary.test.ts"
  - "tests/smoke/real-binary-boot.test.ts"
symbols:
  - "registerFauxFromEnv"
  - "isolateClioEnv"
  - "makeScratchHome"
  - "runBoundaryCheck"
  - "sealedReceipt"
  - "readRunJournal"
  - "installTmpGitGuard"
tests:
  - "tests/contracts/engine-lifecycle.test.ts"
  - "tests/contracts/fleet-dock.test.ts"
  - "tests/contracts/quota-claude-code-provider.test.ts"
  - "tests/smoke/acp-boundary.test.ts"
  - "tests/smoke/real-binary-boot.test.ts"
invariants:
  - "Tests never write to the operator's real home directory; the tmp-root preload redirects all Clio state into a per-run scratch root."
  - "A `.git` marker at the system temp root or the run's scratch root is refused by the tmp-git guard, preventing ignore-policy contract failures."
  - "The engine lifecycle ordering after pi 0.84.4 is locked: prepareNextTurn runs only before another assistant turn, never after a final or terminating turn."
  - "Only src/engine/** imports @earendil-works/pi-*; the boundary checker enforces this and five other import rules."
validate:
  - "pnpm test"
---

# Contract tests

The contract test suite guards Clio's behavioral invariants across four lanes: contract tests (regression tests under `tests/contracts/`), smoke tests (end-to-end exercises of the built binary under `tests/smoke/`), extended tests (longer integration tests under `tests/extended/` and `tests/extended-smoke/`, run only under `test:full`), and boundary tests (static import-rule enforcement under `tests/boundaries/`). Every lane shares the same state-isolation harness so that no test can leak into the operator's real home or interfere with another test's state.

## State isolation: the tmp-root preload

The single most important invariant of the test suite is that **tests and dev runs never touch the operator's real home**. The mechanism is a preload script loaded via `--import ./tests/harness/tmp-root.ts` in every test invocation.

`tests/harness/tmp-root.ts` performs these steps at load time:

1. **Reads the real temp dir** before redirecting anything, resolving symlinks via `realpathSync` (macOS hands out `/var/folders/...` which resolves under `/private/var`; the canonical form is needed for later path comparisons).
2. **Sweeps stale roots**: removes any previous `clio-coder-tests-*` directories whose recorded owner PID has exited and whose `mtime` is older than 4 hours (`STALE_ROOT_MS`).
3. **Creates a per-run scratch root** via `mkdtemp(join(systemTmp, "clio-coder-tests-"))` and writes `.owner.json` containing the current PID.
4. **Redirects `TMPDIR`** to the scratch root, so every subsequent `mkdtemp()` call from any test module lands inside it.
5. **Sets Clio's state variables**: if no test has already chosen its own `CLIO_CODER_*_DIR` values, the preload sets `CLIO_CODER_HOME`, `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, and `CLIO_CODER_CACHE_DIR` under the scratch root, plus `CLIO_CODER_REQUIRE_HOME_PREFIX=1`.
6. **Clears color-control env vars** (`FORCE_COLOR`, `NO_COLOR`, `COLORFGBG`, `CLIO_CODER_THEME`) so every test sees the same default theme.
7. **Installs the tmp-git guard** via `installTmpGitGuard` from `tests/harness/tmp-git-guard.ts`, which refuses a `.git` at either the system temp root or the run's scratch root.
8. **Removes the scratch root at exit** via `process.on("exit")`, but only if `isRemovableRoot()` confirms it is safe to delete (checks the path starts with the system tmp, the basename starts with the expected prefix, and `lstatSync` reports a real directory rather than a symlink).

The tmp-root preload runs in the runner process and again in each test child; a child inherits the root through the environment (`CLIO_CODER_TEST_TMP_ROOT`) and reuses it rather than creating a new one. Only the process that created the root removes it.

### The tmp-git guard

`tests/harness/tmp-git-guard.ts` enforces issue #205: a `.git` at the system temp root or at the run's scratch root silently flips `isInsideGitRepo()` for every `mkdtemp` scratch directory, breaking tests that rely on accurate repository detection. The guard:

- Wraps every `node:fs` creator function (`appendFile`, `mkdirSync`, `writeFile`, `symlink`, etc.) to throw before the `.git` entry is created.
- Wraps every `node:child_process` entry point (`exec`, `spawn`, `fork`, etc.) to check before and after for a `.git` that appeared.
- Uses `syncBuiltinESMExports()` to republish the wrappers through the builtin ES module facades so that `import { mkdirSync } from "node:fs"` sees the wrapper.
- Reports offenders at exit and sets the exit code to 1.

The guard never deletes anything; a `.git` at either level that pre-exists the run is reported to stderr but left alone.

### Per-test isolation via scratch-env

For tests that need a separate home within the run, `tests/harness/scratch-env.ts` provides three flavors:

- **`makeScratchHome()`**: creates a fresh `mkdtemp` directory and returns its dir, an env object with `CLIO_CODER_*` vars set (including `CLIO_CODER_REQUIRE_HOME_PREFIX=1`), and a cleanup function. Does not touch `process.env` — the child reads env fresh.
- **`isolateClioEnv()`**: in-process isolation with a full `process.env` backup/restore. It queues behind a process-wide async lock (`acquireEnvLock`) so that two test files running concurrently under `--experimental-test-isolation=none` cannot overlap their `process.env` mutation windows. This lock was added after issue #84: `interop-consent.test.ts` and `interop-state.test.ts` both had fully synchronous test bodies yet clobbered each other's `CLIO_CODER_HOME` because the Node test runner's scheduling inserted a gap between hook invocations that was enough for interleaving.
- **`newScratchClioHome()` / `clearScratchClioHome()`**: minimal in-process isolation that keeps the scratch dir as a plain string, for use with `beforeEach`/`afterEach`.

All in-process flavors call `resetXdgCache()` so that `src/` code re-resolves the scratch directories.

## Test scripts and lane structure

The `package.json` scripts define four test lanes:

| Script | What it runs |
|--------|-------------|
| `pnpm test` | `tests/contracts/*.test.ts`, `tests/smoke/acp-boundary.test.ts`, `tests/smoke/real-binary-boot.test.ts`, `tests/smoke/process-lifecycle.test.ts`, `tests/smoke/boot-handoff.test.ts` with `--test-concurrency=2` |
| `pnpm test:full` | `tests/contracts/*.test.ts`, `tests/extended/*.test.ts`, `tests/smoke/*.test.ts`, `tests/extended-smoke/*.test.ts` |
| `pnpm test:file -- <file>` | A single test file (never builds) |
| `pnpm test:maintenance` | Two keyboard test files under `tests/extended/` |

Both `test` and `test:full` preload `tests/harness/tmp-root.ts` via `--import`. The `pretest` and `pretest:full` scripts build `dist/` only when it is missing (`test -f dist/cli/index.js && test -f dist/metafile-esm.json || pnpm run build`).

The `ci` script runs the full handoff gate: `pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test && pnpm run test:maintenance && pnpm run check:gui && pnpm run test:gui`.

## Engine lifecycle contracts

`tests/contracts/engine-lifecycle.test.ts` locks the ordering Clio's turn runtime relies on after the pi 0.84.4 `prepareNextTurn` change. The test file covers:

- **prepareNextTurn runs only before another assistant turn**: a scripted provider returns a tool-call turn followed by a final turn; the test asserts the timeline is `["llm:1", "tool:one", "prepare", "llm:2"]` and that `prepareNextTurn` never runs after the final turn.
- **Steering during preparation**: a steer queued while `prepareNextTurn` is running is delivered before the next assistant call, landing after the tool result and before the continuation.
- **Terminating tool batches**: preparation is skipped entirely after a terminating tool batch, but the run still closes through `agent_end`.
- **Preparation failure**: when `prepareNextTurn` throws, the run closes through `agent_end` with an assistant message carrying `stopReason: "error"`.
- **Transcript resets**: `Agent.reset()` is refused while a run is active (throws `/already processing/`); Clio's reset callers cancel and await settlement first, after which the same reset is accepted.
- **Tool argument normalization**: `validateEngineToolArguments` treats `null` for an optional non-nullable argument as omitted (pi-ai 0.84.2 behavior) while still rejecting `null` where the schema requires a value.
- **TUI keybinding table**: pi-tui 0.84.4 alt-screen actions are routable through Clio's table without colliding with Clio app defaults; a deliberately scoped overlap (`ctrl+g` for `searchNext` while the search overlay is focused) is recorded.
- **Alternate-screen render seams**: the three protected seams Clio measures (`overlay`, `cursor`, `normalization`) still run inside one fullscreen frame after pi 0.84.2 paints full-width rows as direct line references.

## Fleet dock layout

`tests/contracts/fleet-dock.test.ts` tests the Fleet dock's layout behavior:

- **Live Fleet runs reserve normal-flow rows**: the test builds a layout with a transcript, Fleet dock, editor, and footer, renders it in both `regular` and `fullscreen` modes across widths 40–200, and asserts that the transcript sentence is preserved intact, the Fleet dock appears between the transcript and the editor, and every row fits within the terminal width.
- **A live run is never drawn by a transcript-covering ticker overlay**: the test creates an interactive tickers component and asserts that when a dispatch row is active, the overlay does not render any line containing "Fleet runs".

## Quota provider contracts

`tests/contracts/quota-claude-code-provider.test.ts` tests the Claude Code quota provider end-to-end with a stubbed `fetch`:

- Parses the `limits[]` usage shape into ordered windows (session, weekly, scoped weekly).
- Falls back to the flat `five_hour` and `seven_day` buckets when `limits` is empty.
- Maps HTTP 401 and 403 to an expired session.
- Captures `Retry-After` when the usage endpoint rate limits the read.
- Reports other failing statuses and malformed JSON as errors.
- Reports missing credentials without spending a network call.
- Detects Claude Code's own credential file and ignores unusable ones.
- Refuses a token the credential record already declares expired, without a request.
- Asks for a fresh sign-in when the refresh token is gone or also expired.
- Still calls the endpoint when the record carries no expiry at all.
- Parses `Retry-After` and plan strings defensively.
- Serves a cached snapshot inside the TTL and refetches after it expires.
- Falls back to the last good snapshot when a refresh fails.
- Reports a failure directly when nothing good was ever cached.
- Registers explicitly connected adapters in display order.

## Smoke tests: the built binary

The smoke tests exercise the built `dist/cli/index.js` binary end-to-end. They use the same `isolateClioEnv` pattern and the `CLIO_CODER_*` env vars to redirect all state into a scratch directory.

### ACP boundary

`tests/smoke/acp-boundary.test.ts` drives the ACP (Agent Client Protocol) stdio boundary:

- **Terminal authentication**: `acp auth login` without a terminal exits with code 2 and an error message about `--quick` needing a terminal.
- **Missing service credentials**: a target with `auth.apiKeyEnvVar` set but the env var unset is rejected before admission with `prompt_not_admitted` / `authentication-required`; after logging in via `auth login`, the same session is reopened and the turn completes.
- **Text turn and unadmitted prompt**: a configured home serves a text turn; an unconfigured home rejects the prompt with `prompt_not_admitted`.
- **Same-child session close/new**: a direct ACP `session/close` followed by `session/new` resets history, ancestry, and tasks on the same child process; the original session can be resumed via `session/load`.
- **Cancelled permission response**: responding `cancelled` to a `session/request_permission` aborts the turn before the tool can resume the model.
- **Permission allow and reject**: mediating one unrecognized shell write `allow-once` and one `reject-once` produces the expected file creation or non-creation and tool status.

### Real binary boot

`tests/smoke/real-binary-boot.test.ts` tests the built binary's boot path:

- **v1 settings upgrade**: writes a v1 `settings.yaml`, runs `clio-coder upgrade`, asserts two migrations applied, a backup file is kept, and the migrated settings match the expected v2 shape. Re-running `upgrade` reports no pending migrations and leaves the file unchanged.
- **`--autonomy` flag**: rejects unsupported values, refuses to drop the flag on subcommands that would silently ignore it, and accepts it for the interactive session without rewriting `settings.yaml`.
- **First-run setup**: takes a genuinely empty home through the interactive setup wizard, seeding a target via `lmstudio` and reaching the editor.

## Extended tests (test:full only)

The `tests/extended/` and `tests/extended-smoke/` directories contain longer integration tests that run only under `pnpm run test:full`. The repository handbook is explicit: "A regression test belongs in `tests/contracts/`. `tests/extended/**` runs only under `pnpm run test:full`, never in CI (except the two keyboard files `test:maintenance` runs), so a test placed there guards nothing."

`tests/extended-smoke/headless-artifact.test.ts` is representative: it drives the built `clio-coder run` binary with a seeded OpenAI-compatible fixture, asserts the terminal artifact was written, and verifies the sealed receipt against its ledger row. The `sealedReceipt()` helper from `tests/harness/headless-run.ts` reads the run journal via `readRunJournal()`, finds the single receipt, locates its envelope in `runs.json`, and calls `verifyReceiptIntegrity()` to confirm the integrity seal binds them.

## Fake model injection (CLIO_CODER_WORKER_FAUX)

The worker entry can run end-to-end without provider credentials through `CLIO_CODER_WORKER_FAUX`. When this env var equals `"1"`, `registerFauxFromEnv()` in `src/engine/ai.ts` registers a pi-ai faux provider and queues a single deterministic assistant response. The faux model is wired into the worker runtime at `src/engine/worker-runtime.ts:432`:

```ts
const fauxModel = registerFauxFromEnv();
// ...
const model = applyModelCapabilityPatch(
  input.target.runtime === "faux" && fauxModel ? fauxModel : synthesized,
  input.modelCapabilities,
);
```

The faux provider responds to every prompt with the configured text (default `"ok"`) and stop reason (default `"stop"`). Additional env vars control the response:

| Env var | Purpose | Default |
|---------|---------|---------|
| `CLIO_CODER_WORKER_FAUX` | Must equal `"1"` to arm registration | — |
| `CLIO_CODER_WORKER_FAUX_MODEL` | Model id registered under the faux provider | `"faux-model"` |
| `CLIO_CODER_WORKER_FAUX_TEXT` | Assistant response text | `"ok"` |
| `CLIO_CODER_WORKER_FAUX_STOP_REASON` | Assistant stop reason | `"stop"` |
| `CLIO_CODER_WORKER_FAUX_ERROR_MESSAGE` | Optional assistant error message | — |

This mechanism is documented in `docs/guide/environment-variables.md` and is recognized by the hygiene checker (`scripts/check-hygiene.ts:615`) as a valid env var pattern.

## Receipt and evidence capture

The receipt system provides a durable, tamper-evident account of every dispatch run. The test harness for receipts is split across three files:

- **`tests/harness/receipt.ts`**: provides `fixtureEnvelope(runId)` and `fixtureReceiptDraft(envelope)` that construct complete, valid receipt envelopes and drafts. The integrity digest covers every receipt field, so a new required field breaks every suite at once.
- **`tests/harness/run-journal.ts`**: provides `readRunJournal(stateDir)` which reads the run ledger (`runs.json`) and the receipts directory under `stateDir`, returning a `RunJournal` with envelopes keyed by run id and all parsed receipts.
- **`tests/harness/headless-run.ts`**: provides `headlessScratch(prefix)` which creates a scratch home initialized by `doctor --fix`, `runCli(args, options)` which spawns the built CLI with a timeout, and `sealedReceipt(stateDir)` which reads the run journal, finds the single receipt, verifies its integrity against the ledger row, and returns both.

The receipt integrity check is performed by `verifyReceiptIntegrity(receipt, envelope)` from `src/domains/dispatch/receipt-integrity.ts`. The test `tests/contracts/acp-receipt-tool-truth.test.ts` demonstrates the receipt capture flow: it dispatches a run against an ACP peer that emits tool call and tool result frames, and asserts that the sealed receipt records the tool kinds (`edit`, `execute`), completed spans, mutations, and safety decisions.

## Boundary enforcement

`tests/boundaries/check-boundaries.ts` implements six static import rules that enforce architectural isolation between domains. The `runBoundaryCheck(projectRoot)` function walks every TypeScript file under `src/`, extracts all import specifiers (including dynamic imports and `/// <reference>` directives), and evaluates each against the rules:

| Rule | Constraint |
|------|-----------|
| **Rule 1** | Only `src/engine/**` may import `@earendil-works/pi-*` at all, including type-only imports. Since the 0.83.0 engine-boundary rework there is no type-only exception. |
| **Rule 2** | `src/worker/**` never value-imports `src/domains/**` except the three provider modules allow-listed in `isAllowedWorkerProviderValueImport` (`plugins.ts`, `registry.ts`, `runtimes/builtins.ts`). Type-only imports are allowed. |
| **Rule 3** | `src/domains/<x>` never imports `src/domains/<y>/extension.ts` for `y != x`. Use the contract exported from `src/domains/<y>/index.ts` instead. |
| **Rule 4** | `src/tools/**` never imports `src/interactive/**`. The tool substrate is surface-agnostic. |
| **Rule 5** | The chat loop's turn modules (`chat-loop.ts`, `turn-*.ts`) never import `src/entry/**`. Composition flows one way: the entry point composes the loop, never the reverse. |
| **Rule 6** | Any value importer outside the computed Stage 0 closure and its `src/interactive/**` and `src/engine/**` trees reaches those protected trees only through a declared seam in `STAGE0_SEAMS`. A seam may not lead back into Stage 0 unless that existing composition-root overlap is explicitly declared. |

Rule 6 has a second half: even when a seam is declared, the seam's own import closure must not reach into the Stage 0 owner's closure. The Stage 0 owner is `src/interactive/terminal-lease.ts`, and its closure is pinned to 32 chunks, 1,400,000 total bytes, and 350,000 Clio source bytes by `tests/contracts/instant-shell-import-graph.test.ts`.

The `STAGE0_SEAMS` array contains 30+ declared edges, each with a written reason explaining why the edge exists. For example: `src/engine/types.ts` is a seam because "the erased engine shapes (AgentMessage, ImageContent) domains and the CLI both take. Type-only at every call site."

## Things to watch when editing

- **The tmp-root preload is load-order dependent.** It runs before every test module, so any test that reads `TMPDIR` or `CLIO_CODER_*` env vars sees the redirected values. A test that needs the real temp dir must save and restore the original value explicitly.

- **The `isolateClioEnv` lock is process-wide.** A test that calls `await isolateClioEnv()` in `beforeEach` and `restore()` in `afterEach` holds the lock for the duration of the test. If two test files run concurrently (under `--experimental-test-isolation=none`), they serialize on this lock. A test that fails to call `restore()` deadlocks every subsequent test.

- **The tmp-git guard wraps `node:fs` and `node:child_process` globally.** It uses `syncBuiltinESMExports()` to republish the wrappers through the builtin ES module facades. A test that monkey-patches `node:fs` or `node:child_process` may break the guard or vice versa.

- **Smoke tests require a built `dist/`.** The `pretest` script builds `dist/` only when it is missing. A stale `dist/` is not rebuilt, and smoke tests run the built binary. After source changes, run `pnpm run build` before `pnpm test`.

- **Extended tests run only under `test:full`.** A regression test placed in `tests/extended/` does not run in CI (except the two keyboard files `test:maintenance` runs). Regression tests belong in `tests/contracts/`.

- **The boundary checker reads any inline `{ type X }` clause as a value import.** Write type-only imports as `import type { X }` to avoid rule 2/rule 6 failures.

- **The faux model is worker-only.** `registerFauxFromEnv()` is called from `src/engine/worker-runtime.ts`, which is the worker subprocess entry point. It is not available in the orchestrator process.

- **The receipt integrity digest covers every field.** When adding a new field to `RunEnvelope` or `RunReceiptDraft`, the fixture in `tests/harness/receipt.ts` must be updated in the same change, or every receipt test breaks at once.

<!-- clio-coder:wiki unresolved sources: tests/contracts/*.test.ts, tests/extended/*.test.ts, tests/smoke/*.test.ts, tests/extended-smoke/*.test.ts, tests/extended/**, src/engine/**, src/worker/**, src/domains/**, src/domains/<x>, src/domains/<y>/extension.ts, src/domains/<y>/index.ts, src/tools/**, src/interactive/**, src/entry/** -->
