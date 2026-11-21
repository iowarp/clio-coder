# Exit Codes and Machine-Readable Output

Process exit codes, stdout/stderr contracts, `--help` guarantees, and JSONL stream schemas across CLIO Coder CLI commands ([index.ts](../../src/cli/index.ts), [run.ts](../../src/cli/run.ts), [print.ts](../../src/cli/modes/print.ts), [run-json-schema.ts](../../src/cli/modes/run-json-schema.ts)).

## Exit code contract

Interactive sessions, headless main-agent `run`, and `run --agent` exit `128 + signal` on terminating signals (`129` SIGHUP, `130` SIGINT, `143` SIGTERM). `run` interrupted by SIGINT while reading `@file` inputs exits `130` before sending any request; `clio-coder configure` exits `130` if exited before saving a first target ([configure-import.ts](../../src/cli/configure-import.ts)).

| Code | Meaning | Trigger conditions |
| --- | --- | --- |
| `0` | Success | Clean completion, `--version`, `--help`, `--dry-run`, declined `reset`/`uninstall`, `upgrade` no-op, passing checks/verifies. |
| `1` | Operational failure | Runtime/provider error; Node.js `< 22.19.0` ([index.ts](../../src/cli/index.ts)); `doctor` error findings; `run` stream without response, `stopReason=length` without terminal tool, empty closing message after tool calls, `limitation`, unresolved block or a dispatch that started no worker, with no write (`noop` even without `--fail-on-noop`, except `--turn-mode answer\|proposal` which exits `0` and prints `clio-coder run: answered with <N> blocked call(s): ...` to `stderr`; [print.ts](../../src/cli/modes/print.ts)), `--fail-on-noop`, `dispatched_worker_failed`, deterministic dispatched worker failure (`merge_withheld`, `worker_no_work`, `worker_partial_work`, `worker_removed_tests`, `information_flow_blocked`; see table below); `run --agent verifier` with `verdict: "fail"`, or any `run --agent` whose sealed result-contract quality is `fail` because a check failed after its last edit (a `"baseline":true` red before any edit stays `0`; settled run outcome stays `succeeded` in both); stdout write error other than `EPIPE` (`clio-coder run: cannot write output: <message>` on `stderr`, [output-guard.ts](../../src/cli/output-guard.ts)); `reset`/`uninstall` keeping an unproven root; lifecycle/telemetry/playbook failures. |
| `2` | Usage / admission / layout refusal | Unknown command/flag, missing positional, invalid startup flag placement (see [Flag positioning](#flag-positioning)), unsupported flag on `run --agent` (see the note under [Dispatched agent output](#dispatched-agent-output-clio-coder-run---agent)), an `--answers` file that fails validation (stderr names the offending entry), `--session` with `--continue`, `clio-coder --resume` naming no session or several, `--resume` with `--continue` or either before a subcommand, a `--cwd` the process cannot enter, an explicit `--skill` path that loads no skill, unknown target or recipe, unselectable/non-chat model, multiple usable routes with no default target and no `--target`, single route without model and no `--model`, task piped to bare `clio-coder` without `CLIO_CODER_INTERACTIVE=1`, `--autonomy yolo` as root outside a container or under `CLIO_CODER_AUTONOMY_CEILING`, newer-home version mismatch without `CLIO_CODER_ALLOW_OLDER=1` (headless/ACP), unsafe `CLIO_CODER_*_DIR` layout, conflicting lifecycle flags (`reset --all` with a level, `upgrade --restart` with `--json` or `--post-install`), or `reset`/`uninstall` non-TTY without `--force`/`--dry-run`. |
| `3` | Permission refusal / judge streak | Dispatched native or Claude SDK worker stopped after 3 `execute`-class policy refusals (`deny`/`judge`/`main` mode) or on first refusal of any class (`fleet.permissions.mode: fail`) — `outcomeDetail` starts with `permission_required` ([worker-refusals.ts](../../src/engine/worker-refusals.ts), [worker-runtime.ts](../../src/engine/worker-runtime.ts)). Main-agent `run --autonomy yolo` halted on safety-judge block streak (`outcomeDetail: "judge-streak"`, exits `3`; [autonomy-window.ts](../../src/domains/safety/autonomy-window.ts)): `` clio-coder run: judge-streak: the safety judge blocked too many calls (<detail>), so yolo ended the run after <N> tool calls, <M> min, <T> cap tokens; review it, then `clio-coder run --continue "<prompt>"` resumes with a fresh window ``, followed by the open decisions the run leaves for you, where cap tokens count cache reads at one tenth. A parent `run` dispatching a worker that hits `3` reports `dispatched_worker_failed` and exits `1`; `run --agent` passes `0`, `2`, `3`, `4` through and maps other non-zero worker codes to `1` ([run.ts](../../src/cli/run.ts)). |
| `4` | Spend or autonomous cap | `safety.limits.sessionCostUsd` (default `5` USD, `0` disables) or `run --max-cost-usd <N>` reached (`outcomeDetail: "budget_ceiling"`, [budget.ts](../../src/domains/scheduling/budget.ts)): `budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling<per-call>; raise safety.limits.sessionCostUsd` or `budget_ceiling: this run's priced spend $<spent> reached its --max-cost-usd $<cap> cap<per-call>`, where `<per-call>` is ` with ~<n> context tokens per call` when request size is known. Spend strings mark estimates as `~$<x> est` and partial unpriced sums as `$<x> +?`; [renderUsd](../../src/core/telemetry/render.ts) uses 2 decimals at `>= $0.01`, 4–8 decimals below `$0.01`, and scientific notation below `$0.00000001`. Unpriced calls are excluded; priced calls missing server usage estimate from request size and streamed output; prior session spend is excluded from `--max-cost-usd`. Interactive sessions show `[budget] Session priced spend <spend> reached.<perCall> Paid requests are paused; raise safety.limits.sessionCostUsd to <n> to resume.` (or `exceeded.`). Main-agent `run --autonomy yolo` hitting `autonomousToolCalls`, `autonomousMinutes`, or `autonomousTokens` exits `4` (`outcomeDetail: "autonomous-cap"`, [autonomy-window.ts](../../src/domains/safety/autonomy-window.ts)): `` clio-coder run: autonomous-cap: yolo paused at the <detail> after <N> tool calls, <M> min, <T> cap tokens; review it, then `clio-coder run --continue "<prompt>"` resumes with a fresh window ``. |
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

A run that left its evidence obligation unmet is the one exception to "no automatic retry": a builder that ends `worker_no_work` with no tool call over an unchanged tree is retried once on another model, and its idle task worktree is kept for that attempt ([Evidence obligations and the one retry](fleet-dispatch.md#evidence-obligations-and-the-one-retry)).

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
| `context working-set` | `0` summary printed, or `--verify` found no mismatch (attempts read `verified`, `not-verifiable`, or `external`), `1` `--verify` found an attempt whose request differs from its receipt, or the session could not be read, `2` usage ([context-working-set.ts](../../src/cli/context-working-set.ts)). |
| `arena run\|show\|vote` | `0` success, `1` match failed / unknown match / `show --reveal` before vote / duplicate `vote` without `--replace`, `2` usage, `129`/`130`/`143` signal ([arena.ts](../../src/cli/arena.ts)). |

## `--help` and flag positioning

Subcommand `--help` exits `0` with zero side effects or network probes, writing to `stdout`; `clio-coder run --help` does so under `--output-format json|stream-json` too ([run-help.ts](../../src/cli/run-help.ts)).

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
| `--resume`/`-r`, `--continue`/`-c` | Interactive only (no subcommand) | Before `run`: `--resume and --continue apply to the interactive session only; for a headless turn pass them after run: clio-coder run --resume <id> or clio-coder run --continue`. Before any other subcommand: `--resume and --continue apply to the interactive session only; start clio-coder without a subcommand.` Both together: `--resume and --continue cannot be combined`. |
| `--with-panes` | Interactive only (before command, no subcommand) | Before subcommand: `--with-panes applies only to the interactive session; clio-coder <cmd> does not honor it.` After subcommand: `--with-panes applies only to the interactive session; start it with clio-coder --with-panes` |

## Streams and headless `run` behavior

`clio-coder run` writes only the final answer (or NDJSON frames) to `stdout`; all diagnostics, permission denials, `observed` summaries, `--verify` results, `Recording manifest (relative to Clio state): <path>` (`--agent --record`), and pre-send attachment interrupts (`clio-coder run: interrupted while reading file attachments; nothing was sent`, exit `130`) go to `stderr` ([print.ts](../../src/cli/modes/print.ts), [run.ts](../../src/cli/run.ts)). Argument validation precedes state reads (`#123`).
- Unconfirmed permissions in headless mode return `HEADLESS_PERMISSION_DENIED_REASON` (`clio-coder run cannot confirm permission requests; rerun interactively to approve this action.`) as a tool error so the model can adapt or call `limitation` ([headless-permission.ts](../../src/core/headless-permission.ts)).
- Runs that called `>= 1` tool emit one `stderr` line after completion (`headless-observed.ts`):
  `clio-coder run: observed: <N> tool call(s), <M> refused [· <W> write(s)] [· check(s) passed: <names>] [· check(s) failed: <names>] [· unclassified command(s) failed: <names>] [· <U> unclassified command(s) ran after a standing check] [· no check observed after the last write | no checks declared in the workspace]` (max 3 check names per list; does not alter stdout or exit code). A passing dispatch run record that no later write retired is named among the passed checks as `run <id> agent <agent>`, as on the task board. An unclassified call is one the check classifier (`check-classifier.ts`) reads as neither a check, an inspection nor a mutation, such as `node codemod.mjs` or an MCP tool. It neither settles nor clears a standing check, so a passing one is only counted while any check that ran before it still stands, while one that ran and failed is named whether or not a check stands, until a later write; the run receipt's `unclassifiedAfterLastCheck` (count plus up to 5 redacted commands) carries it too. A check chained to an unknown program in one command, such as `cargo build && ./target/debug/app`, reads as mixed: it settles no pass and retires a standing one, so run the check as its own command (known limit).
- `--verify "<cmd>"` runs each check after the turn settles, logs to `stderr`, and reports each check in the `run_end` envelope's `verify.checks` under `--output-format json|stream-json` (plus a `verify` frame under `stream-json`); it does not override the run's exit code ([print.ts](../../src/cli/modes/print.ts)).

### Failures before output starts

When a run under `--output-format json|stream-json` fails before its turn starts, including a usage error, it still writes the `run_end` envelope (after a pending `session` frame under `stream-json`), whose `causes` name the failure, so `stdout` is never empty on non-zero exit ([run-failure.ts](../../src/cli/run-failure.ts)).

### The `run_end` frame

Every `clio-coder run --output-format stream-json` stream ends with one `run_end` result envelope (`schemaVersion: 2`), and `--output-format json` writes that envelope alone, including after `--timeout` or signals ([run-json-schema-v2.ts](../../src/cli/modes/run-json-schema-v2.ts)):

```json
{"type":"run_end","schemaVersion":2,"mode":"main","startedAt":"...","endedAt":"...","exitCode":1,"outcome":"failed","outcomeDetail":"noop","causes":[{"code":"noop"}],"result":{"text":"","artifacts":[]},"verify":{"requested":0,"checks":[]},"dispatch":{"runs":[],"live":[],"undelivered":[]}}
```

`outcome` is `succeeded`, `failed`, `canceled`, `timed_out`, `previewed` (`--dry-run`) or `displayed`; `causes` lists every fact that ended the run, winner first, and `outcomeDetail` names the winner. After a step template's turns, the sealed run record (not the envelope) keeps `stepPipeline`, which names the step tool and says whether it signalled `done`; a pipeline left unfinished keeps the outcome and carries `stoppedBy` (`cap` for the yolo continuation cap with a step still running, `unreported` when the last turn at the cap made no step call and ended on its own summary, so the step tool simply never signalled `done`, `cancel` or `failure` when a cancel or a failed turn ended it, `turn` for a turn nothing continued). Always judge overall success/failure from `run_end`, not from model-level `agent_end` ([run-json-schema.ts](../../src/cli/modes/run-json-schema.ts)).

### Completion and `--exit-code`

Once a main run settles, its `run_end` envelope carries `completion`: how the agent declared the run ended through its [`finish`](tool-usage.md#finish-declare-how-the-turn-ended) tool, never read from the answer text ([run-json-schema-v2.ts](../../src/cli/modes/run-json-schema-v2.ts)).

```json
"completion":{"declared":true,"claimed":"done","assessed":"partly_done","state":"partly_done","facts":["unvalidated_mutation"],"limitations":[],"unverified":[]}
```

`claimed` is the declared `done`, `partly_done` or `not_done`, and `assessed` is the host's reading of it: a `done` over an open obligation (`unvalidated_mutation`, `failed_check`, `uncollected_run` or `open_task`, listed in `facts`) is `partly_done`. `state` is the assessment. A run that declared nothing has `declared: false`, `claimed: null` and state `unknown`. `limitations`, `unverified` and the optional `remaining` repeat the declaration.

Without `--exit-code` the completion changes no exit code. With it, a run that would exit 0 exits 1 when `state` is `partly_done` or `not_done`; `done` and an undeclared run keep 0, and every other exit is unchanged ([run-failure.ts](../../src/cli/run-failure.ts)).

### Dispatched agent output (`clio-coder run --agent`)

In text mode (`formatDispatchHumanOutput`, [run-output.ts](../../src/cli/run-output.ts)), `stdout` prints up to six sections in order (redacting URL credentials):

1. **Answer**: Last assistant text (prior attempts discarded on failover), or `sealedResultAnswer` when no prose was written (`mutation-report`: `summary`, `observations`, and `changed: <paths>` when `mutatedPaths` is non-empty; `scout-report` / `research-report`: `- <claim> [(<path>:<line>)|(<evidence>)]`; `world-knowledge-report`: `synthesis` and `facts`; `provenance-report`: `confirmedFacts`; `oracle-report`: `verdict`, `challenge`; fallback `output.text.trim()`). Cut-off partial output passes through `holdCutOffText`.
2. **`Failed checks:`** (optional): Failed checks of a `verifier-report` and failed `code-report` checks that ran (`ran: true`), each as `- <name>: <evidence>`. A verifier `verdict: "fail"` exits `1`.
3. **`Not verified:`** (optional): Typed unchecked items from final non-truncated sealed reports (each clipped to 400 chars): `mutation-report` (`declaredChecks`, failed `validations`), `code-report` (failed `checks` that never ran: `ran` not `true`, including reports sealed before `ran` existed), `scout-report` (`degradedReason`, `ungroundedClaims`, ungrounded findings, `proposedSubtasks` when `needsSplit`), `world-knowledge-report` (`Discovery: unavailable|caller-supplied-only`, `uncertainties`, `followUpVerification`), `provenance-report` (`missingEvidence`, `nextInspections`), `debugger-report` (`Reproduction: unknown|not-reproduced`).
4. **`Failed: <headline>`** (optional): Shown when `receipt.exitCode !== 0` and a worker failure headline applies.
5. **`Finished with a caveat: <words>`** (optional): Shown when `receipt.exitCode === 0` and calls were refused/guarded or contract conformance failed (excludes `no-tools`).
6. **`result:` summary line**:
   `result: <runId> agent=<id> exit=<n>[ verdict=<v>][ failed_checks=<N>][ verification=unverified not_verified=<N>] target=<id> requested_model_id=<wireId>[ response_model_id_observation=...][ gateway=litellm route=...] tokens=<n>[ reasoning=<n>][ error=<msg>] start=<iso> end=<iso>`

With `--output-format stream-json`, `stdout` emits NDJSON frames ([run-json-schema-v2.ts](../../src/cli/modes/run-json-schema-v2.ts)); `--output-format json` writes only the final envelope:
- `session` (`mode: "agent"`, `agentId`, `schemaVersion: 2`, `cwd`, `clioCoderVersion`),
- worker events and `dispatch_scope_notice` frames (`peer_instructions_stale` warning, `worker_merged` info),
- final `run_end` envelope (`mode: "agent"`, `agentId`, the answer in `result.text`, the sealed `RunResult` in `dispatch.runs`); an admission refusal before any worker spawned ends with a `run_end` whose `exitCode` is `2` ([run.ts](../../src/cli/run.ts)).

Note: `--agent` refuses `--autonomy` (use `--read-only`), `--session`, `--continue`, `--max-cost-usd`, `--fail-on-noop`, `--verify`, `--answers`, `--turn-mode`, `--allow-tools`, `--delegate-tools`, and `--no-delegate` with exit `2` ([run.ts](../../src/cli/run.ts)).

### Worker permission refusals (exit 3)

Dispatched workers obey `fleet.permissions.mode` (`judge` default, `deny`, `main`, `fail`):
- Under `deny` (and denied asks under `judge` or `main`), refused calls return to the worker as tool errors (`permission denied by policy: ...`, command clipped to 200 chars).
- Reaching **3** `execute`-class policy refusals in one run exits the native or Claude SDK worker with code `3` (`WORKER_EXIT_PERMISSION_REQUIRED`), `outcome: "failed"`, `outcomeDetail: "permission_required; ..."`, and `permission refusal limit reached: the worker ended after 3 refused commands with no approval route: ...` on stderr ([worker-refusals.ts](../../src/engine/worker-refusals.ts)).
- Non-`execute` refusals and operator/timeout escalation denials do not increment the strike counter.
- `fleet.permissions.mode: fail` exits `3` immediately on the first permission denial of any class.
- Dispatch records `permission_required` in route history and blocks identical re-dispatch within the same user turn.

## JSON output formats (`--json` and `--output-format`)

| Command | Flag(s) | Output schema / contract |
| --- | --- | --- |
| `run` | `--output-format stream-json` | NDJSON deltas without growing message snapshots (`#122`): `session` (`schemaVersion: 2`), `agent_start`, `turn_start`, `message_start`, `text_delta`, `thinking_delta`, `message_end` (`{streamed: true, textLength\|thinkingLength}`), `tool_execution_start\|update\|end` (gateway calls add `via: "gateway"`; chain steps add `parentToolCallId`), `turn_end` (retains final `text` blocks without thinking bodies), `agent_end`, `dispatch_scope_notice`, `dispatch_settlement`, optional `autonomy`/`verify`, final flushed `run_end` result envelope. Unknown `type` values must be tolerated ([json-stream.ts](../../src/cli/modes/json-stream.ts), [run-json-schema-v2.ts](../../src/cli/modes/run-json-schema-v2.ts)). |
| `run` | `--output-format json` | One JSON document: the `run_end` result envelope (`exitCode`, `outcome`, `causes`, `result.text`, `verify`, `dispatch`, `usage`, `timings`). |
| `run --agent` | `--output-format json\|stream-json` | NDJSON worker stream (`stream-json`) ending with the `run_end` envelope, or that envelope alone (`json`). |
| `doctor` | `--json` | `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }`. |
| `upgrade`, `reset`, `uninstall` | `--json` | `{ command, title, method?, status ("success"\|"skipped"\|"dry-run"\|"error"), items, steps, warnings, errors, advice, summary? }` ([lifecycle-presenter.ts](../../src/cli/lifecycle-presenter.ts)). |
| `session list` | `--json` | `{ stateDir, staleAfterMs, sessions: [{ ..., ageMs, skewMs, state }], malformed, clockOffsetMs }` ([session.ts](../../src/cli/session.ts)). |
| `session terminate` | `--json` | `{ id, host, pid, action ("requested"\|"signaled"\|"released"\|"refused"), message, ageMs, ... }`. |
| `fleet events` | `--json` | Verbatim hash-chained NDJSON journal lines (`--follow` streams until `fleet_sealed`). |
| `fleet status` | `--json` | `{ generatedAt, admission ("open"\|"draining"), running, retrying, totals }` (`totals.coverage` and `totals.display` distinguish partial/unrecorded fields). |
| `fleet run --resume` | `--json` | NDJSON step records (`status: "replayed"`, `run.runId`, `digest` for replayed prefix). |
| `fleet verify` | `--json` (required) | `{ version, verifiedAt, runId, state ("pending"\|"verified"\|"failed"\|"unavailable"), reason, axes }`. |
| `agents` / `models` / `targets` | `--json` | JSON arrays (`agents`, `models`) or `{ targets: [...] }` (`targets`). A `models` row lists the thinking levels its route offers as `thinkingLevels`. |
| `telemetry tokens` | `--json` | The per-turn token report verbatim: input tokens, cached and fresh, and output tokens per turn, with the per-source split; totals are provider-measured, the split is estimated ([telemetry-tokens.ts](../../src/cli/telemetry-tokens.ts)). |
| `campaign run` | `--json` | The whole campaign as one object, with each roster entry's status (`completed`, `unscripted`, `timed-out`, `failed`, `canceled`, `error`), extension gates reached, refusals, loop-guard blocks, tokens and wall time; each entry also writes `<NN-label>/entry.json` under `--out` ([campaign.ts](../../src/cli/campaign.ts)). |
| `playbook validate` / `graph` | `--json` | Validation (`valid`, `playbook`, `checks`+`planHash` or `diagnostics`) or compiled graph (`playbook`, `planHash`, `waves`, `loops`). |
| `telemetry inspect\|calls\|cost\|cache\|timeline\|why-stopped\|explain` | `--json` | Read-model DTO matching TUI/ACP/GUI payloads. |
| `telemetry verify` / `doctor` | `--json` | Directory `{ path, status ("verified"\|"unsealed"\|"failed"), ... }` or archive `{ path, archive: true, status, failure, manifest, scopes }`; doctor `{ mode, consent, latestSession, seals, failures }`. |
| `paths` | `--json` | `{ config, data, state, cache, install, installActive, launcher, project, tracking }` ([paths.ts](../../src/cli/paths.ts)). |
