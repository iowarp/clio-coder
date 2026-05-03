# clio-coder test suite audit

Date: 2026-05-03

Baseline:

- `npm run test` passed once in 9.37s wall time with 1071 tests.
- `npm run test:e2e` passed once in 60.64s wall time with 54 tests.
- Main HEAD at audit start: `a97983454fcfde8cf826a4089570b932dfcfe101`.
- Boundary invariants are not in scope for softening. The checker enforces engine imports, worker isolation, and domain extension independence in `tests/boundaries/check-boundaries.ts:127`.

## Slowest 20 Tests

| Rank | Test | Baseline wall | Citation | Action | Justification |
|---:|---|---:|---|---|---|
| 1 | `memory commands propose from evidence and manage approval state` | 8694.7ms | `tests/e2e/cli.test.ts:369` | KEEP | It is an end-to-end CLI workflow across evidence and memory state, so it belongs in full e2e only. |
| 2 | `escalates aborted commands that ignore sigterm` | 6530.3ms | `tests/unit/bash-tool-env.test.ts:84` | TIGHTEN | It waits for the production 5s kill grace and can assert the same behavior through an injected shorter grace. |
| 3 | `old lifecycle command names are rejected` | 6328.5ms | `tests/e2e/cli.test.ts:612` | KEEP | It is slow because it launches the built CLI eight times, but it protects retired public commands at the binary boundary. |
| 4 | `eval run, report, help, and compare routing are wired` | 6289.6ms | `tests/e2e/cli.test.ts:422` | KEEP | It covers the public CLI path through eval artifacts and evidence, which unit tests do not exercise as a binary. |
| 5 | `configures the interactive multi-worker profile pool` | 4388.9ms | `tests/unit/cli-configure-targets.test.ts:155` | MOVE | It writes real XDG config and belongs with integration tests. |
| 6 | `/scoped-models dispatches cleanly and Esc restores the editor` | 3011.0ms | `tests/e2e/interactive.test.ts:283` | KEEP | It verifies a real pty overlay lifecycle with stable loose matching. |
| 7 | `/resume opens the session picker (possibly empty), Esc closes` | 2785.4ms | `tests/e2e/interactive.test.ts:325` | KEEP | It protects the real pty route for session picker startup. |
| 8 | `/thinking shows the full level set for a reasoning-capable target` | 2758.2ms | `tests/e2e/interactive.test.ts:457` | KEEP | It checks capability data reaching the real TUI route. |
| 9 | `/model opens the picker, Esc closes, /quit exits clean` | 2656.7ms | `tests/e2e/interactive.test.ts:114` | KEEP | It is the canonical model picker pty smoke. |
| 10 | `evidence build, inspect, and list operate on run ledger receipts` | 2600.0ms | `tests/e2e/cli.test.ts:340` | KEEP | It proves the installed CLI can read seeded run receipts and write evidence. |
| 11 | `/model shows llama.cpp wire model ids and model-specific context windows` | 2579.4ms | `tests/e2e/interactive.test.ts:139` | KEEP | It protects user-visible model metadata in the real picker. |
| 12 | `model selection is immediately active when reopening the picker` | 2505.4ms | `tests/e2e/interactive.test.ts:173` | KEEP | It catches stale selection state in the live pty TUI. |
| 13 | `/hotkeys opens the reference, Esc closes` | 2488.0ms | `tests/e2e/interactive.test.ts:358` | KEEP | It is a simple pty smoke for the hotkeys overlay. |
| 14 | `/targets opens the target overlay, Esc closes, /quit exits clean` | 2476.1ms | `tests/e2e/interactive.test.ts:227` | KEEP | It protects target overlay routing in the live TUI. |
| 15 | `dashboard shows DEV MODE and footer flips to restart-required on engine edit` | 2463.9ms | `tests/e2e/self-dev.test.ts:110` | KEEP | It covers self-development pty behavior that unit tests cannot prove. |
| 16 | `/settings opens the settings overlay, Esc closes` | 2417.4ms | `tests/e2e/interactive.test.ts:308` | KEEP | It is the real TUI route for settings overlay startup and close. |
| 17 | `/new rotates the session and exits clean on /quit` | 2404.5ms | `tests/e2e/interactive.test.ts:344` | KEEP | It protects a session lifecycle command in the live TUI. |
| 18 | `auth login --api-key is parsed by auth, not the global startup flag` | 2400.2ms | `tests/e2e/cli.test.ts:598` | KEEP | It guards public CLI flag precedence at the binary boundary. |
| 19 | `Ctrl+L opens the /model picker and Esc closes it` | 2390.9ms | `tests/e2e/interactive.test.ts:260` | KEEP | It protects the pty keybinding route, not only slash command dispatch. |
| 20 | `/connect opens the target connection selector, Esc closes, /quit exits clean` | 2379.6ms | `tests/e2e/interactive.test.ts:244` | KEEP | It verifies the live selector opens and closes from the command surface. |

## Timing-Sensitive Tests

| Finding | Citation | Action | Justification |
|---|---|---|---|
| `TokenBucket` refill sleeps for 200ms. | `tests/unit/core.test.ts:99` | TIGHTEN | Injecting a clock keeps the refill behavior exact without scheduler timing. |
| Bash abort escalation sleeps for 1500ms and then waits for a 5s grace. | `tests/unit/bash-tool-env.test.ts:84` | TIGHTEN | A test-local bash tool with a shorter kill grace preserves the SIGTERM to SIGKILL behavior. |
| Tool abort tests assert elapsed wall-clock thresholds. | `tests/unit/tool-signal.test.ts:58` | KEEP | These cover real abort propagation through bash and fetch, and their thresholds are broad enough for the behavior under test. |
| Termination budget tests use small real timers. | `tests/unit/termination.test.ts:37` | KEEP | The behavior is specifically about budgeted timeout return, with generous thresholds. |
| Chat renderer coalescing tests wait for render timers. | `tests/unit/chat-panel.test.ts:699` | TIGHTEN | The production helper already accepts timer injection, so tests can drive the timer synchronously. |
| Dispatch concurrency polling uses `Date.now` and a 5ms delay loop. | `tests/unit/dispatch-concurrency.test.ts:50` | MOVE | The file uses scratch data dirs and worker fakes, so it belongs in integration instead of unit. |
| Session listing forces mtime separation with a 5ms sleep. | `tests/integration/session-listing.test.ts:109` | KEEP | The test checks filesystem mtime ordering and is already in integration. |
| Interactive pty tests use short sleeps after Esc and selection keys. | `tests/e2e/interactive.test.ts:105` | KEEP | They are wrapped in try/finally and paired with loose stable-text pty matching. |

## pi-tui and Synthetic Frames

| Finding | Citation | Action | Justification |
|---|---|---|---|
| No test imports or mocks `@mariozechner/pi-tui` directly. The closest live dependency is file completion through the real slash autocomplete contract. | `tests/unit/slash-autocomplete.test.ts:54` | KEEP | This does not assert on synthetic TUI frames. |
| Chat panel tests render through the project renderer and assert structural output rather than mocked pi-tui frames. | `tests/unit/chat-panel.test.ts:523` | KEEP | They exercise Clio rendering boundaries without simulating the full TUI. |
| Keybinding tests mention pi-tui defaults but do not mock frame output. | `tests/unit/keybindings.test.ts:29` | KEEP | They validate configuration data rather than terminal frames. |

## Duplicate Coverage Across Layers

| Behavior | Citations | Action | Justification |
|---|---|---|---|
| Model capability wiring appears in unit, integration, and e2e. | `tests/unit/model-selector.test.ts:158`, `tests/integration/providers/endpoint-lifecycle.test.ts:194`, `tests/e2e/interactive.test.ts:139` | KEEP | Each layer checks a different boundary: row construction, provider cache reset, and live picker display. |
| Evidence and memory behavior appears in unit and e2e. | `tests/unit/evidence-builder.test.ts:21`, `tests/unit/memory.test.ts:125`, `tests/e2e/cli.test.ts:340`, `tests/e2e/cli.test.ts:369` | KEEP | Unit tests own transformations while e2e owns public command routing. |
| Context file suppression is covered by unit and e2e. | `tests/unit/prompts.test.ts:265`, `tests/e2e/cli.test.ts:98` | KEEP | Unit covers prompt assembly and e2e covers the top-level flag reaching orchestrator boot. |
| Configure and targets are covered by direct command tests and binary e2e. | `tests/unit/cli-configure-targets.test.ts:36`, `tests/e2e/cli.test.ts:173` | MOVE | The direct command tests are integration-shaped XDG tests and should not count against unit. |

## Integration-Shaped Tests Under Unit

| Finding | Citation | Action | Justification |
|---|---|---|---|
| CLI auth/configure/reset command tests write scratch XDG state and shims. | `tests/unit/cli-auth.test.ts:74`, `tests/unit/cli-configure-targets.test.ts:40`, `tests/unit/cli-reset-uninstall.test.ts:18` | MOVE | They are filesystem-backed command integration tests. |
| Dispatch auth/concurrency tests allocate real data dirs and exercise domain wiring. | `tests/unit/dispatch-auth.test.ts:28`, `tests/unit/dispatch-concurrency.test.ts:229` | MOVE | They are domain integration tests, not pure unit tests. |
| Evidence, eval, memory, receipt, session, and self-dev tests write real artifacts. | `tests/unit/evidence-builder.test.ts:26`, `tests/unit/eval-runner.test.ts:19`, `tests/unit/memory.test.ts:28`, `tests/unit/receipt-verify.test.ts:80`, `tests/unit/session.test.ts:393`, `tests/unit/self-dev.test.ts:126` | MOVE | Their assertions depend on filesystem state. |
| Workspace and git tests spawn `git` or inspect real project directories. | `tests/unit/utils-git.test.ts:20`, `tests/unit/workspace/git-probe.test.ts:10`, `tests/unit/workspace/snapshot.test.ts:25` | MOVE | Real subprocesses and filesystem probes belong in integration. |
| Context, component, provider registry, prompts, grep, autocomplete, and tool registry tests create temp files. | `tests/unit/components-scan.test.ts:11`, `tests/unit/context/codewiki/indexer.test.ts:9`, `tests/unit/providers/registry.test.ts:68`, `tests/unit/prompts.test.ts:108`, `tests/unit/tools-grep.test.ts:10`, `tests/unit/slash-autocomplete.test.ts:55`, `tests/unit/tools-registry-wiring.test.ts:605` | MOVE | They are integration-shaped even when they are fast. |
| `core.test.ts` mixes pure concurrency tests with XDG filesystem tests. | `tests/unit/core.test.ts:24`, `tests/unit/core.test.ts:90` | TIGHTEN | Split XDG checks to integration and keep pure concurrency in unit. |

## CI Workflow Signal

| Finding | Citation | Action | Justification |
|---|---|---|---|
| The default workflow has one job and runs whatever `npm run ci` means. | `.github/workflows/ci.yml:17`, `.github/workflows/ci.yml:34` | TIGHTEN | The default PR job should call `ci:fast` explicitly so e2e is not hidden inside the default script. |
| The workflow has no nightly or tag-only full e2e lane. | `.github/workflows/ci.yml:3` | TIGHTEN | Full pty e2e should run on a separate schedule and tag push path. |
| The job installs `fd-find` before every gate. | `.github/workflows/ci.yml:29` | KEEP | Some tests and runtime probes use fd when present, and the install is cheap relative to Node setup. |

## Target Shape

Pre-commit gate: `npm run ci:precommit`.

- Includes `npm run typecheck`.
- Includes `npm run lint`.
- Includes `npm run test:boundaries`.
- Includes `npm run test:unit`.
- Budget: under 30s on a developer laptop.

Pre-push gate and CI default job: `npm run ci:fast`.

- Includes `ci:precommit`.
- Includes `npm run test:integration`.
- Includes `npm run build`.
- Budget: under 3min.

Nightly or tag-push gate: `npm run ci:full`.

- Includes `ci:fast`.
- Includes `npm run test:e2e:run` without rebuilding.
- Budget: under 10min.

Scripts:

- `test:unit`: `node --import tsx --test 'tests/unit/**/*.test.ts'`
- `test:integration`: `node --import tsx --test 'tests/integration/**/*.test.ts'`
- `test:boundaries`: `node --import tsx --test 'tests/boundaries/**/*.test.ts'`
- `test:e2e`: `npm run build && npm run test:e2e:run`
- `ci:precommit`: `npm run typecheck && npm run lint && npm run test:boundaries && npm run test:unit`
- `ci:fast`: `npm run ci:precommit && npm run test:integration && npm run build`
- `ci:full`: `npm run ci:fast && npm run test:e2e:run`
- `ci`: alias for `ci:fast`

Gate file mapping after execution:

- Pre-commit boundaries: every file under `tests/boundaries/**/*.test.ts`.
- Pre-commit unit: every remaining file under `tests/unit/**/*.test.ts`, limited to pure logic with no filesystem or subprocess setup.
- Pre-push integration: every file under `tests/integration/**/*.test.ts`, including the moved filesystem, XDG, git, and command tests from `tests/unit`.
- Full e2e: every file under `tests/e2e/**/*.test.ts`.

Planned moves from unit to integration:

- `tests/unit/agents-builtins.test.ts`
- `tests/unit/cli-auth.test.ts`
- `tests/unit/cli-configure-targets.test.ts`
- `tests/unit/cli-reset-uninstall.test.ts`
- `tests/unit/components-scan.test.ts`
- `tests/unit/context/codewiki/indexer.test.ts`
- `tests/unit/context/codewiki/tools.test.ts`
- `tests/unit/context/fingerprint.test.ts`
- `tests/unit/context/sibling-files.test.ts`
- `tests/unit/context/state.test.ts`
- `tests/unit/cwd-fallback.test.ts`
- `tests/unit/dispatch-auth.test.ts`
- `tests/unit/dispatch-concurrency.test.ts`
- `tests/unit/eval-evidence.test.ts`
- `tests/unit/eval-runner.test.ts`
- `tests/unit/evidence-builder.test.ts`
- `tests/unit/memory.test.ts`
- `tests/unit/prompts.test.ts`
- `tests/unit/providers/knowledge-base.test.ts`
- `tests/unit/providers/registry.test.ts`
- `tests/unit/receipt-verify.test.ts`
- `tests/unit/safety-rule-packs.test.ts`
- `tests/unit/self-dev.test.ts`
- `tests/unit/session-compaction-entry.test.ts`
- `tests/unit/session.test.ts`
- `tests/unit/slash-autocomplete.test.ts`
- `tests/unit/tools-grep.test.ts`
- `tests/unit/tools-registry-wiring.test.ts`
- `tests/unit/utils-git.test.ts`
- `tests/unit/workspace/git-probe.test.ts`
- `tests/unit/workspace/project-type.test.ts`
- `tests/unit/workspace/snapshot.test.ts`

## Validation Measurements

To be filled after execution:

| Gate | Before | After |
|---|---:|---:|
| `npm run ci:precommit` | not split | TBD |
| `npm run ci:fast` | not split | TBD |
| `npm run ci:full` | old `npm run ci`: 60.64s e2e plus 9.37s test phase | TBD |
