# Exit Codes & Machine-Readable Output Contracts

This document specifies the process exit codes, machine-readable JSON streaming formats, standard I/O separation rules, and `--help` conventions across all Clio Coder CLI commands in the current source tree.

Source implementations: `src/cli/` and `src/entry/`.

---

## 1. Global Exit Codes

Clio Coder follows one exit code taxonomy across commands. A signal that ends an interactive session or a headless main-agent run exits `128 + signal`: `129` for SIGHUP, `130` for SIGINT and `143` for SIGTERM. `clio-coder configure` also exits `130` when you leave first-run setup before any target is saved, which a bare `clio-coder` launch reads as "nothing was configured".

| Exit Code | Meaning | Typical Causes & Conditions |
| :--- | :--- | :--- |
| **`0`** | **Success** | Successful command execution, clean run settlement, `--version`, `--help` invocation, a `--dry-run`, a declined `reset` or `uninstall` confirmation, an `upgrade` that finds nothing to do, or a missing trace database notice without an explicit `--db` flag. |
| **`1`** | **Operational Failure** | Execution error, model target unreachable, doctor diagnosis with unresolved issues, explicit `--db` path not found, or a failed install, migration, integrity check or delete in a lifecycle command. For a headless main-agent `run`, also a provider error, a stream that ended with no assistant response, `output token limit reached (stopReason=length)`, an explicit `limitation`, an unresolved block with no write (`noop`), a dispatched worker that did not deliver, and an interrupted turn. |
| **`1`** | **Worker merge withheld (`merge_withheld`)** | A dispatched worker's task worktree was preserved instead of merged, including when its own report lists a failing validation, asks for a check the host did not run, or the diff removes existing test cases. Headless stderr names the worker, `merge_withheld`, and its reason; the preserved branch can be inspected and merged by the operator. |
| **`1`** | **Worker did no work (`worker_no_work`)** | A dispatched edit worker finished without doing its assignment: it executed no tools, it recorded a limitation or opened its report with an inability and changed nothing, or the operator denied its permission asks and nothing changed. A task worktree holding no commits is discarded instead of preserved. Headless stderr names the worker, `worker_no_work`, and the reason it did not deliver. |
| **`1`** | **Worker removed tests (`worker_removed_tests`)** | A dispatched worker editing the current checkout, without a task worktree, removed existing test cases when the task did not ask for that. The edits stay in the checkout for review. Headless stderr names the worker, `worker_removed_tests`, and the removed test cases. |
| **`1`** | **Worker information-flow refusal (`information_flow_blocked`)** | Restricted context cannot reach the requested destination under the source policy. The worker run ends with this deterministic outcome code; dispatch never retries or fails over. Review and approve the exact policy bytes when instructed, or start a new session after changing the rule or destination. |
| **`2`** | **Syntax / Usage Error** | Unknown subcommand, invalid flag, missing required positional arguments, global flag placed after subcommand, an unknown target, an unknown agent recipe, a refused admission or capability request, or a data mutation SQL keyword passed to `clio-coder trace sql`. In lifecycle commands, also an unsafe directory layout, a flag conflict (`reset --all` with a level, `upgrade --restart` with `--json`), and `reset` or `uninstall` run without a terminal, `--force` or `--dry-run`. |
| **`3`** | **Worker permission refusal (`permission_required`)** | The exit code of a dispatched native worker that was ended by the permission refusal limit or by `fleet.permissions.mode: fail`. It appears in the receipt as `exit=3`. `clio-coder run --agent` passes receipt exits 0, 2, 3 and 4 to the shell unchanged and maps every other receipt exit to `1`, so the command itself exits `3`. See [Worker permission refusals](#worker-permission-refusals-exit-3). |
| **`4`** | **Session Cost Ceiling** | `clio-coder run`, with or without `--agent`, stopped because session priced spend reached the ceiling in `safety.limits.sessionCostUsd`. The message reads `budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling; raise safety.limits.sessionCostUsd`. Unpriced usage is not counted. The code needs a positive ceiling: `safety.limits.sessionCostUsd: 0` means no session ceiling and never produces it. |
| **`124`** | **Run Timeout** | `clio-coder run --timeout <seconds>` elapsed. The run took the coordinated shutdown path a SIGTERM takes: the turn was aborted, a running bash tool's process group was signalled, and the receipt was sealed with outcome `timed_out` and run status `failed`, the status a dispatched worker's `timed_out` receipt seals with. The code matches `timeout(1)`. An external SIGTERM still exits 143 with outcome `canceled`. A timeout that fires during boot, before the turn starts, exits 124 with no receipt. `--timeout` applies to the main agent; with `--agent` it exits 2. |

---

## 2. The `--help` Standard

Every subcommand in Clio Coder adheres to the strict `--help` convention:

1. **Standard Output**: Usage instructions and options are printed exclusively to `stdout`.
2. **Zero Exit**: The process exits with code `0`.
3. **Zero Side Effects**: Running `clio-coder <subcommand> --help` executes no runtime setup, initiates no network probes, and mutates no state files.

### Global vs Subcommand Flag Positioning

Global options (such as `--api-key`, `--no-context-files`, and `-nc`) must precede the subcommand. `--with-panes`, `--no-panes`, `--demo`, `--no-demo` and a pre-subcommand `--autonomy` apply to the interactive session only and exit `2` when a subcommand follows them. Directory redirection is configured via the `CLIO_CODER_*_DIR` environment variables (see [docs/guide/environment-variables.md](environment-variables.md)). If a global flag is placed after the subcommand name, Clio prints a remediation line to `stderr` and exits with code `2`. For `clio-coder run` the message reads:

```text
clio-coder run: --api-key is a global option and must come before the subcommand: clio-coder --api-key <key> run ...
```

---

## 3. Standard I/O Separation & Headless Execution

In headless execution (`clio-coder run`):

1. **Standard Output (`stdout`)**: Reserved strictly for the final answer, deliverable artifact content, or machine-readable JSON streams.
2. **Standard Error (`stderr`)**: Reserved for progress notifications, permission denial advisories, telemetry warnings, and error diagnostics.
3. **Headless Permission Denials**: When a tool requires permission that cannot be granted in headless mode, Clio Coder emits `HEADLESS_PERMISSION_DENIED_REASON`:
   ```text
   clio-coder run cannot confirm permission requests; rerun interactively to approve this action.
   ```
   The denial is delivered to the model so it can recover through permitted work or report a limitation. An unresolved block with no successful write exits `1` with receipt outcome `failed` and `outcomeDetail: "noop"`; this does not require `--fail-on-noop`. A later substantive success of the same action class can resolve a block. A successful `limitation` call fails with detail `limitation`. `--fail-on-noop` also rejects runs whose attempted tools all failed without a block. The no-op rules are in [commands and modes](commands-and-modes.md).

### Dispatched agent output (`clio-coder run --agent`)

In text mode a dispatched agent prints three things to stdout, in this order:

1. **The answer.** The last assistant message of the final attempt, or when the worker streamed text only, the accumulated text. A failover hop discards the earlier attempt's text. When the worker wrote no prose at all and its sealed result is final, Clio prints the sealed result itself: a `mutation-report`'s `summary` and `observations`, a `scout-report` or `research-report`'s findings as `- <claim> (<path>:<line>)`, a `world-knowledge-report`'s synthesis and facts, a `provenance-report`'s confirmed facts, an `oracle-report`'s verdict and challenge, and for any other kind the result text.
2. **A `Not verified:` block**, only when the sealed result is final, not truncated, and names something unchecked. It lists items from the result's own typed fields and never infers limits from narration. One line per item, each clipped at 400 characters:
   - `mutation-report`: every `declaredChecks` entry and every failed `validations` entry as `<name>: <evidence>`.
   - `verifier-report` and `code-report`: every failed `checks` entry as `<name>: <evidence>`.
   - `scout-report`: `degradedReason`, each `ungroundedClaims` entry and each finding without a valid `path` and `line` as `Ungrounded claim: <claim>`, and when `needsSplit` is true each proposed subtask as `Scout requested further work: <task>`.
   - `world-knowledge-report`: `Discovery: unavailable` or `Discovery: caller-supplied-only`, then `uncertainties` and `followUpVerification`.
   - `provenance-report`: `missingEvidence` and `nextInspections`.
   - `debugger-report`: `Reproduction: unknown` or `Reproduction: not-reproduced`.
3. **One `receipt:` line**: `receipt: <runId> agent=<id> exit=<n> target=<id> requested_model_id=<wire id> tokens=<n> start=<iso> end=<iso>`. Optional fields appear in place. `verification=unverified not_verified=<N>` follows `exit=` when the block above printed `N` items. `response_model_id_observation=<state>[,<state>...]` and, for a LiteLLM route, `gateway=litellm route=<group>-><model>@<host>` follow `requested_model_id=` when the receipt recorded upstream responses. `reasoning=<n>` and `error=<message>` follow `tokens=` when the worker reasoned or the run failed.

With `--json`, stdout is JSONL with one frame per line: a `session` header (`mode: "agent"`, `agentId`, `schemaVersion`, `cwd`, `clioCoderVersion` and the `runId` once it is known), one frame per worker event, `dispatch_scope_notice` frames when a scope entry changed what the worker may touch, and a final `{"type":"receipt","receipt":{...}}` frame holding the sealed receipt. The human layout above is text mode only. The process exit status is the receipt's `exitCode` when it is 0, 2, 3 or 4, and 1 for every other value.

### Worker permission refusals (exit 3)

A dispatched native worker runs under `fleet.permissions.mode`. In the default `deny` mode, a refused execute-class call returns to the worker model as a tool result and the run continues:

```text
permission denied by policy: <tool> `<command>` refused by rule <rule>; dispatched workers run non-interactively (fleet.permissions.mode=deny); <tool> requires <class> confirmation
```

The command is clipped to 200 characters with secrets redacted. The third execute-class refusal in one run ends the worker with process exit code 3 (`WORKER_EXIT_PERMISSION_REQUIRED`). The dispatch outcome is `failed`, the receipt's `outcomeDetail` reads `permission_required; <reason>`, and `error=` carries the reason, which names every refused command:

```text
permission refusal limit reached: the worker ended after 3 refused commands with no approval route: 1) bash `npm install` refused by rule autonomy; 2) ...; 3) ...
```

The worker also writes that reason to its stderr as `[worker] ...`. Headless main-agent runs report the dispatched worker through `clio-coder run: N dispatched worker(s) did not deliver: <runId> (<agent>, failed): permission_required; ...` and exit 1; that stderr line clips each detail at 600 characters and the receipt keeps the full text.

The limits of the contract:

- Only `execute` refusals count. A denied call of any other class returns to the worker and never ends the run.
- `fail` mode ends the run at the first refusal of any class with `permission required for <tool> (<class>); fleet.permissions.mode=fail ends this run`, with the same exit code and outcome.
- An escalation that has no responder applies its fallback mode, `deny` or `fail`, at once.
- The Claude SDK worker runtime ends the run at its first execute refusal.
- The route history labels the run `permission_required`, and dispatch blocks an identical re-dispatch in the same user turn.

---

## 4. Machine-Readable Output Formats (`--json` & `--json-events`)

Many Clio Coder CLI subcommands provide structured JSON output for integration with scripts, CI pipelines, and external orchestrators.

### Subcommand JSON Summary

| Subcommand | Flag | Output Structure |
| :--- | :--- | :--- |
| `clio-coder run` | `--json` | Stream of incremental NDJSON event frames. Core frame kinds include `session`, `agent_start`, `turn_start`, `message_start`, `message_end`, `thinking_delta`, `text_delta`, `tool_execution_start`, `tool_execution_end`, `turn_end`, and `agent_end`. Full streams can also carry registered `clio_coder_*` tool, permission, plan, and lifecycle frames; consumers must dispatch on `type` and tolerate additive kinds. Tool frames name the capability that ran; a call through `gateway` adds `via: "gateway"`, and a chain step adds `parentToolCallId` ([commands and modes](commands-and-modes.md), section on JSON event streaming). |
| `clio-coder run` | `--json-events terminal` | Emits the `session` header, a synthesized `turn_start` (`startedAt`), the `agent_end` and `notice` events that pass the filter, and a synthesized `turn_end` carrying `startedAt`, `endedAt`, `exitCode`, final answer `text`, and `error` when the turn failed. Per-segment token usage rides `agent_end`. Carries no tool activity, dispatch run id or merge outcome; use `full` or the run receipt for those (#122). |
| `clio-coder run` | `--json-events full` | Emits the complete event stream with projected assistant messages (`streamed: true`, `textLength`, `thinkingLength`); `turn_end.message.content` also retains the final answer text (#122). |
| `clio-coder run --agent` | `--json` | JSONL: a `session` header, one frame per worker event and scope notice, and a final `receipt` frame with the sealed run receipt. `--json-events` is refused with `--agent` (exit 2). See [Dispatched agent output](#dispatched-agent-output-clio-coder-run---agent). |
| `clio-coder doctor` | `--json` | `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }` on stdout. Exit 1 when any row is an error. See [Doctor](doctor.md). |
| `clio-coder upgrade`, `reset`, `uninstall` | `--json` | One report document: `command`, `title`, `method`, `status` (`success`, `skipped`, `dry-run` or `error`), `items` (path, bytes and `remove`, `keep`, `absent`, `skip` or `clean` status), `steps`, `warnings`, `errors`, `advice` and `summary`. The text output carries the same facts. |
| `clio-coder agents` | `--json` | JSON array of registered agent recipe metadata objects. |
| `clio-coder targets` | `--json` | JSON object containing the configured `targets` array. |
| `clio-coder models` | `--json` | JSON array of catalog models with capability flags. |
| `clio-coder fleet status` | `--json` | JSON snapshot object with `generatedAt`, `admission` (`open` or `draining`), `running`, `retrying`, and `totals`. Each run row carries its `node`, defaulting to `local`. |
| `clio-coder playbook validate` | `--json` | JSON report with `valid`, `playbook`, and either successful `checks` plus `planHash` or failure `diagnostics`. Validation failures exit `1`; usage errors exit `2`. |
| `clio-coder playbook graph` | `--json` | JSON object with `playbook`, `planHash`, compiled `waves`, and expanded `loops`. Playbook failures exit `1`; usage errors exit `2`. |
| `clio-coder fleet run --resume` | `--json` | NDJSON step records include `status: "replayed"` and the original receipt reference for replayed prefix steps. Plan or variable mismatches exit `1`. |
| `clio-coder trace runs` | `--json` | JSON array of trace run records. |
| `clio-coder trace inspect` | `--json` | Version-1 bounded snapshot with `generatedAt`, `available`, `runs`, and aggregate `truncated`; each run contains bounded accounting plus phase, event-kind, and process-kind summaries, never request text or raw rows. |
| `clio-coder trace prune` | `--json` | JSON object containing `available`, the resolved `policy`, `runsRemoved`, `rowsRemoved`, `bytesRemoved`, `vacuumed`, and `protectedRuns`. With no default database it remains a structured successful no-op. |
| `clio-coder trace sql` | Positional query | JSON array of rows returned by the read-only SQLite query. A single `SELECT` or read-only `WITH` statement is accepted; multiple statements and mutating keywords are refused with exit code 2. |
| `clio-coder paths` | `--json` | JSON object mapping platform directory names to absolute paths. |

### Incremental Streaming & Deduplication Invariant (#122, #123)

The `--json` stream from `clio-coder run` emits **deltas and increments** without repeated growing message snapshots:
1. `text_delta` and `thinking_delta` stream incremental content tokens.
2. `message_end` projects assistant text and thinking blocks to length descriptors (`{ streamed: true, textLength }` and `{ streamed: true, thinkingLength }`). Full-mode `turn_end` retains the final text on those text blocks for answer consumers; thinking bodies and replay signatures remain omitted. Terminal-mode `turn_end.text` carries the final answer without requiring delta reassembly.
3. Tool calls and results are preserved intact since they carry execution payloads not present in text deltas.
4. Terminal accounting and token usage remain fully populated for auditability.
5. Exit code validation strictly precedes database inspection: unknown flags, missing required positionals, or mutating SQL queries consistently exit `2` with usage syntax printed to `stderr` (#123).
