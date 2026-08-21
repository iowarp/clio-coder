# Exit Codes & Machine-Readable Output Contracts

This document specifies the process exit codes, machine-readable JSON streaming formats, standard I/O separation rules, and `--help` conventions across all Clio Coder CLI commands in `v0.3.3`.

Source implementations: `src/cli/` and `src/entry/`.

---

## 1. Global Exit Codes

Clio Coder follows a deterministic exit code taxonomy across all commands:

| Exit Code | Meaning | Typical Causes & Conditions |
| :--- | :--- | :--- |
| **`0`** | **Success** | Successful command execution, clean run settlement, `--version`, `--help` invocation, or missing trace database notice without an explicit `--db` flag. |
| **`1`** | **Operational Failure** | Execution error, model target unreachable, doctor diagnosis with unresolved issues, explicit `--db` path not found, or evaluation rubric failure (`fail` or `error` verdict). |
| **`2`** | **Syntax / Usage Error** | Unknown subcommand, invalid flag, missing required positional arguments, global flag placed after subcommand, or data mutation SQL keyword passed to `clio-coder trace sql`. |
| **`3`** | **Unmeasured / Harness State** | Specific to `clio-coder skills eval`: rubric could not be evaluated due to unparseable judge output, timeout, or evidence archive write failure (distinct from a failure/regression). |

---

## 2. The `--help` Standard

Every subcommand in Clio Coder adheres to the strict `--help` convention:

1. **Standard Output**: Usage instructions and options are printed exclusively to `stdout`.
2. **Zero Exit**: The process exits with code `0`.
3. **Zero Side Effects**: Running `clio-coder <subcommand> --help` executes no runtime setup, initiates no network probes, and mutates no state files.

### Global vs Subcommand Flag Positioning

Global options (such as `--api-key`, `--no-context-files`, and `-nc`) must precede the subcommand. Directory redirection is configured via the `CLIO_CODER_*_DIR` environment variables (see [docs/environment-variables.md](environment-variables.md)). If a global flag is placed after the subcommand name, Clio prints a remediation guide to `stderr` and exits with code `2`:

```text
--api-key is a global option and must come before the subcommand: clio-coder --api-key <key> <command> ...
```

---

## 3. Standard I/O Separation & Headless Execution

In headless execution (`clio-coder run`):

1. **Standard Output (`stdout`)**: Reserved strictly for the final answer, deliverable artifact content, or machine-readable JSON streams.
2. **Standard Error (`stderr`)**: Reserved for progress notifications, permission denial advisories, telemetry warnings, and error diagnostics.
3. **Headless Permission Denials**: When a tool requires permission that cannot be granted in headless mode, Clio emits `HEADLESS_PERMISSION_DENIED_REASON`:
   ```text
   clio-coder run cannot confirm permission requests; rerun interactively to approve this action.
   ```
   The denial is delivered to the LLM as a tool result so the agent can adapt or report the limitation. If the run completes after the denial, the process exits `0` with the answer on `stdout`.

---

## 4. Machine-Readable Output Formats (`--json` & `--json-events`)

Many Clio CLI subcommands provide structured JSON output for integration with scripts, CI pipelines, and external orchestrators.

### Subcommand JSON Summary

| Subcommand | Flag | Output Structure |
| :--- | :--- | :--- |
| `clio-coder run` | `--json` | Stream of incremental NDJSON event frames (`session`, `agent_start`, `turn_start`, `message_start`, `message_end`, `thinking_delta`, `text_delta`, `tool_execution_start`, `tool_execution_end`, `turn_end`, `agent_end`). |
| `clio-coder run` | `--json-events terminal` | Emits the `session` header, a synthesized `turn_start` (`startedAt`), the `agent_end` and `notice` events that pass the filter, and a synthesized `turn_end` carrying `startedAt`, `endedAt`, `exitCode`, and `error` when the turn failed. Per-segment token usage rides `agent_end`. Excludes multi-kilobyte intermediate message bodies (#122). |
| `clio-coder run` | `--json-events full` | Emits complete event stream with projected assistant messages (`streamed: true`, `textLength`, `thinkingLength`) to eliminate duplicate wire tokens (#122). |
| `clio-coder agents` | `--json` | JSON array of registered agent recipe metadata objects. |
| `clio-coder targets` | `--json` | JSON object containing the configured `targets` array. |
| `clio-coder models` | `--json` | JSON array of catalog models with capability flags. |
| `clio-coder fleet status` | `--json` | JSON snapshot object with `generatedAt`, `admission` (`open` or `draining`), `running`, `retrying`, and `totals`. Each run row carries its `node`, defaulting to `local`. |
| `clio-coder trace runs` | `--json` | JSON array of trace run records. |
| `clio-coder trace sql` | Positional query | JSON array of rows returned by the read-only SQLite query. A single `SELECT` or read-only `WITH` statement is accepted; multiple statements and mutating keywords are refused with exit code 2. |
| `clio-coder paths` | `--json` | JSON object mapping platform directory names to absolute paths. |

### Incremental Streaming & Deduplication Invariant (#122, #123)

The `--json` stream from `clio-coder run` emits **deltas and increments**, never repeated whole-message snapshots:
1. `text_delta` and `thinking_delta` stream incremental content tokens.
2. `message_end` and `turn_end` frames project assistant content blocks to metadata descriptors (`{ streamed: true, textLength }` and `{ streamed: true, thinkingLength, thinkingSignature }`), stripping raw text/thinking bodies so content is never transmitted across the wire twice.
3. Tool calls and results are preserved intact since they carry execution payloads not present in text deltas.
4. Terminal accounting and token usage remain fully populated for auditability.
5. Exit code validation strictly precedes database inspection: unknown flags, missing required positionals, or mutating SQL queries consistently exit `2` with usage syntax printed to `stderr` (#123).
