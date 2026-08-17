# Exit Codes & Machine-Readable Output Contracts

This document specifies the process exit codes, machine-readable JSON streaming formats, standard I/O separation rules, and `--help` conventions across all Clio Coder CLI commands in `v0.3.1`.

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

Global options (such as `--cwd`, `--config-dir`, `--state-dir`, `--profile`, and `--debug`) must precede the subcommand. If a global flag is placed after the subcommand name, Clio prints a remediation guide to `stderr` and exits with code `2`:

```text
--config-dir is a global option and must come before the subcommand: clio-coder --config-dir <path> <command> ...
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
| `clio-coder run` | `--json` | Stream of incremental NDJSON event frames (`message`, `tool_call`, `tool_result`, `terminal`). |
| `clio-coder run` | `--json-events terminal` | Filters event stream to emit only the final terminal run receipt. |
| `clio-coder agents` | `--json` | JSON array of registered agent recipe metadata objects. |
| `clio-coder targets` | `--json` | JSON object containing the configured `targets` array. |
| `clio-coder models` | `--json` | JSON array of catalog models with capability flags. |
| `clio-coder fleet status` | `--json` | JSON snapshot of cluster nodes, active leases, and drain status. |
| `clio-coder trace runs` | `--json` | JSON array of trace run records. |
| `clio-coder trace sql` | Positional query | JSON array of rows returned by the read-only SQLite `SELECT` query. |
| `clio-coder paths` | `--json` | JSON object mapping platform directory names to absolute paths. |

### Incremental Streaming Invariant

The `--json` stream from `clio-coder run` emits **deltas and increments**, never repeated whole-message snapshots. This guarantees that consumers receive stream tokens linearly without duplicating memory or bandwidth.
