# Troubleshooting & Error Remediation

This guide provides concrete, actionable remediation procedures for
operational errors, permission denials, target connection failures, and system
diagnostics in the current source tree.

---

## Error Catalog & Remediation Matrix

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` | A tool call required manual permission confirmation during a non-interactive headless `clio-coder run` execution. | Run the command interactively in the TUI (`clio`) to grant one-shot approval, adjust the workspace policy in `.clio-coder/safety.yaml`, or run with `--autonomy full-auto` if safe. |
| `no trace database yet at <path>` | The trace mirror database has not been initialized because no interactive sessions or dispatches have executed yet. | Execute a turn or dispatch a task. In SQLite trace commands, this notice is informational (exit code `0`). |
| `trace database not found: <path>` | An explicit `--db <path>` flag was provided pointing to a nonexistent database file. | Verify the database path or omit `--db` to use the default state directory database (`<stateDir>/trace.sqlite`); the next line prints that default path. |
| `no local skill marketplace catalog or index configured` | No catalog directory (`CLIO_CODER_SKILL_CATALOG_DIR`, a `skills/` folder in the working tree, or the installed package's own `skills/` catalog) and no JSON index (`CLIO_CODER_SKILL_MARKETPLACE_INDEX`, `<configDir>/skill-marketplace.json`, or the package's `skills/skill-marketplace.json`) was found. On an npm install this means the package is incomplete; check `clio-coder doctor`. | Point `CLIO_CODER_SKILL_CATALOG_DIR` at a `skills/` catalog or `CLIO_CODER_SKILL_MARKETPLACE_INDEX` at a valid `skill-marketplace.json`, or install a skill directly via `clio-coder skills install <path\|github-url>`. |
| `<arg> is a global option and must come before the subcommand: clio-coder <usage> <command> ...` | A global CLI option (such as `--api-key`, `--no-context-files`, or `-nc`) was placed after the subcommand name. Directory roots are configured via `CLIO_CODER_*_DIR` environment variables. | Move the flag before the subcommand name (e.g. `clio-coder --api-key <key> run ...` instead of `clio-coder run --api-key <key> ...`). |
| `target <id> is not registered` | The designated target ID does not exist in `settings.yaml`. | Run `clio-coder targets` to view available targets, or configure a new target using `clio-coder targets add`. |
| `budget: ceiling must be >= 0 (got <val>)` | A negative session cost ceiling reached the scheduling budget (`src/domains/scheduling/budget.ts`). | Set a non-negative `safety.limits.sessionCostUsd` in `settings.yaml`, or edit Session ceiling (USD) in Settings → Budget. |
| `worker_final_output_missing` | A worker process completed execution with exit code 0 but failed to emit a valid final answer before the stream closed. | Check the worker event log using `clio-coder trace tail <runId>` or inspect the receipt via `monitor(run_id="<id>", mode="receipt")`. |
| `vram_capacity_fit_failure` | The model could not be scheduled or loaded due to insufficient GPU VRAM capacity on the target node. | Select a smaller quantized model variant, reduce context window size, or route to an alternative fleet node with greater memory capacity. |
| `loop_guard_tools_disabled_exhausted` | The loop detector identified repeated unproductive tool calls with identical arguments and disabled tool execution. | Inspect model prompts and provide clearer intermediate steering instructions to prevent recursive tool loops. |
| `Node.js ExperimentalWarning: SQLite is an experimental feature` | Node.js emitted an experimental feature warning for `node:sqlite`. | By default, Clio suppresses this warning via a scoped filter. If visible when running scripts directly, pass `--trace-warnings` to control diagnostics. |
| `cwd-fallback: no-cwd / missing / not-a-directory` | The session recorded in `meta.json` points to a workspace directory that has been deleted, unmounted, or renamed. | When prompted by the `cwd-fallback` overlay, select a valid existing directory to re-anchor the session. |
| `LM Studio duplicate model load / peer projection` | Sending a bare model key that already has a loaded instance or an LM Link peer projection. | Clio resolves model IDs to resident instances automatically. Verify loaded instances on the target server with `clio-coder targets --probe`. |
| `llama.cpp 400 model is already running` | Sending load requests to a router where the model is idle/sleeping. | Sleeping models are treated as resident. Verify router slots and catalog models before initiating eviction. |
| `OAuth token exchange cancelled` | An in-flight OAuth login or credential refresh was aborted before persistence. | Re-run `clio-coder auth login <target>` to restart the OAuth flow cleanly. Uncommitted tokens are discarded. |

---

## Reading a cold cache

On a local server prefill is most of what a turn costs, so a cold prefix cache is the difference between a first token in under a second and one in fifty. This is how to find out why a turn went cold, starting from what the TUI shows.

**1. Read the `/context` cache lines.** Two lines answer different questions. The prompt-cache line says what the provider reported and whether the compiled prompt shell was reused. The prefill line says what the server itself did:

```text
prefill: 34,951 uncached · 0 cached · 48,617 ms
```

Those are the server's own numbers, not Clio's estimate. `server does not report cache reads` in place of the cached figure means the backend gave no `cache_n` at all, which is LM Studio 2.29.0's OpenAI-compatible port today; on that target the verdict comes from the provider's `cached_tokens` instead and the prefill line reports only total prompt work and milliseconds.

**2. Look for the expected-cold line.** When the last settled run came back `cold` and Clio had recorded a cause, `/context` names it rather than warning:

```text
last cold turn: working-set eviction (expected)
```

The eight causes and what stamps each one are in [context-engine.md](context-engine.md#cache-divergence-honesty). `background_memory` renders in prose as `last cold turn: background memory step (expected)`.

**3. Confirm it in the ledger.** The reasons are durable, so a finished session answers the same question without the TUI. Open `current.jsonl` under the session directory `clio-coder paths` reports and read the run's first assistant entry:

```json
{
  "timing": { "ttftMs": 53194, "apiMs": 56770 },
  "promptCache": {
    "input": 34951, "cacheRead": 0, "cacheWrite": 0,
    "backendVerdict": "cold",
    "expectedColdReasons": ["dispatch", "residency"],
    "backend": {
      "promptTokens": 34951, "cachedTokens": 0, "predictedTokens": 24,
      "promptMs": 48617, "predictedMs": 373, "source": "llamacpp-timings"
    }
  }
}
```

`expectedColdReasons` is stamped once per run, on its first persisted call, so a turn with several model calls carries it on the first one only. `clio-coder doctor` folds the latest session for you and prints the verdict counts plus the most frequent reason, and `clio-coder usage report` gives per-session uncached prefill and verdict counts across the window.

**4. When there is no reason, the warning is the finding.** A cold backend with a reused prompt shell and no recorded reason is a real disagreement: Clio kept the bytes stable and the server re-prefilled anyway. `/context` leaves the warning in place for exactly that case. Four causes are worth checking in order, and none of them is a Clio bug:

- **The server slept.** A llama.cpp router started with `--sleep-idle-seconds N` drops the slot's prefix cache when it sleeps, and `--cache-ram` does not reliably restore a large state. A gap longer than that setting between two turns explains a cold turn completely. Raise the flag, or accept that a session left idle pays for its first turn back.
- **Something else used the endpoint.** A worker, a second Clio session, or another client on the same server evicts the slot. Clio stamps `dispatch`, `residency`, and `background_memory` only for work it can attribute to itself on that endpoint; a foreign process leaves no stamp. `clio-coder targets --probe` reports the endpoint's slot count, and `/fleet` settings show active slots per endpoint.
- **The model was swapped.** A router serving one model at a time reloads on a residency change, and everything the previous model had cached is gone. This normally does stamp `residency`, but only when the mutation went through Clio.
- **The prompt moved for a reason Clio did not classify.** Compare the run's `promptHash` and `toolSignature` in `context-snapshots.jsonl` against the previous run's. Equal hashes with a cold backend point at the server; different hashes with no `prompt_recompiled` or `tool_surface_change` stamp is worth an issue.

One case is expected on hybrid architectures and looks like a bug. Qwen3.8 keeps recurrent state that llama.cpp cannot roll back to an arbitrary token, so a change anywhere inside a cached prefix re-prefills from the last context checkpoint rather than from the changed byte. A small edit to old history can therefore cost thousands of tokens of prefill with the prompt hash otherwise stable. The server's checkpoint count and its `--checkpoint-min-step` are the levers; see the `qwen3.8-27b` family's `serving` and `measuredUnder` notes in `src/domains/providers/models/local-models/clio-coder-local-coding-targets.yaml` for the measured figures and the exact argv they were taken under.

---

## A TUI that stops answering the keyboard

When an interactive session stops responding to typing, the question worth
answering before anything else is which half of the input pipeline stopped: the
stdin reader that hands bytes to the application, or the renderer that turns
them into a frame on stdout. Clio keeps that evidence without being asked. Every
interactive process holds a bounded in-memory ring of the last 256 input-ingress
records and the last 256 committed frames, and writes it out when the process
receives `SIGTERM`, which is the signal a `kill` of the stuck pane sends.

The dump lands in the state directory `clio-coder paths` reports:

```text
<stateDir>/input-wedge/<ISO timestamp>-<pid>.json
```

The five newest dumps are kept and older ones are removed as new ones land.
Read `classification` first:

| `classification` | What it means |
| :--- | :--- |
| `input-not-committed` | Bytes reached the application and no frame carrying them ever reached stdout. The renderer is the stuck half. |
| `no-input-recorded` | Nothing was delivered at all. If the operator was typing, the stdin reader is the stuck half. |
| `input-committed` | Both halves were moving. Whatever the session was doing, it was not this pipeline. |

`msSinceLastInputIngress` and `msSinceLastCommittedFrame` say how long each half
had been quiet when the signal arrived, and the `inputIngress` and `frames`
arrays carry the records themselves. Frames are kept only when they reached
stdout, so an empty `frames` array is itself a finding.

For a full session trace rather than the tail, set `CLIO_CODER_RENDER_TRACE` to
a file path before starting the session. That writes every record, including
provider deltas and terminal writes, as JSONL. The ring is the always-on subset
of the same records, for the case where nobody armed the trace first.

---

## Diagnostic Commands

When encountering unexpected system behavior:

1. **System Health Check**: Run `clio-coder doctor` (or `clio-coder doctor --fix` to auto-repair state directory permissions and configuration defaults).
2. **Target Connectivity Probe**: Run `clio-coder targets --probe` to verify authentication and reachability for all configured LLM providers.
3. **Trace Store Inspection**: Run `clio-coder trace runs` and `clio-coder trace tail <runId>` to inspect event logs, durations, and tool outputs.
4. **Receipt Validation**: Run `clio-coder evidence inspect <evidenceId>` or `/view verify <runId>` to check cryptographic integrity and execution telemetry. Build the evidence id first with `clio-coder evidence build --run <runId>`.
