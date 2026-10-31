# Exit Codes & Machine-Readable Output Contracts

This document specifies the process exit codes, machine-readable JSON streaming formats, standard I/O separation rules, and `--help` conventions across all Clio Coder CLI commands in the current source tree.

Source implementations: `src/cli/` and `src/entry/`.

---

## 1. Global Exit Codes

Clio Coder follows one exit code taxonomy across commands. A signal that ends an interactive session or a headless main-agent run exits `128 + signal`: `129` for SIGHUP, `130` for SIGINT and `143` for SIGTERM. A `clio-coder run` interrupted by SIGINT while it reads `@file` attachments also exits `130`, before any request is sent, after printing `clio-coder run: interrupted while reading file attachments; nothing was sent`. `clio-coder configure` also exits `130` when you leave first-run setup before any target is saved, which a bare `clio-coder` launch reads as "nothing was configured".

| Exit Code | Meaning | Typical Causes & Conditions |
| :--- | :--- | :--- |
| **`0`** | **Success** | Successful command execution, clean run settlement, `--version`, `--help` invocation, a `--dry-run`, a declined `reset` or `uninstall` confirmation, an `upgrade` that finds nothing to do, or a `telemetry verify` of a scope that verifies. |
| **`1`** | **Operational Failure** | Execution error, model target unreachable, doctor diagnosis with unresolved issues, a telemetry scope or archive that fails verification or is unsealed, a `telemetry doctor` that finds a failed seal, an unreadable consent store or damaged journal lines, or a failed install, migration, integrity check or delete in a lifecycle command. For a headless main-agent `run`, also a provider error, a stream that ended with no assistant response, `output token limit reached (stopReason=length)`, an explicit `limitation`, an unresolved block with no write (`noop`), a dispatched worker that did not deliver, and an interrupted turn. |
| **`1`** | **Worker merge withheld (`merge_withheld`)** | A dispatched worker's task worktree was preserved instead of merged, including when its own report lists a failing validation, asks for a check the host did not run, or the diff removes existing test cases. Headless stderr names the worker, `merge_withheld`, and its reason; the preserved branch can be inspected and merged by the operator. |
| **`1`** | **Worker did no work (`worker_no_work`)** | A dispatched edit worker finished without doing its assignment: it executed no tools, it recorded a limitation or opened its report with an inability and changed nothing, or the operator denied its permission asks and nothing changed. A task worktree holding no commits is discarded instead of preserved. Headless stderr names the worker, `worker_no_work`, and the reason it did not deliver. |
| **`1`** | **Worker removed tests (`worker_removed_tests`)** | A dispatched worker editing the current checkout, without a task worktree, removed existing test cases when the task did not ask for that. The edits stay in the checkout for review. Headless stderr names the worker, `worker_removed_tests`, and the removed test cases. |
| **`1`** | **Worker information-flow refusal (`information_flow_blocked`)** | Restricted context cannot reach the requested destination under the source policy. The worker run ends with this deterministic outcome code; dispatch never retries or fails over. Review and approve the exact policy bytes when instructed, or start a new session after changing the rule or destination. |
| **`2`** | **Syntax / Usage Error** | Unknown subcommand, invalid flag, missing required positional arguments, global flag placed after subcommand, an unknown target, an unknown agent recipe, a refused admission or capability request, or `clio-coder run --autonomy yolo` as root outside a detected container. In lifecycle commands, also an unsafe directory layout, a flag conflict (`reset --all` with a level, `upgrade --restart` with `--json`), and `reset` or `uninstall` run without a terminal, `--force` or `--dry-run`. |
| **`3`** | **Worker permission refusal (`permission_required`)** | The exit code of a dispatched native worker that was ended by the permission refusal limit or by `fleet.permissions.mode: fail`. It appears in the run result as `exit=3`. `clio-coder run --agent` passes result exits 0, 2, 3 and 4 to the shell unchanged and maps every other exit to `1`, so the command itself exits `3`. See [Worker permission refusals](#worker-permission-refusals-exit-3). |
| **`4`** | **Priced spend ceiling** | The session ceiling (`safety.limits.sessionCostUsd`, default 5 USD) or a main-agent `run --max-cost-usd <n>` cap was reached. A session stop reads `budget_ceiling: session priced spend $<spent> reached the $<ceiling> ceiling; raise safety.limits.sessionCostUsd`. A run-cap stop reads `budget_ceiling: this run's priced spend $<spent> reached its --max-cost-usd $<cap> cap`; amounts use four decimal places. A spent amount that includes estimated prices reads `~$<spent> est`, and one beside calls that could not be priced reads `$<spent> +?`. Earlier spend in a continued session does not count against the run cap, but a lower configured session ceiling still holds. Unpriced usage is not counted. Setting `safety.limits.sessionCostUsd: 0` disables the session ceiling; an explicit run cap still holds. `--max-cost-usd` with `--agent` exits 2. |
| **`75`** | **Install busy (`EX_TEMPFAIL`)** | A retry-later outcome that changed nothing. `install.sh` or `install.ps1` found `.install-lock` held by a live process, another host or a recent crash. `clio-coder upgrade` refused to replace an npm install under other live processes or an update lease and listed them as `pid@host`. The `clio-coder` launcher waited 120 seconds for a package-manager update that was still running. A background update treats 75 as busy rather than failed and tries again later. |
| **`124`** | **Run Timeout** | `clio-coder run --timeout <seconds>` elapsed. The run took the coordinated shutdown path a SIGTERM takes: the turn was aborted, a running bash tool's process group was signalled, and the run settled and sealed with outcome `timed_out` and run status `failed`, the status a dispatched worker's `timed_out` run settles with. The code matches `timeout(1)`. An external SIGTERM still exits 143 with outcome `canceled`. A timeout that fires during boot, before the turn starts, exits 124 with no run record. `--timeout` applies to the main agent; with `--agent` it exits 2. |

Two command families reuse small codes for their own states:

- `clio-coder fleet events` exits `0` for a sealed, intact journal, `1` for an integrity break or read error, `2` for usage, `3` when the journal read so far is intact but not sealed (the fleet may still be running), and `4` when a `--follow` stopped because the fleet can no longer seal its journal.
- `clio-coder telemetry verify` exits `0` when the scope or archive verifies, `1` when it fails or is unsealed, and `2` for usage or an unreadable path. `telemetry doctor` exits `0` when healthy, `1` for a failed seal, an unreadable consent store or damaged lines in the newest journal, and `2` for usage. `telemetry share` exits `0` when it wrote or previewed an archive, `1` when there is nothing to share or it failed, and `2` for usage, including no scope flag outside a terminal. `telemetry import` exits `0` when every scope was placed or was already present and identical, `1` on a failed verify, an unreadable archive or a differing scope already in place, and `2` for usage. The read commands, `consent` and `prune` exit `0`, `1` on an operational failure, and `2` for usage.
- `clio-coder session terminate` exits `0` when it wrote a request, signalled the owner or released the session, `1` when no live record names that id, and `2` for usage or a refused `--force`. `session list` exits `0`, and `2` for usage.

---

## 2. The `--help` Standard

Subcommand help follows these conventions, with the headless JSON exception below:

1. **Standard Output**: Usage instructions and options are printed exclusively to `stdout`.
2. **Zero Exit**: The process exits with code `0`.
3. **Zero Side Effects**: Running `clio-coder <subcommand> --help` executes no runtime setup, initiates no network probes, and mutates no state files.

`clio-coder run --help --json` and `run --help --json-events <mode>` print help
to stderr so stdout stays a machine stream. They still exit 0 without starting
the run (`src/cli/run.ts`).

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
   The denial is delivered to the model so it can recover through permitted work or report a limitation. An unresolved block with no successful write exits `1` with run outcome `failed` and `outcomeDetail: "noop"`; this does not require `--fail-on-noop`. A later substantive success of the same action class can resolve a block. A successful `limitation` call fails with detail `limitation`. `--fail-on-noop` also rejects runs whose attempted tools all failed without a block. The no-op rules are in [commands and modes](commands-and-modes.md).

### Failures before output starts

With `--json` or `--json-events`, a headless main-agent run that fails before it writes any output still ends its stream with one terminal frame, so a consumer never sees an empty stdout. The frame is `{"type":"turn_end","startedAt":…,"endedAt":…,"exitCode":<n>,"text":"","error":…,"outcome":…}`. `error` carries the last diagnostic the run printed, or `clio-coder run failed before output started (exit <n>)` when it printed none. `outcome` is `timed_out` for exit 124 and `failed` for any other nonzero code. A run that exits 0 never gets this frame.

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
3. **One `result:` line**: `result: <runId> agent=<id> exit=<n> target=<id> requested_model_id=<wire id> tokens=<n> start=<iso> end=<iso>`. Optional fields appear in place. `verification=unverified not_verified=<N>` follows `exit=` when the block above printed `N` items. `response_model_id_observation=<state>[,<state>...]` and, for a LiteLLM route, `gateway=litellm route=<group>-><model>@<host>` follow `requested_model_id=` when the run recorded upstream responses. `reasoning=<n>` and `error=<message>` follow `tokens=` when the worker reasoned or the run failed.

With `--json`, stdout is JSONL with one frame per line: a `session` header (`mode: "agent"`, `agentId`, `schemaVersion`, `cwd`, `clioCoderVersion` and the `runId` once it is known), one frame per worker event, `dispatch_scope_notice` frames when a scope entry changed what the worker may touch, and a final `{"type":"result","result":{...}}` frame holding the run result (with `recording` when `--record` captured one). The human layout above is text mode only. The process exit status is the result's `exitCode` when it is 0, 2, 3 or 4, and 1 for every other value.

### Worker permission refusals (exit 3)

A dispatched native worker runs under `fleet.permissions.mode`. Under the default `judge`, the main session's safety judge decides an ordinary ask while the main session runs at `default`; anywhere no judge can answer, `judge` behaves as `deny`. In `deny` mode, and when the judge or, under `main`, the main agent denies an execute call, the refused call returns to the worker model as a tool result and the run continues. A `deny`-mode refusal reads:

```text
permission denied by policy: <tool> `<command>` refused by rule <rule>; dispatched workers run non-interactively (fleet.permissions.mode=deny); <tool> requires <class> confirmation
```

The command is clipped to 200 characters with secrets redacted. The third execute-class refusal in one run ends the worker with process exit code 3 (`WORKER_EXIT_PERMISSION_REQUIRED`). The dispatch outcome is `failed`, the run's `outcomeDetail` reads `permission_required; <reason>`, and `error=` carries the reason, which names every refused command:

```text
permission refusal limit reached: the worker ended after 3 refused commands with no approval route: 1) bash `npm install` refused by rule autonomy; 2) ...; 3) ...
```

The worker also writes that reason to its stderr as `[worker] ...`. Headless main-agent runs report the dispatched worker through `clio-coder run: N dispatched worker(s) did not deliver: <runId> (<agent>, failed): permission_required; ...` and exit 1; that stderr line clips each detail at 600 characters and the settled run keeps the full text.

The limits of the contract:

- Only `execute` refusals count: `deny`-mode refusals and main-authority denials by the safety judge or the main agent. A denied call of any other class, and an operator's or timeout's denial of an escalated call, returns to the worker and never ends the run.
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
| `clio-coder run` | `--json-events terminal` | Emits the `session` header, a synthesized `turn_start` (`startedAt`), the `agent_end` and `notice` events that pass the filter, and a synthesized `turn_end` carrying `startedAt`, `endedAt`, `exitCode`, final answer `text`, and `error` when the turn failed. Per-segment token usage rides `agent_end`. Carries no tool activity, dispatch run id or merge outcome; use `full` or the run's settled record for those (#122). |
| `clio-coder run` | `--json-events full` | Emits the complete event stream with projected assistant messages (`streamed: true`, `textLength`, `thinkingLength`); `turn_end.message.content` also retains the final answer text (#122). |
| `clio-coder run --agent` | `--json` | JSONL: a `session` header, one frame per worker event and scope notice, and a final `result` frame with the run result. `--json-events` is refused with `--agent` (exit 2). See [Dispatched agent output](#dispatched-agent-output-clio-coder-run---agent). |
| `clio-coder doctor` | `--json` | `{ ok, fix, deep, findings: [{ ok, name, level, detail }] }` on stdout. Exit 1 when any row is an error. See [Doctor](doctor.md). |
| `clio-coder upgrade`, `reset`, `uninstall` | `--json` | One report document: `command`, `title`, `method`, `status` (`success`, `skipped`, `dry-run` or `error`), `items` (path, bytes and `remove`, `keep`, `absent`, `skip` or `clean` status), `steps`, `warnings`, `errors`, `advice` and `summary`. The text output carries the same facts. |
| `clio-coder session list` | `--json` | `{ stateDir, staleAfterMs, sessions: [...], malformed, clockOffsetMs }`. Each session carries its live record (`id`, `host`, `pid`, `surface`, `startedAt`, `cwd`) plus `ageMs`, `skewMs` and `state` (`live`, `stale` or `terminating`). `--stale` keeps only stale sessions. |
| `clio-coder session terminate` | `--json` | `{ id, host, pid, action, message, ageMs }` with `action` one of `requested`, `signaled`, `released` or `refused`, plus `exited` for a signal and `released` counts after `--force`. |
| `clio-coder fleet events` | `--json` | The stored hash-chained NDJSON journal lines, verbatim, one per line. `--follow` keeps reading until `fleet_sealed`. |
| `clio-coder agents` | `--json` | JSON array of registered agent recipe metadata objects. |
| `clio-coder targets` | `--json` | JSON object containing the configured `targets` array. |
| `clio-coder models` | `--json` | JSON array of catalog models with capability flags. |
| `clio-coder fleet status` | `--json` | JSON snapshot object with `generatedAt`, `admission` (`open` or `draining`), `running`, `retrying`, and `totals`. Each run row carries its `node`, defaulting to `local`. The `totals` token numbers are the known part; `totals.coverage` counts the runs and, per field, the runs that recorded the field only in part or not at all, and `totals.display` words each field as a lower bound beside those runs. |
| `clio-coder playbook validate` | `--json` | JSON report with `valid`, `playbook`, and either successful `checks` plus `planHash` or failure `diagnostics`. Validation failures exit `1`; usage errors exit `2`. |
| `clio-coder playbook graph` | `--json` | JSON object with `playbook`, `planHash`, compiled `waves`, and expanded `loops`. Playbook failures exit `1`; usage errors exit `2`. |
| `clio-coder fleet run --resume` | `--json` | NDJSON step records include `status: "replayed"` and the original run reference (`run.runId` and its run `digest`) for replayed prefix steps. Plan or variable mismatches exit `1`. |
| `clio-coder telemetry inspect`, `calls`, `cost`, `cache`, `timeline`, `why-stopped`, `explain` | `--json` | The read model's DTO for the requested view, the same one the TUI, ACP and GUI serve. |
| `clio-coder telemetry verify` | `--json` | For a scope directory, `{ path, status, ... }` with `status` `verified`, `unsealed` or `failed` and the seal verdict's fields. For a share archive, `{ path, archive: true, status, failure, manifest, scopes }`. |
| `clio-coder telemetry doctor` | `--json` | `{ mode, consent, latestSession, seals, failures }`: requested and effective capture mode with its flags, the consent covering the current directory, the newest session journal's health, seal counts per state with scope counts, and every failed seal. |
| `clio-coder fleet verify` | `--json` (required) | `{ version, verifiedAt, runId, state, reason, axes }` with `state` `pending`, `verified`, `failed` or `unavailable`. |
| `clio-coder paths` | `--json` | JSON object mapping platform directory names to absolute paths. |

### Incremental Streaming & Deduplication Invariant (#122, #123)

The `--json` stream from `clio-coder run` emits **deltas and increments** without repeated growing message snapshots:
1. `text_delta` and `thinking_delta` stream incremental content tokens.
2. `message_end` projects assistant text and thinking blocks to length descriptors (`{ streamed: true, textLength }` and `{ streamed: true, thinkingLength }`). Full-mode `turn_end` retains the final text on those text blocks for answer consumers; thinking bodies and replay signatures remain omitted. Terminal-mode `turn_end.text` carries the final answer without requiring delta reassembly.
3. Tool calls and results are preserved intact since they carry execution payloads not present in text deltas.
4. Terminal accounting and token usage remain fully populated for auditability.
5. Argument validation precedes any state read: unknown flags and missing required positionals exit `2` with usage syntax printed to `stderr` (#123).
