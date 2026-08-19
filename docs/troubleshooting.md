# Troubleshooting & Error Remediation

This guide provides concrete, actionable remediation procedures for operational errors, permission denials, target connection failures, and system diagnostics in Clio Coder `v0.3.2`.

---

## Error Catalog & Remediation Matrix

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` | A tool call required manual permission confirmation during a non-interactive headless `clio-coder run` execution. | Run the command interactively in the TUI (`clio`) to grant one-shot approval, adjust the workspace policy in `.clio-coder/safety.yaml`, or run with `--autonomy full-auto` if safe. |
| `no trace database yet at <path>` | The trace mirror database has not been initialized because no interactive sessions or dispatches have executed yet. | Execute a turn or dispatch a task. In SQLite trace commands, this notice is informational (exit code `0`). |
| `error: trace database not found: <path>` | An explicit `--db <path>` flag was provided pointing to a nonexistent database file. | Verify the database path or omit `--db` to use the default state directory database (`<stateDir>/trace.sqlite`). |
| `no local skill marketplace catalog or index configured` | No catalog directory (`CLIO_CODER_SKILL_CATALOG_DIR`, a `skills/` folder in the working tree, or the installed package's own `skills/` catalog) and no JSON index (`CLIO_CODER_SKILL_MARKETPLACE_INDEX`, `<configDir>/skill-marketplace.json`, or the package's `skills/skill-marketplace.json`) was found. On an npm install this means the package is incomplete; check `clio-coder doctor`. | Point `CLIO_CODER_SKILL_CATALOG_DIR` at a `skills/` catalog or `CLIO_CODER_SKILL_MARKETPLACE_INDEX` at a valid `skill-marketplace.json`, or install a skill directly via `clio-coder skills install <path\|github-url>`. |
| `<arg> is a global option and must come before the subcommand: clio-coder <usage> <command> ...` | A global CLI option (such as `--api-key`, `--no-context-files`, or `-nc`) was placed after the subcommand name. Directory roots are configured via `CLIO_CODER_*_DIR` environment variables. | Move the flag before the subcommand name (e.g. `clio-coder --api-key <key> run ...` instead of `clio-coder run --api-key <key> ...`). |
| `target <id> is not registered` | The designated target ID does not exist in `settings.yaml`. | Run `clio-coder targets` to view available targets, or configure a new target using `clio-coder targets add`. |
| `budget: ceiling must be >= 0 (got <val>)` | A negative session cost ceiling reached the scheduling budget (`src/domains/scheduling/budget.ts`). | Set a non-negative `budget.sessionCeilingUsd` in `settings.yaml`, or edit Session ceiling (USD) in Settings → Budget. |
| `worker_final_output_missing` | A worker process completed execution with exit code 0 but failed to emit a valid final answer before the stream closed. | Check the worker event log using `clio-coder trace tail <runId>` or inspect the receipt via `monitor(run_id="<id>", mode="receipt")`. |
| `vram_capacity_fit_failure` | The model could not be scheduled or loaded due to insufficient GPU VRAM capacity on the target node. | Select a smaller quantized model variant, reduce context window size, or route to an alternative fleet node with greater memory capacity. |
| `loop_guard_tools_disabled_exhausted` | The loop detector identified repeated unproductive tool calls with identical arguments and disabled tool execution. | Inspect model prompts and provide clearer intermediate steering instructions to prevent recursive tool loops. |
| `Node.js ExperimentalWarning: SQLite is an experimental feature` | Node.js emitted an experimental feature warning for `node:sqlite`. | By default, Clio suppresses this warning via a scoped filter. If visible when running scripts directly, pass `--trace-warnings` to control diagnostics. |
| `cwd-fallback: no-cwd / missing / not-a-directory` | The session recorded in `meta.json` points to a workspace directory that has been deleted, unmounted, or renamed. | When prompted by the `cwd-fallback` overlay, select a valid existing directory to re-anchor the session. |
| `LM Studio duplicate model load / peer projection` | Sending a bare model key that already has a loaded instance or an LM Link peer projection. | Clio resolves model IDs to resident instances automatically. Verify loaded instances on the target server with `clio-coder targets --probe`. |
| `llama.cpp 400 model is already running` | Sending load requests to a router where the model is idle/sleeping. | Sleeping models are treated as resident. Verify router slots and catalog models before initiating eviction. |
| `OAuth token exchange cancelled` | An in-flight OAuth login or credential refresh was aborted before persistence. | Re-run `clio-coder auth login <target>` to restart the OAuth flow cleanly. Uncommitted tokens are discarded. |

---

## Diagnostic Commands

When encountering unexpected system behavior:

1. **System Health Check**: Run `clio-coder doctor` (or `clio-coder doctor --fix` to auto-repair state directory permissions and configuration defaults).
2. **Target Connectivity Probe**: Run `clio-coder targets --probe` to verify authentication and reachability for all configured LLM providers.
3. **Trace Store Inspection**: Run `clio-coder trace runs` and `clio-coder trace tail <runId>` to inspect event logs, durations, and tool outputs.
4. **Receipt Validation**: Run `clio-coder evidence inspect <evidenceId>` or `/view verify <runId>` to check cryptographic integrity and execution telemetry. Build the evidence id first with `clio-coder evidence build --run <runId>`.
