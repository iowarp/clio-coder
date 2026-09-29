# Troubleshooting & Error Remediation

This guide provides concrete, actionable remediation procedures for
operational errors, permission denials, target connection failures, and system
diagnostics in the current source tree.

---

## Error Catalog & Remediation Matrix

| User-Facing Error / Notice | Cause | Actionable Remediation |
| :--- | :--- | :--- |
| `clio-coder run cannot confirm permission requests; rerun interactively to approve this action.` | A tool call required manual permission confirmation during a non-interactive headless `clio-coder run` execution. | Run interactively in the TUI (`clio-coder`) to review and approve the request, or review the workspace policy in `.clio-coder/safety.yaml`. `--autonomy yolo` removes ordinary confirmation prompts; damage-control rules can still require approval. |
| `fleet.decisionProfiles: retired without replacement: System One replaced decision profiles; bind an engine under systemOne.engines and systemOne.sites. Remove this key` | `settings.yaml` carries a non-empty `fleet.decisionProfiles` from the earlier decision layer. An empty `{}` is accepted. | Delete the key and bind an engine under `systemOne.engines` and `systemOne.sites`. See [System One](system-one.md#migration-from-057). |
| `turnControl.interpretation: retired without replacement: the turn site (systemOne.sites.turn) reads the request and nothing falls back to the main model. Remove this key` | An older `init` wrote `turnControl.interpretation.fallback: none` into `settings.yaml`. | Delete the `interpretation` block under `turnControl`. To let a decision model read the request, bind the `turn` site. |
| `systemOne.sites.<site>: engine '<name>' is not defined in systemOne.engines` or `systemOne.engines.<name>.target: target '<id>' is not defined in targets` | A site binds an engine that is missing, or an engine names a target that is not configured. | Declare the engine under `systemOne.engines` and the target under `targets`, then run `clio-coder doctor` and read the `system one <site>` rows. |
| A System One site is bound but nothing ever changes | The answering build has no fitted cut for that site, so the site runs in shadow: recorded (when `systemOne.record` is on, or always for `toolCall` and `toolResult`), no hint, gate or act. LLM engines and unfitted Jev or Laya builds are always in this state. | Read the build in `clio-coder systemone status` or the ledger, and fit cuts with `scripts/decision-probe.ts`, or set `systemOne.cuts`. See [System One](system-one.md#calibration-and-shadow-mode). |
| `no trace database yet at <path>` | The trace mirror database has not been initialized because no interactive sessions or dispatches have executed yet. | Execute a turn or dispatch a task. In SQLite trace commands, this notice is informational (exit code `0`). |
| `trace database not found: <path>` | An explicit `--db <path>` flag was provided pointing to a nonexistent database file. | Verify the database path or omit `--db` to use the default state directory database (`<stateDir>/trace.sqlite`); the next line prints that default path. |
| `no local skill marketplace catalog or index configured` | No catalog directory (`CLIO_CODER_SKILL_CATALOG_DIR`, a `library/skills/` folder in the working tree, or the installed package's own `library/skills/` catalog) and no JSON index (`CLIO_CODER_SKILL_MARKETPLACE_INDEX`, `<configDir>/skill-marketplace.json`, or the package's `library/skills/skill-marketplace.json`) was found. On an npm install this means the package is incomplete; check `clio-coder doctor`. | Point `CLIO_CODER_SKILL_CATALOG_DIR` at a `library/skills/` catalog or `CLIO_CODER_SKILL_MARKETPLACE_INDEX` at a valid `skill-marketplace.json`, or install a skill directly via `clio-coder library install <path\|github-url>`. |
| `<arg> is a global option and must come before the subcommand: clio-coder <usage> <command> ...` | A global CLI option (such as `--api-key`, `--no-context-files`, or `-nc`) was placed after the subcommand name. Directory roots are configured via `CLIO_CODER_*_DIR` environment variables. | Move the flag before the subcommand name (e.g. `clio-coder --api-key <key> run ...` instead of `clio-coder run --api-key <key> ...`). |
| `no target with id <id>` (from `clio-coder targets use`) or `unknown target or runtime: <id>` (from `clio-coder auth`) | The named target ID does not exist in `settings.yaml`. | Run `clio-coder targets` to view available targets, or configure a new target using `clio-coder targets add`. |
| `budget: ceiling must be >= 0 (got <val>)` | A negative session cost ceiling reached the scheduling budget ([budget.ts](../../src/domains/scheduling/budget.ts)). | Set a non-negative `safety.limits.sessionCostUsd` in `settings.yaml`, or edit Session ceiling (USD) in Settings → Permissions & Limits. |
| `worker_final_output_missing` | A worker process completed execution with exit code 0 but failed to emit a valid final answer before the stream closed. | Check the worker event log using `clio-coder trace tail <runId>` or inspect the receipt via `monitor(run_id="<id>", mode="receipt")`. |
| `vram_capacity_fit_failure` | The model could not be scheduled or loaded due to insufficient GPU VRAM capacity on the target node. | Select a smaller quantized model variant, reduce context window size, or route to an alternative fleet node with greater memory capacity. |
| `Serving context window is unknown. Probe the target or configure its deployment limit; threshold compaction is disabled until a limit is known.` | No probe, loaded-model state or setting reported the route's serving window. `/context` shows `context window unknown` and threshold compaction is off. A server overflow still triggers one compact-and-retry. | Run `clio-coder targets --probe` with the model loaded, or set `targets[].capabilities.contextWindow` to the deployment's limit. See [Context-window provenance](configuration-and-targets.md#context-window-provenance). |
| `safety.autonomy: expected one of default \| yolo, got "auto-edit"; the retired value "auto-edit" becomes "default"` | The settings file comes from a release before 0.5.6 and uses a retired enum value, so every command stops at validation. Other retired values (`suggest`, `read-only`, `full-auto`, lifecycle `clio-managed`, tool governance `clio-policy`) fail the same way. | Run `clio-coder doctor` to preview the rewrite, then `clio-coder doctor --fix`, which replaces each retired value with the one the message names and keeps comments. |
| `loop_guard_tools_disabled_exhausted` | The loop detector identified repeated unproductive tool calls with identical arguments and disabled tool execution. | Inspect model prompts and provide clearer intermediate steering instructions to prevent recursive tool loops. |
| `Node.js ExperimentalWarning: SQLite is an experimental feature` | Node.js emitted an experimental feature warning for `node:sqlite`. | Clio suppresses this one warning with a scoped filter when it loads the trace database. The filter stands down when Node runs with `--trace-warnings`, so that flag makes the warning visible again. |
| `cwd-fallback: no-cwd / missing / not-a-directory` | The session recorded in `meta.json` points to a workspace directory that has been deleted, unmounted, or renamed. | When prompted by the `cwd-fallback` overlay, select a valid existing directory to re-anchor the session. |
| `LM Studio duplicate model load / peer projection` | Sending a bare model key that already has a loaded instance or an LM Link peer projection. | Clio resolves model IDs to resident instances automatically. Verify loaded instances on the target server with `clio-coder targets --probe`. |
| `llama.cpp 400 model is already running` | Sending load requests to a router where the model is idle/sleeping. | Sleeping models are treated as resident. Verify router slots and catalog models before initiating eviction. |
| `Sign-in cancelled` | An OAuth sign-in prompt in the configure wizard was dismissed before a credential was entered. | Re-run `clio-coder auth login <target>` or the configure wizard to restart the sign-in. |

---

## Reading a cold cache

Prefix caching can reduce repeated prompt processing. Use `/context` to inspect
provider cache usage, compiled-prompt reuse, and any backend prefill timing.
Available fields depend on the serving runtime. A backend that omits cache-read
telemetry is shown without that observation.

When Clio records a cause for a cold prefix, `/context` names it, for example:

```text
last cold turn: working-set eviction (expected)
```

The [context engine](../architecture/context-engine.md#prefix-caching-and-cache-observations)
describes the eight recorded causes and the prompt layers they affect. Changes
to thinking settings, tool schemas, selected context, or model residency can
change the reusable prefix.

For a finished session, inspect the first assistant entry for each run in its
`current.jsonl`. `clio-coder paths` locates the session store. The
`promptCache.expectedColdReasons` field records causes;
`promptCache.backendVerdict` records the backend observation. Available backend
token counts and timing live under `promptCache.backend`. These commands provide
summaries:

```bash
clio-coder doctor
clio-coder usage report
```

If the compiled prompt was reused but the backend reports a cold prefix, check:

- **Server lifetime and sleep settings.** A restart, unload, or router sleep can
  discard resident cache state.
- **Other traffic on the endpoint.** Workers, another session, or another client
  can use the same cache slots. `clio-coder targets --probe` reports available
  slot information; fleet settings show Clio's active endpoint allocations.
- **Model residency.** Switching a router to another model can replace the
  previous model's cache state.
- **Prompt identity.** Compare `promptHash` and `toolSignature` in
  `context-snapshots.jsonl`. Changes identify prompt or tool-surface updates;
  record the relevant diagnostics when reporting an unexplained cache miss.

Hybrid models with recurrent state can require processing from a context
checkpoint when earlier history changes. Check the serving runtime's checkpoint
configuration and the model's serving notes.

A cache hit can still have a long time to first token when the server restores
slots from host memory or waits for another request. For supported llama.cpp
router configurations, Doctor and target probes report idle-slot caching.
`--no-cache-idle-slots` or `cache-idle-slots = false` changes that behavior; choose
it according to the server's memory capacity and concurrent workload.

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

1. **System Health Check**: Run `clio-coder doctor` (or `clio-coder doctor --fix` to repair directory structure, credential permissions and retired or YAML 1.1 settings values, and record fleet preflight results).
2. **Target Connectivity Probe**: Run `clio-coder targets --probe` to verify authentication and reachability for all configured LLM providers.
3. **Trace Store Inspection**: Run `clio-coder trace runs` and `clio-coder trace tail <runId>` to inspect event logs, durations, and tool outputs.
4. **Receipt Validation**: Run `clio-coder evidence inspect <evidenceId>` or `/view verify <runId>` to check cryptographic integrity and execution telemetry. Build the evidence id first with `clio-coder evidence build --run <runId>`.
