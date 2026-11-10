# Clio test harness reference

This reference covers the harness modules in the current tree: temporary-state isolation, a headless CLI driver, dispatch fixtures, a loopback OpenAI-compatible server and the ACP stdio driver. Deterministic tests do not contact a real model. There is no shared PTY harness; three files use `node-pty` directly.

## Temporary roots and state isolation

The `test:file` and `test` package scripts preload `tests/harness/tmp-root.ts`.
It creates one guarded root below the system temp directory, points `TMPDIR`
inside it before test modules load, sweeps abandoned roots only after a bounded
age, and removes the current root on process exit. `tmp-git-guard.ts` prevents
a test from creating `.git` at the system or run temp root, where it would alter
project-boundary discovery for unrelated tests.

An exported `TMPDIR` is honored as the parent of the run root, so point it at your lane's scratch directory. The harness scrubs `GIT_CONFIG_*`, `GIT_DIR` and its peers, `HERDR_*` and color variables from the environment; still unset the `GIT_*` repository variables yourself for any git command you run outside the pnpm scripts under a git-driven runner.

Use `tests/harness/scratch-env.ts` for Clio-specific state:

- `makeScratchHome()` returns a directory, a child-process environment, and a
  cleanup function without mutating `process.env`.
- `isolateClioEnv()` snapshots and mutates `process.env`, resets the XDG cache,
  and returns a restoring teardown.
- `newScratchClioHome()` and `clearScratchClioHome()` provide the same
  in-process isolation when a plain directory string is more convenient.
- `scratchClioEnvVars()` keeps `CLIO_CODER_HOME` and the data, config, state,
  and cache overrides in one root. The child-process form also sets
  `CLIO_CODER_REQUIRE_HOME_PREFIX=1`.

In-process environment isolation is a process-wide critical section. Await the
acquire helper in setup and always invoke its matching restore or clear helper
in teardown.

## Driving the built CLI

Built-process tests under `tests/smoke/` and `tests/extended-smoke/` spawn `dist/cli/index.js` through a local
process driver suited to that boundary:

- `tests/extended-smoke/cli-core.test.ts` captures stdout and stderr with a bounded timeout.
- `acp-boundary.test.ts` keeps stdin open and frames ACP v1 JSON-RPC messages.
- `installed-package.test.ts` packs, installs, and launches the installed
  artifact.
- `process-lifecycle.test.ts` keeps the process live long enough to verify
  signal propagation into a tool child.
- `real-binary-boot.test.ts` supports interactive setup input and bounded
  shutdown during first-run and migration checks.

Build before a focused smoke run. No test script builds for you; run `pnpm run build` first. Keep environment roots under a scratch directory, capture both
output streams, bound every wait, and terminate a surviving child in teardown.
`tests/harness/headless-run.ts` exports `runCli`, `headlessScratch`, `initializeScratchHome`, `privateCliCopy` and `sealedReceipt`; use it for a headless subprocess instead of writing a new driver.

## Loopback provider fixtures

`tests/harness/openai-compat-fixture.ts` exports
`startOpenAICompatFixture()` and `closeServer()`. The fixture listens on an
ephemeral loopback port, serves `/v1/models` and `/v1/chat/completions`, supports
streaming text and one scripted tool call, and records request bodies for
assertions. Its seed helpers write scratch target configurations for
orchestrator, tool, fleet, bootstrap, and unregistered-runtime cases.

The fixture is the standard way to drive the real CLI without a model; `seedOpenAICompat*` helpers write the scratch target configuration. `toolCall` may be a function of the request. Workers use `CLIO_CODER_WORKER_FAUX=1` (with `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`), which affects worker subprocesses only; in-process tests register `registerEngineFauxProvider`.

## Dispatch contracts

`tests/harness/dispatch.ts` provides:

- `makeDispatchBundle()` with the real prompt customization path and a fast,
  argument-preserving reproducibility collector.
- `isolateDispatchState()` and `restoreDispatchState()` for ledger, receipt,
  and environment isolation.
- `holdEventLoop()` for contracts that await an unref'd production watchdog.

`dispatch-stub-context.ts` supplies the minimal domain context used by dispatch
tests. `receipt.ts` supplies typed envelope and receipt drafts. Prefer these
fixtures over reconstructing broad domain objects in each test.

## ACP over JSON-RPC stdio

`tests/smoke/acp-boundary.test.ts` owns the current `AcpClient`. It launches
`clio-coder acp` with piped stdio, parses one JSON object per line, correlates
responses by id, collects `session/update` notifications, and handles inbound
`session/request_permission` calls.

The exercised sequence is `initialize`, `session/new`, `session/prompt`, then
`session/close`. Permission cases answer the inbound request with a selected
`allow-once` or `reject-once` option and assert both the final tool-call update
and the filesystem outcome. Keep stdout exclusively for protocol frames;
diagnostics belong on stderr.

## Disposable probes

A one-off diagnostic lives in your lane's scratch directory, never under
system `/tmp` and never in `tests/` or `scripts/`. Run TypeScript probes with
`node --import tsx`, point all Clio state variables at a fresh directory under
the scratch root, and delete the probe after recording the result. A result
from a loopback fixture is machinery evidence, not live-model evidence.

## Driving the TUI in its own pane

Never launch Clio inside your own pane or split your own pane for it. When a
pane host is available (`HERDR_ENV=1`), create a separate tab, take the pane
id the host returns, export the isolated home and `TMPDIR` in that pane, start
the candidate (`node <workspace>/dist/cli/index.js`), drive it by sending
keys and reading the pane, quit with `/quit`, and close only the tab you
created. One TUI at a time. Record what you typed and what the pane showed.
Without a pane host, say the TUI was not driven.
