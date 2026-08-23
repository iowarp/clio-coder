# Inventory: every way Clio is exercised

One row per harness, driver, suite, or script that runs Clio or stands in for
it, as of the v0.3.4 harness cleanup. Each row says what it drives (headless
`run`, the CLI, the TUI, or the library in-process), whether the model is real
or stubbed, what it proves, who runs it, and a decision with its reason.
Duplicates are named as duplicates. Rows marked **deleted** or **moved** record
the state before this cleanup so the history is readable without `git log`.

"Machinery" means the claim is about Clio's own behavior with the model
stubbed; a pass proves the plumbing, not that a model would do the thing.
"Behavioral" means a real model answered and the assertion is on what Clio did
with the answer.

## CI (deterministic, offline, `npm test` / `npm run ci`)

| Entry | Drives | Model | Proves | Decision |
| --- | --- | --- | --- | --- |
| `tests/contracts/**` (about 330 files) | library, in-process | stubbed or none | Domain contracts. Machinery. | keep |
| `tests/smoke/cli*.test.ts`, `doctor-honesty`, `eval-fleet`, `resume-replay`, `memory-repository-scope`, `sigint-tool-children`, `acp-server`, `compile-cache-*`, `*-lazy-load`, `pack-install` | built CLI over pipes (`runCli`) | stubbed (`openai-compat-fixture`) or none | The binary's observable behavior: exit codes, JSON contracts, ACP over stdio, the installed package, lazy loading. Machinery. | keep. The prompt counted these as PTY suites; they are not, they pipe. |
| `tests/smoke/tui-width-matrix.test.ts` | TUI in `tests/harness/pty.ts` | none (no turn) | Nothing written outside the frame at each release size; cursor, bracketed paste, and kitty keyboard stack restored; NO_COLOR drops color; a single Ctrl-C leaves the terminal usable. Needs a PTY: a pipe has no width and no raw mode. | keep |
| `tests/smoke/instant-shell-pty.test.ts` | TUI in PTY | none | Keystrokes accepted before hydration survive a resize and a Stage-1 import failure; SIGTERM routes through the terminal lease; double Ctrl-C works before hydration. Needs a PTY: raw mode and signal delivery. | keep |
| `tests/smoke/render-trace-pty.test.ts` | TUI in PTY | stubbed | Input and resize correlate to committed frames; forced PTY cleanup is bounded and idempotent; provider deltas pace to a final frame under real PTY backpressure. Needs a PTY: backpressure and frame commits only exist on one. | keep |
| `tests/contracts/eval-soak-suite.test.ts` | eval runner, in-process, with a fake Clio | stub that seals receipts on purpose | The soak gate can fail: a receipt that does not authenticate, or no receipt at all, fails the gate; the fixture's known-answer test is red before repair. Now loads all four soak YAMLs. | keep, extended |
| `tests/contracts/scicode-adapter.test.ts`, `benchmark-token-accounting.test.ts` | the Python adapters as subprocesses | fake `clio-coder run --json` | The adapters generate tasks, grade a JSON-reference fixture, and fold usage from `message_end` exactly once. | keep; these are what keep `clio_usage.py` honest |
| `scripts/shard-tests.mjs` (`npm test`) | test runner | n/a | Deterministic lane assignment by measured cost. | keep |
| `scripts/repeat-tests.mjs` (`npm run test:repeat`) | test runner | n/a | The smoke lane in a seeded shuffle, twice; catches order and timing flakes. CI. Load-bearing: `.github/workflows/flake-hunt.yml` runs it weekly. The boundary lane it once carried is gone (now hygiene under lint), which is why the default pattern is smoke only. | **moved** from `tests/harness/` to `scripts/`: it is a runner, not a harness |
| `scripts/check-hygiene.ts` (`npm run lint`) | static | n/a | Import boundaries, script pins, doc drift, packaging. | keep |

### Harness modules (`tests/harness/`)

All imported; none orphaned. `working-set-session.ts` belongs to the context session.

| Module | Imported by | Role |
| --- | --- | --- |
| `spawn.ts` | 31 suites | run the built CLI with pipes; `seedDoctorFix` template |
| `scratch-env.ts` | 55 suites | the one isolated-home implementation (child and in-process) |
| `pty.ts` | 3 PTY suites, `benchmarks/internal/pty-drive.ts` | the one pseudo-terminal |
| `openai-compat-fixture.ts` | 11 suites (`cli`, `acp-server`, `resume-replay`, `render-trace-pty`, `pack-install`, `sigint-tool-children`, `compile-cache-descendants`, `memory-repository-scope`, `usage-report`, `gemma-channel-filter`, `skill-evals`) | stub OpenAI-compatible provider |
| `fake-lmstudio-server.ts` | `lmstudio`, `lmstudio-instance-resolution`, `lmstudio-configure` | stub LM Studio management API |
| `fake-ssh.ts` | `worker-transport` | stub SSH fleet node |
| `dispatch.ts`, `dispatch-stub-context.ts`, `gate-fabric.ts`, `bounded-worker.ts`, `worker-attestation.ts`, `agent-recipe.ts`, `receipt.ts` | dispatch, fleet, ledger, worker contracts | dispatch test fabric |
| `clock.ts` | 14 suites | steppable clock |
| `tmp-root.ts` | every runner | scratch root for `mkdtemp` |
| `codewiki-`, `runtime-`, `tool-module-graph.ts` | `pack-install`, lazy-load smokes | module-graph assertions |

## Operator-run, real model (`benchmarks/internal/`, never CI)

| Entry | Drives | Model | Proves | Decision |
| --- | --- | --- | --- | --- |
| `npm run live:smoke -- --target <id>` (`live-smoke.ts`) | headless `run` | real | The target answers through Clio's provider path; optional opencode/copilot ACP delegation. Behavioral. | **merged**: replaces `scripts/live-smoke.mjs`; env gate replaced by `--target` |
| `npm run live:recon -- --target <id>` (`live-recon.ts`) | `eval run --suite` | real | Stale wiki is not answered from alone; "orient me" dispatches Scout. Behavioral. | **merged**: replaces `scripts/live-eval-recon.mjs`; only the stale-wiki seeding is driver code, the rest is the eval runner |
| `npm run live:fleet-dispatch -- --target <id>` (`live-fleet-dispatch.ts`) | headless `run --json` | real | Scout, 1–6 spot-checks, detached Debugger with real briefing, one steer, monitor/wait/collect order, receipt and ledger agreement, workspace unchanged. Behavioral. | **merged**: replaces `scripts/live-eval-fleet-dispatch.mjs`, typed, preamble removed |
| `npm run live:tui -- --target <id> --workspace <dir> --send ...` (`pty-drive.ts`) | TUI in `tests/harness/pty.ts` | real | What a person sees; turns settle off the ledger; `/quit` exits 0; transcript, raw bytes, ledger, and report written. Behavioral. | **new**: the knowledge from `.superpowers/scratch/v0.3.4-live-driver.mjs` and `ws-drive*.mjs` (ready regex `ctx `, ledger-based settlement, sidecar counts), made a committed command |
| `npm run live:home -- --target <id>` (`live-home.ts`) | nothing | n/a | Prints a scratch home's exports so an agent can launch Clio in a tmux or herdr pane with the same isolation. | **new**, for `SKILL.md` |
| `clio-coder eval run --suite benchmarks/soak/clio-soak.yaml --target <id> --model <m>` and the `-boundary`, `-chaos`, `-loop` suites | eval runner | real (`clio-soak`, `-chaos`, `-loop`) or none (`-boundary`) | Receipts seal and authenticate, outcome matches exit, no orphaned children, usage counted once, write boundaries roll back, loops stay bounded. Machinery under a real model. | keep. The runner was never orphaned; it is the product's own `eval run`, now documented in `docs/evals-internal.md` and `benchmarks/README.md` |
| `benchmarks/soak/candidate-fixtures.md` | nothing | n/a | Five fixture ideas, none scheduled. | keep; it exists so the ideas are not re-derived |

## Community workload drivers (`benchmarks/community/`, Python, never CI except the two contracts above)

Each survives because it does something Clio cannot: fetch an external dataset, render its prompts, and score against the upstream grader.

| Entry | Drives | Model | Does what Clio cannot | Decision |
| --- | --- | --- | --- | --- |
| `swe-bench-lite/swebench_clio.py` | `clio-coder run --json` per instance | real | Loads `princeton-nlp/SWE-bench_Lite`, clones `repo@base_commit`, extracts the source-only patch into `predictions.jsonl` for the official harness. | keep |
| `swe-bench-lite/recompute_patches.py` | nothing | n/a | Rebuilds predictions from existing checkouts without a model run. | keep |
| `terminal-bench/tb_clio_coder/` | installed agent inside the tb container | real | Implements Terminal-Bench's `AbstractInstalledAgent`; installs Clio from a tarball and renders settings from `CLIO_CODER_MAIN_URL`/`WORKER_URL` because the container has no Clio config. | keep; the env is its interface |
| `scicode/scicode_clio.py` | `clio-coder eval` task files and `run --json` | real | Renders SciCode's multi-step prompts and grades against the upstream HDF5 targets through the SciCode package. | keep |
| `human-eval/humaneval_clio.py` | `clio-coder run --json` or eval tasks | real | Fetches HumanEval, extracts the completion, runs the official `human_eval` checks, computes pass@k. | keep |
| `clio_usage.py` | n/a | n/a | Re-publishes the usage an adapter observed on its own stdout in the one shape `clio-coder eval` folds, because the eval sees only the adapter's stdout. This is the only "reimplementation" kept, and the token-accounting contract pins it to `token-stream.ts`. | keep |
| `result_manifest.py`, `uv_command.py`, `requirements.txt`, `pyrightconfig.json` | n/a | n/a | The results convention, portable `uv run` prefixes, dependency list, adapter typecheck config. | keep |
| `clio_fleet.py`, `fleet.example.json` | nothing | n/a | A private-fleet JSON loader with profiles and env overrides. Imported by nothing after the adapters dropped their guarded import; `bench:tb` only printed it. Reimplemented `clio-coder targets`. | **deleted** |
| `MANIFEST.md` | n/a | n/a | Restated `README.md`. | **deleted** |
| `terminal-bench/runs/latest/{manifest,summary}.json` | n/a | n/a | Untracked on disk (ignored), written by the tb agent when it schedules an episode: `status: scheduled`, `resolved: 0`, `episode: null`, model `qwen3.8-27b` on `dynamo` with worker `Qwopus-MoE-35B` on `mini`, 2026-08-16. Evidence of one scheduled episode and nothing else; no consumer. | **deleted** |
| `bench:swe`, `bench:scicode`, `bench:tb` npm scripts | n/a | n/a | Ran `python3` against adapters whose documented runner is `uv run --no-project`. | **deleted** |

## Deleted drivers

| Entry | Was | Why it is gone |
| --- | --- | --- |
| `scripts/live-verify-dispatch-routing.mjs` (1,451 lines) | eight P0 routing scenarios against a real model and a real SSH fleet node with a dead-port server | Sprint-specific verification (`v6_20260713`-era). Each scenario's deterministic contract exists: `dispatch-route-quality`, `dispatch-capacity-lease`, `dispatch-admission-queue`, `fleet-failover`, `dispatch-execution-role`, `worker-attestation`, `dispatch-review-compete`. No documented consumer after the sprint. |
| `scripts/lifecycle-matrix.mjs` (1,286 lines, 20 cases) | the packaged tarball installed into a prefix, driven through the installed launcher and a PTY | Cases 1–4, 10–17, 20 are `tests/smoke/pack-install.test.ts` plus `upgrade-path`, `session-state-uninstall`, `install-repair-stamp`, `dispatch-state-uninstall`, `cli-discoverability`; 5–8 are `configure-cli`, `cli-recovery-messages`, `doctor-honesty`; 18–19 duplicate `tui-width-matrix`; 9 (the live turn) is `live:smoke`. A second copy of CI outside CI. |
| `scripts/live-smoke.mjs`, `live-eval-recon.mjs`, `live-eval-fleet-dispatch.mjs` | env-gated live drivers | Merged into `benchmarks/internal/` as above; the shared 70-line preamble became `live-target.ts`. |
| `.superpowers/scratch/v0.3.4-live-driver.mjs`, `ws-drive.mjs`, `ws-drive2.mjs`, `ws-drive3.mjs` | ad hoc TUI drives of the working-set engine against `lmstudio` at `127.0.0.1:1234` (`qwen3.8-27b-dynamo`) and `openai-codex` (`gpt-5.6-terra`) | Their knowledge is `live:tui`. Gitignored; deleted; `README.md` left saying what belongs there. |
| `.superpowers/scratch/context-replay-readme.py` | generated the context-replay README from the JSON tables | Superseded by `clio-coder context replay` writing its tables (context session). Deleted. |
| `/tmp/clio-v034-cloud-*`, `/tmp/clio-v034-local-*`, `/tmp/v034-*.log` | the v0.3.4 live-run scratch trees and CI logs | Evidence captured before deletion: cloud run (`gpt-5.6-terra`) produced 1 eviction event, 3 items, one assistant turn attributed `working_set_evict`, no compaction; local run (`qwen3.8-27b-dynamo`) produced 1 eviction event, 4 items, the attribution, 1 compaction summary carrying `<recallable-refs>`, and a resumed transcript showing both. Both facts are already in the v0.3.4 devlog. Deleted. |

## Answers to the open questions

- **Is `repeat-tests.mjs` load-bearing?** Yes. `.github/workflows/flake-hunt.yml` runs `npm run test:repeat` as the weekly shuffled smoke rerun, and the hygiene check pins the script. The boundary lane it used to carry is gone; smoke is what remains. Moved to `scripts/`.
- **One command with modes, or four purposes?** Three purposes and one duplicate. Smoke (does the target answer), recon and fleet-dispatch (does the model behave as documented; two scenarios of one kind), and the lifecycle matrix (a copy of CI). They shared one preamble, which is now `live-target.ts`; they keep separate entry points because their assertions share nothing.
- **Which stub fixtures are still referenced?** All three: `openai-compat-fixture.ts` by eleven suites, `fake-lmstudio-server.ts` by the three LM Studio contracts, `fake-ssh.ts` by `worker-transport`.
- **Does `benchmarks/soak` have a runner?** Yes: `clio-coder eval run --suite <file> --target <id> --model <m>`. `clio-soak.yaml` was exercised by a contract test; the other three were loaded by nothing, and now are.
- **What produced `terminal-bench/runs`, and does anything read it?** `tb_clio_coder/clio_coder.py` writes a scheduled-episode placeholder there when `CLIO_CODER_TB_RESULT_DIR` is unset. Nothing reads it. It was untracked; removed from disk.
- **Which scratch drivers encoded knowledge?** `v0.3.4-live-driver.mjs`: the local and cloud target shapes, the `ctx ` ready regex, ledger-based turn settlement, sidecar reading, the Escape-before-next-command detail. All of it is in `pty-drive.ts` and `SKILL.md`.

## Findings for `src/` (not changed here)

Raised, not acted on; each is a judgment for the product owner.

1. `src/cli/clio.ts` reads `CLIO_CODER_TEST_STAGE1_FAIL` and `CLIO_CODER_TEST_STAGE1_DELAY_MS`: fault injection for `instant-shell-pty.test.ts` living in the product entry point.
2. `src/cli/upgrade.ts` reads `CLIO_CODER_TEST_UPGRADE_NO_NETWORK`: a test-only switch in the upgrade path.
3. `src/domains/eval/metrics/chaos-stream.ts` and `runners/external-command.ts` parse the `clio_soak_chaos` marker emitted by `benchmarks/soak/fixtures/chaos-sigint-tool/chaos-sigint-tool.mjs`: product code that knows one benchmark fixture's wire format.
4. `clio-coder dev components|evolve|share` is documented as "harness instruments" and each also resolves without the `dev` prefix: a namespace whose reason for existing is the harness, shipped in the binary.
5. `CLIO_CODER_NO_UPDATE_NOTIFIER` is set by the Terminal-Bench agent's `install-clio.sh` and read by nothing in `src/` (already noted in `docs/config-knobs-audit.md`).
6. `CLIO_CODER_INSTANT_SHELL`, `CLIO_CODER_RENDER_TRACE`, `CLIO_CODER_BUS_TRACE`, `CLIO_CODER_MEMORY_TRACE`, `CLIO_CODER_TRACE_BOOT` are instrumentation knobs; they are documented in `docs/environment-variables.md` and are not test-only, so they are listed for completeness rather than as a problem.

## Counts

Keep 29 rows (10 CI, 10 harness modules, 2 operator-run, 7 community), merge 3
(the three live drivers into `benchmarks/internal/`), new 2 (`live:tui`,
`live:home`), move 1 (`repeat-tests.mjs`), delete 9 (`clio_fleet.py` with its
example, `MANIFEST.md`, the placeholder run, the `bench:*` scripts,
`live-verify-dispatch-routing.mjs`, `lifecycle-matrix.mjs`, the four scratch
drivers, `context-replay-readme.py`, the `/tmp` leftovers).

## Live results recorded on 2026-08-22 (`zbook`, `qwen3.8-27b-dynamo`, thinking off)

- `live:smoke`: PASS, twice (before and after the workspace isolation fix).
- `live:tui`: exit 0; one prompt settled with two tool results, `/context` overlay opened, `/quit` clean.
- `live:recon`: first run failed before any model call because the eval runner's per-item state dir under `os.tmpdir()` tripped `CLIO_CODER_REQUIRE_HOME_PREFIX` (a defect inherited from `live-eval-recon.mjs`); fixed by giving the home `TMPDIR`, pinned by `tests/contracts/live-home.test.ts`. Second run, 66,308 tokens in 51 s: `stale-wiki` PASS (`wiki.staleAcknowledged=true`); `scout-routing` FAIL, `dispatch.count=0`, the model answered the orientation itself. A behavioral result for this model, not a harness fault.
- `live:fleet-dispatch`: FAIL at the 600 s turn budget. The ledger shows `context → tasks → dispatch(scout, receipt succeeded) → 4 reads → dispatch(debugger, detached) → monitor → steer → monitor`, still waiting on the Debugger, which shares the single local slot. Two harness weaknesses seen in that run are now fixed and pinned by `tests/contracts/live-fleet-dispatch.test.ts`: `runCli` rejects with the partial capture (`RunCliTimeoutError`) and the driver writes `stdout.jsonl` on timeout too; the workspace-unchanged check excludes exactly `.clio-coder/codewiki.json`, `.clio-coder/state.json`, and their directory entry (`workspace-snapshot.ts`), and still counts anything else under `.clio-coder/`. The run itself has not been repeated.
