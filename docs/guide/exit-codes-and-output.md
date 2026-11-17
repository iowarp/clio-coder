# Exit Codes and Machine-Readable Output

Process exit codes, stdout/stderr contracts, `--help` guarantees, and JSONL stream schemas across CLIO Coder CLI commands ([index.ts](../../src/cli/index.ts), [run.ts](../../src/cli/run.ts), [print.ts](../../src/cli/modes/print.ts), [run-json-schema.ts](../../src/cli/modes/run-json-schema.ts)).

## Exit code contract

Interactive sessions, headless main-agent `run`, and `run --agent` exit `128 + signal` on terminating signals (`129` SIGHUP, `130` SIGINT, `143` SIGTERM). `run` interrupted by SIGINT while reading `@file` inputs exits `130` before sending any request; `clio-coder configure` exits `130` if exited before saving a first target ([configure-import.ts](../../src/cli/configure-import.ts)).

| Code | Meaning | Trigger conditions |
| --- | --- | --- |
| `0` | Success | Clean completion, `--version`, `--help`, `--dry-run`, declined `reset`/`uninstall`, `upgrade` no-op, passing checks/verifies. |
| `1` | Operational failure | Runtime/provider error; Node.js `< 22.19.0` ([index.ts](../../src/cli/index.ts)); `doctor` error findings; `run` stream without response, `stopReason=length` without terminal tool, empty closing message after tool calls, `limitation`, unresolved block with no write (`noop` even without `--fail-on-noop`, except `--turn-mode answer\|proposal` which exits `0` and prints `clio-coder run: answered with <N> blocked call(s): ...` to `stderr`; [print.ts](../../src/cli/modes/print.ts)), `--fail-on-noop`, `dispatched_worker_failed`, deterministic dispatched worker failure (`merge_withheld`, `worker_no_work`, `worker_partial_work`, `worker_removed_tests`, `information_flow_blocked`; see table below); `run --agent verifier` with `verdict: "fail"` (settled run outcome stays `succeeded`); stdout write error other than `EPIPE` (`clio-coder run: cannot write output: <message>` on `stderr`, [output-guard.ts](../../src/cli/output-guard.ts)); `reset`/`uninstall` keeping an unproven root; lifecycle/telemetry/playbook failures. |
| `2` | Usage / admission / layout refusal | Unknown command/flag, missing positional, invalid startup flag placement (see [Flag positioning](#flag-positioning)), unsupported flag on `run --agent`, unknown target or recipe, unselectable/non-chat model, multiple usable routes with no default target and no `--target`, single route without model and no `--model`, task piped to bare `clio-coder` without `CLIO_CODER_INTERACTIVE=1`, `--autonomy yolo` as root outside a container or under `CLIO_CODER_AUTONOMY_CEILING`, newer-home version mismatch without `CLIO_CODER_ALLOW_OLDER=1` (headless/ACP), unsafe `CLIO_CODER_*_DIR` layout, conflicting lifecycle flags (`reset --all` with a level, `upgrade --restart` with `--json` or `--post-install`), or `reset`/`uninstall` non-TTY without `--force`/`--dry-run`. |
| `3` | Permission refusal / judge streak | Dispatched native or Claude SDK worker stopped after 3 `execute`-class policy refusals (`deny`/`judge`/`main` mode) or on first refusal of any class (`fleet.permissions.mode: fail`) — `outcomeDetail` starts with `permission_required` ([worker-refusals.ts](../../src/engine/worker-refusals.ts), [worker-runtime.ts](../../src/engine/worker-runtime.ts)). Main-agent `run --autonomy yolo` halted on safety-judge block streak (`outcomeDetail: "judge-streak"`, exits `3`; [autonomy-window.ts](../../src/domains/safety/autonomy-window.ts)): `` clio-coder run: judge-streak: the safety judge blocked too many calls (<detail>), so yolo ended the run after <N> tool calls, <M> min, <T> tokens; review it, then `clio-coder run --continue "<prompt>"` resumes with a fresh window ``. A parent `run` dispatching a worker that hits `3` reports `dispatched_worker_failed` and exits `1`; `run --agent` passes `0`, `2`, `3`, `4` through and maps other non-zero worker codes to `1` ([run.ts](../../src/cli/run.ts)). |
| `4` | Spend or autonomous cap | `safety.limits.sessionCostUsd` (default `5` USD, `0` disables) or `run --max-cost-usd <N>` reached (`outcomeDetail: "budget_ceiling"`, [budget.ts](../../src/domains/scheduling/budget.ts)): `budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling<per-call>; raise safety.limits.sessionCostUsd` or `budget_ceiling: this run's priced spend $<spent> reached its --max-cost-usd $<cap> cap<per-call>`, where `<per-call>` is ` with ~<n> context tokens per call` when request size is known. Spend strings mark estimates as `~$<x> est` and partial unpriced sums as `$<x> +?`; [renderUsd](../../src/core/telemetry/render.ts) uses 2 decimals at `>= $0.01`, 4–8 decimals below `$0.01`, and scientific notation below `$0.00000001`. Unpriced calls are excluded; priced calls missing server usage estimate from request size and streamed output; prior session spend is excluded from `--max-cost-usd`. Interactive sessions show `[budget] Session priced spend <spend> reached.<perCall> Paid requests are paused; raise safety.limits.sessionCostUsd to <n> to resume.` (or `exceeded.`). Main-agent `run --autonomy yolo` hitting `autonomousToolCalls`, `autonomousMinutes`, or `autonomousTokens` exits `4` (`outcomeDetail: "autonomous-cap"`, [autonomy-window.ts](../../src/domains/safety/autonomy-window.ts)): `` clio-coder run: autonomous-cap: yolo paused at the <detail> after <N> tool calls, <M> min, <T> tokens; review it, then `clio-coder run --continue "<prompt>"` resumes with a fresh window ``. |
| `5` | Unscripted question | Main-agent `clio-coder run --answers <file.yaml>` met a question the file does not script, or whose matching entry chooses an option not on offer: the round is cancelled, the run settles `failed` with `outcomeDetail: "unscripted"`, and stderr reads `clio-coder run: unscripted question (<header and id, or the question's first line>): <reason>; add an entry for it to <file> and run again` ([run-answers.ts](../../src/cli/run-answers.ts)). See [Script the author with --answers](commands-and-modes.md#script-the-author-with---answers). |
| `75` | Install / upgrade busy (`EX_TEMPFAIL`) | Non-mutating retry signal: `.install-lock` held in installer, `upgrade` blocked by active `pid@host` processes or update lease, or launcher 120s timeout waiting for concurrent update. |
| `124` | Run timeout | `clio-coder run --timeout <seconds>` elapsed (matching `timeout(1)`; an external SIGTERM still exits `143` with outcome `canceled`). Runs coordinated shutdown, signals running bash process groups, settles `timed_out`/`failed` (or `canceled` before exit `124` under `--agent`, or no run record if fired pre-turn). |
| `141` | Broken stdout pipe (EPIPE / SIGPIPE) | Consumer closed `stdout` (`clio-coder run ... \| head -1`). Triggers coordinated shutdown, drops later stdout writes, settles run/session, exits `141` ([index.ts](../../src/cli/index.ts)). |

### Worker failure outcomes (exit `1`, no automatic retry)

| Code | Preserved artifact & meaning |
| --- | --- |
| `merge_withheld` | Task worktree branch kept unmerged (e.g., worker self-validation failed, unverified check asked, or diff removed tests); inspect and merge manually ([extension.ts](../../src/domains/dispatch/extension.ts), [backoff.ts](../../src/domains/dispatch/backoff.ts)). |
| `worker_no_work` | Edit worker changed nothing (no tools, `limitation`, denied asks, or refused writes); empty task worktree discarded ([extension.ts](../../src/domains/dispatch/extension.ts)). |
| `worker_partial_work` | Edit worker modified files but opened its report saying work could not finish; task worktree changes committed unmerged under `partial: <task>` ([merge-gate.ts](../../src/domains/dispatch/merge-gate.ts)). |
| `worker_removed_tests` | Edit directly on checkout (no task worktree) removed existing tests; edits remain on checkout for review ([extension.ts](../../src/domains/dispatch/extension.ts)). |
| `information_flow_blocked` | Policy blocked restricted context from reaching the requested destination; change rule/destination and start a new session ([backoff.ts](../../src/domains/dispatch/backoff.ts)). |

### Subcommand-specific exit codes

| Subcommand | Codes |
| --- | --- |
| `fleet events` | `0` sealed & verified, `1` read/integrity error, `2` usage, `3` intact unsealed journal, `4` `--follow` stopped because fleet can no longer seal ([fleet-events.ts](../../src/cli/fleet-events.ts)). |
| `telemetry verify` | `0` verified, `1` failed seal or unsealed, `2` usage or missing/unreadable scope ([telemetry-verify.ts](../../src/cli/telemetry-verify.ts)). |
| `telemetry doctor` | `0` healthy, `1` failed seal / unreadable consent / damaged journal lines / read error, `2` usage ([telemetry-doctor.ts](../../src/cli/telemetry-doctor.ts)). |
| `telemetry share` | `0` archive written/sent/previewed, `1` nothing to share or failure, `2` usage or non-TTY without scope ([telemetry-share.ts](../../src/cli/telemetry-share.ts)). |
| `telemetry import` | `0` placed or identical already present, `1` failed verify / unreadable / differing scope, `2` usage ([telemetry-share.ts](../../src/cli/telemetry-share.ts)). |
| `telemetry consent`, `prune` | `0` success, `1` failure, `2` usage ([telemetry.ts](../../src/cli/telemetry.ts)). |
| `session list` | `0` success, `2` usage ([session.ts](../../src/cli/session.ts)). |
| `session terminate` | `0` requested/signaled/released, `1` unknown live session, `2` usage or refused `--force` ([session.ts](../../src/cli/session.ts)). |
| `research start\|resume\|report` | `0` completed or budget cap (`max-iterations`, `max-wall-minutes`, `max-cost-usd`), `1` error / noisy A/A / unenforceable spend / `report` regrade mismatch, `2` usage, `129`/`130`/`143` signal ([research-and-arena.md](research-and-arena.md#exit-codes)). |
| `report` | `0` sent/opened/written/previewed, `1` send error or refused bundle, `2` usage or non-TTY without `--yes`, `3` likely duplicate or newer release found (draft saved; [troubleshooting.md](troubleshooting.md#report-a-problem-to-the-maintainers)). |
| `store` | `0` success (and `store rm`/`rm-tag` dry-run without `--yes`), `1` operational error or `store verify` mismatch, `2` usage ([store.md](store.md)). |
| `campaign run` | `0` every entry was run, whatever each entry's status, `1` the campaign itself failed, `2` usage (including an invalid roster or answers file, a missing fixture, or an `--out` that holds files or lies inside the fixture), the signal's code when stopped ([campaign.ts](../../src/cli/campaign.ts)). |
| `telemetry tokens` | `0` report printed, `1` unknown or unreadable session, `2` usage ([telemetry-tokens.ts](../../src/cli/telemetry-tokens.ts)). |
| `arena run\|show\|vote` | `0` success, `1` match failed / unknown match / `show --reveal` before vote / duplicate `vote` without `--replace`, `2` usage, `129`/`130`/`143` signal ([arena.ts](../../src/cli/arena.ts)). |

## `--help` and flag positioning

Subcommand `--help` exits `0` with zero side effects or network probes, writing to `stdout` — except `clio-coder run --help --json` and `clio-coder run --help --json-events <mode>`, which write help to `stderr` so `stdout` stays clean ([run-help.ts](../../src/cli/run-help.ts)).

### Flag positioning

Startup flag rules ([index.ts](../../src/cli/index.ts), [argv.ts](../../src/cli/argv.ts)); directory overrides use `CLIO_CODER_*_DIR` / `CLIO_CODER_HOME` ([environment-variables.md](environment-variables.md)):

| Flag(s) | Valid position | Refusal message (`stderr`, exit `2`) |
| --- | --- | --- |
| `--version`/`-v`, `--help`/`-h` | Before subcommand (afterwards belongs to subcommand) | Subcommand parser error (e.g. `clio-coder paths -v` prints `unknown flag: -v`). |
| `--skill`, `--no-skills` | Either before or after `run` (interactive, `run`, `acp`) | Before other subcommands: `<flag> applies only to the interactive session, clio-coder run, and clio-coder acp; clio-coder <cmd> does not honor it.` |
| `--api-key`, `--no-context-files`/`-nc` | Before `run`/`acp`/interactive only | After subcommand: `<arg> is a global option and must come before the subcommand: clio-coder <usage> <command> ...` (e.g. `clio-coder run: --api-key is a global option and must come before the subcommand: clio-coder --api-key <key> run ...`). Before other subcommands: `<flag> applies only to the interactive session, clio-coder run, and clio-coder acp; clio-coder <cmd> does not honor it.` |
| `--autonomy` | Interactive (pre-command) or *after* `run`/`acp` | Before `acp`: `--autonomy before a subcommand applies to the interactive session only; pass it after it: clio-coder acp --autonomy <level>`. Before any other subcommand: `--autonomy before a subcommand applies to the interactive session only. For a headless turn use: clio-coder run --autonomy <level> "<task>"` |
| `--allow-tools`, `--delegate-tools` | Interactive (pre-command) or *after* `run`/`acp` | Before `run`/`acp`: `--allow-tools and --delegate-tools before a subcommand apply to the interactive session only; pass them after it: clio-coder <run\|acp> --allow-tools <names>`. Before other subcommands: `--allow-tools and --delegate-tools apply to the interactive session, clio-coder run, and clio-coder acp; clio-coder <cmd> does not honor them.` |
| `--demo`, `--no-demo`, `--session-file` | Interactive only (no subcommand) | `--demo and --no-demo apply to interactive sessions only; start clio-coder without a subcommand.` / `--session-file applies to the interactive session only; start clio-coder without a subcommand.` |
| `--with-panes` | Interactive only (before command, no subcommand) | Before subcommand: `--with-panes applies only to the interactive session; clio-coder <cmd> does not honor it.` After subcommand: `--with-panes applies only to the interactive session; start it with clio-coder --with-panes` |

## Streams and headless `run` behavior

`clio-coder run` writes only the final answer (or NDJSON frames) to `stdout`; all diagnostics, permission denials, `observed` summaries, `--verify` results, `Recording manifest (relative to Clio state): <path>` (`--agent --record`), and pre-send attachment interrupts (`clio-coder run: interrupted while reading file attachments; nothing was sent`, exit `130`) go to `stderr` ([print.ts](../../src/cli/modes/print.ts), [run.ts](../../src/cli/run.ts)). Argument validation precedes state reads (`#123`).
- Unconfirmed permissions in headless mode return `HEADLESS_PERMISSION_DENIED_REASON` (`clio-coder run cannot confirm permission requests; rerun interactively to approve this action.`) as a tool error so the model can adapt or call `limitation` ([headless-permission.ts](../../src/core/headless-permission.ts)).
- Runs that called `>= 1` tool emit one `stderr` line after completion (`headless-observed.ts`):
  `clio-coder run: observed: <N> tool call(s), <M> refused [· <W> write(s)] [· check(s) passed: <names>] [· check(s) failed: <names>] [· no check observed after the last write | no checks declared in the workspace]` (max 3 check names per list; does not alter stdout or exit code).
- `--verify "<cmd>"` runs each check after the turn settles, logs to `stderr`, and emits `verify` (`--json-events full`) or `turn_end.verify` (`--json-events terminal`); it does not override the run's exit code ([print.ts](../../src/cli/modes/print.ts)).

### Failures before output starts

When `--json` or `--json-events` fails before writing any frame (`stdout` still empty), the failure wrapper emits `{"type":"turn_end","startedAt":...,"endedAt":...,"exitCode":<n>,"text":"","error":...,"outcome":...}` (`outcome` is `timed_out` for exit `124`, else `failed`) so `stdout` is never empty on non-zero exit. In full mode, a `run_end` frame follows ([run-failure.ts](../../src/cli/run-failure.ts)).

### The `run_end` frame

Every full-mode `clio-coder run --json` / `--json-events full` stream ends with one `run_end` frame (`RUN_JSON_SCHEMA_VERSION = 1`), including after `--timeout` or signals:

```json
{"type":"run_end","startedAt":"...","endedAt":"...","exitCode":1,"outcome":"failed","outcomeDetail":"noop","error":"...","safety":{}}
```

`outcome` is `succeeded`, `failed`, `canceled`, or `timed_out`; `outcomeDetail`, `error`, and `safety` are present when applicable. Always judge overall success/failure from `run_end` (full mode) or the synthesized `turn_end` (terminal mode), not from model-level `agent_end` ([run-json-schema.ts](../../src/cli/modes/run-json-schema.ts)).

### Dispatched agent output (`clio-coder run --agent`)

In text mode (`formatDispatchHumanOutput`, [run-output.ts](../../src/cli/run-output.ts)), `stdout` prints up to six sections in order (redacting URL credentials):

1. **Answer**: Last assistant text (prior attempts discarded on failover), or `sealedResultAnswer` when no prose was written (`mutation-report`: `summary`, `observations`, and `changed: <paths>` when `mutatedPaths` is non-empty; `scout-report` / `research-report`: `- <claim> [(<path>:<line>)|(<evidence>)]`; `world-knowledge-report`: `synthesis` and `facts`; `provenance-report`: `confirmedFacts`; `oracle-report`: `verdict`, `challenge`; fallback `output.text.trim()`). Cut-off partial output passes through `holdCutOffText`.
2. **`Failed checks:`** (optional): Present only when `verifier-report` has failed checks (`- <name>: <evidence>`), causing exit `1`.
3. **`Not verified:`** (optional): Typed unchecked items from final non-truncated sealed reports (each clipped to 400 chars): `mutation-report` (`declaredChecks`, failed `validations`), `code-report` (failed `checks`), `scout-report` (`degradedReason`, `ungroundedClaims`, ungrounded findings, `proposedSubtasks` when `needsSplit`), `world-knowledge-report` (`Discovery: unavailable|caller-supplied-only`, `uncertainties`, `followUpVerification`), `provenance-report` (`missingEvidence`, `nextInspections`), `debugger-report` (`Reproduction: unknown|not-reproduced`).
4. **`Failed: <headline>`** (optional): Shown when `receipt.exitCode !== 0` and a worker failure headline applies.
5. **`Finished with a caveat: <words>`** (optional): Shown when `receipt.exitCode === 0` and calls were refused/guarded or contract conformance failed (excludes `no-tools`).
6. **`result:` summary line**:
   `result: <runId> agent=<id> exit=<n>[ verdict=<v>[ failed_checks=<N>]][ verification=unverified not_verified=<N>] target=<id> requested_model_id=<wireId>[ response_model_id_observation=...][ gateway=litellm route=...] tokens=<n>[ reasoning=<n>][ error=<msg>] start=<iso> end=<iso>`

With `--json`, `stdout` emits NDJSON frames ([run-json-schema.ts](../../src/cli/modes/run-json-schema.ts)):
- `session` (`mode: "agent"`, `agentId`, `schemaVersion: 1`, `cwd`, `clioCoderVersion`, `runId` once known),
- worker events and `dispatch_scope_notice` frames (`peer_instructions_stale` warning, `worker_merged` info),
- final `result` frame (`{"type":"result","result":{...}}`, plus optional `recording`, `verdict`, `failedChecks`), or `{"type":"admission_refused","agentId":...,"message":...,"exitCode":2}` if admission refused dispatch before spawning any worker ([run.ts](../../src/cli/run.ts)).

Note: `--agent` refuses `--json-events`, `--session`, `--continue`, `--max-cost-usd`, `--fail-on-noop`, `--verify`, `--turn-mode`, `--allow-tools`, `--delegate-tools`, and `--no-delegate` with exit `2` ([run.ts](../../src/cli/run.ts)).

### Worker permission refusals (exit 3)

Dispatched workers obey `fleet.permissions.mode` (`judge` default, `deny`, `main`, `fail`):
- Under `deny` (and denied asks under `judge` or `main`), refused calls return to the worker as tool errors (`permission denied by policy: ...`, command clipped to 200 chars).
- Reaching **3** `execute`-class policy refusals in one run exits the native or Claude SDK worker with code `3` (`WORKER_EXIT_PERMISSION_REQUIRED`), `outcome: "failed"`, `outcomeDetail: "permission_required; ..."`, and `permission refusal limit reached: the worker ended after 3 refused commands with no approval route: ...` on stderr ([worker-refusals.ts](../../src/engine/worker-refusals.ts)).
- Non-`execute` refusals and operator/timeout escalation denials do not increment the strike counter.
- `fleet.permissions.mode: fail` exits `3` immediately on the first permission denial of any class.
- Dispatch records `permission_required` in route history and blocks identical re-dispatch within the same user turn.

## JSON output formats (`--json` and `--json-events`)

| Command | Flag(s) | Output schema / contract |
| --- | --- | --- |
| `run` | `--json` / `--json-events full` | NDJSON deltas without growing message snapshots (`#122`): `session` (`schemaVersion: 1`), `agent_start`, `turn_start`, `message_start`, `text_delta`, `thinking_delta`, `message_end` (`{streamed: true, textLength\|thinkingLength}`), `tool_execution_start\|update\|end` (gateway calls add `via: "gateway"`; chain steps add `parentToolCallId`), `turn_end` (retains final `text` blocks without thinking bodies), `agent_end`, `dispatch_scope_notice`, `dispatch_settlement`, optional `autonomy`/`verify`, final flushed `run_end`. Unknown `type` values must be tolerated ([json-stream.ts](../../src/cli/modes/json-stream.ts), [run-json-schema.ts](../../src/cli/modes/run-json-schema.ts)). |
| `run` | `--json-events terminal` | NDJSON: `session`, synthesized `turn_start`, filtered `agent_end` + `notice`, synthesized `turn_end` (`startedAt`, `endedAt`, `exitCode`, `text`, optional `error`, `outcome`, `outcomeDetail`, `safety`, `toolRounds`, `autonomy`, `verify`, `observed`). Omits tool execution and `run_end`. |
| `run --agent` | `--json` | NDJSON worker stream ending with `result` or `admission_refused`. |
| `doctor` | `--json` | `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }`. |
| `upgrade`, `reset`, `uninstall` | `--json` | `{ command, title, method?, status ("success"\|"skipped"\|"dry-run"\|"error"), items, steps, warnings, errors, advice, summary? }` ([lifecycle-presenter.ts](../../src/cli/lifecycle-presenter.ts)). |
| `session list` | `--json` | `{ stateDir, staleAfterMs, sessions: [{ ..., ageMs, skewMs, state }], malformed, clockOffsetMs }` ([session.ts](../../src/cli/session.ts)). |
| `session terminate` | `--json` | `{ id, host, pid, action ("requested"\|"signaled"\|"released"\|"refused"), message, ageMs, ... }`. |
| `fleet events` | `--json` | Verbatim hash-chained NDJSON journal lines (`--follow` streams until `fleet_sealed`). |
| `fleet status` | `--json` | `{ generatedAt, admission ("open"\|"draining"), running, retrying, totals }` (`totals.coverage` and `totals.display` distinguish partial/unrecorded fields). |
| `fleet run --resume` | `--json` | NDJSON step records (`status: "replayed"`, `run.runId`, `digest` for replayed prefix). |
| `fleet verify` | `--json` (required) | `{ version, verifiedAt, runId, state ("pending"\|"verified"\|"failed"\|"unavailable"), reason, axes }`. |
| `agents` / `models` / `targets` | `--json` | JSON arrays (`agents`, `models`) or `{ targets: [...] }` (`targets`). |
| `playbook validate` / `graph` | `--json` | Validation (`valid`, `playbook`, `checks`+`planHash` or `diagnostics`) or compiled graph (`playbook`, `planHash`, `waves`, `loops`). |
| `telemetry inspect\|calls\|cost\|cache\|timeline\|why-stopped\|explain` | `--json` | Read-model DTO matching TUI/ACP/GUI payloads. |
| `telemetry verify` / `doctor` | `--json` | Directory `{ path, status ("verified"\|"unsealed"\|"failed"), ... }` or archive `{ path, archive: true, status, failure, manifest, scopes }`; doctor `{ mode, consent, latestSession, seals, failures }`. |
| `paths` | `--json` | `{ config, data, state, cache, install, installActive, launcher, project, tracking }` ([paths.ts](../../src/cli/paths.ts)). |
