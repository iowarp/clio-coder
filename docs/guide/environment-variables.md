# Environment Variables

This page inventories Clio-specific runtime variables and the ambient variables that materially change documented operator behavior. `settings.yaml` is the durable home for operator policy; environment variables support per-process overrides, directory layout, debugging, credentials, terminal integration, and internal plumbing. When prose and source disagree, prefer the cited read site.

The `environment-variable-inventory` check in [check-hygiene.ts](../../scripts/check-hygiene.ts), run by `pnpm run lint`, enforces coverage for Clio's `CLIO_*` variables and `NO_COLOR`. It intentionally does not treat every operating-system or provider convention as a Clio knob. Examples outside that enforced family include `PATH`, `HOME`, terminal capability variables, and provider API-key names selected dynamically by [env-api-keys.ts](../../src/engine/env-api-keys.ts). The check also runs the other way: every variable this page names in backticks must still be read by Clio's source, so a variable that is removed cannot keep its row.

## Behavior knobs without a settings key

| Variable | Default | Controls |
| --- | --- | --- |
| `NO_COLOR` | unset | Set to any non-empty value to drop every foreground and background color. Bold, dim, italic, and underline stay, because they are what is left to read the interface by ([tokens.ts](../../src/interactive/theme/tokens.ts)). |
| `CLIO_CODER_THEME` | unset | `dark` or `light` picks the palette drawn for that terminal background and skips the startup OSC 11 query; `neutral` forces the mid-luminance palette that reads on either. Unset detects the background from the terminal's OSC 11 reply, then `COLORFGBG` ([terminal-background.ts](../../src/core/terminal-background.ts)). |
| `CLIO_CODER_UPDATE_CHECK` | on | `0` disables background update checks, detection of a replaced installation, and upgrade hints. Checks start only in an interactive session, after its first full frame and a five-second delay ([interactive-application.ts](../../src/interactive/interactive-application.ts), [update-check.ts](../../src/domains/lifecycle/update-check.ts)). |
| `NO_UPDATE_NOTIFIER` | unset | Any non-empty value suppresses the update monitor. A non-empty `CI` also suppresses it. Explicit `clio-coder upgrade` still works. |
| `CLIO_CODER_RIGOR` | repo-derived | Finish-contract evidence bar, `normal` or `high`, layered over the repo-derived default ([rigor.ts](../../src/domains/safety/rigor.ts)). |
| `CLIO_CODER_ANTHROPIC_CACHE_RETENTION` | unset | Native engine requests using `anthropic-messages` accept `none`, `short`, or `long`. Long requests ask for a one-hour cache TTL when the model's compatibility metadata supports it. An explicit per-call preference wins; unset preserves SDK defaults, and other APIs are unchanged ([provider-diagnostics.ts](../../src/engine/provider-diagnostics.ts)). |
| `CLIO_CODER_PROVIDER_DUMP_PATH` | unset | Absolute path for opt-in native-provider JSONL diagnostics. One record per completed call contains payloads after caller callbacks and the terminal response. The parent directory must exist; the file must be operator-owned, regular, mode `0600`, and not a symlink. New files use that mode. Auth options and headers are omitted, known provider credentials are redacted, and prompt/message/tool content is retained. Keep this diagnostic private and delete it when finished. Ledger events are unchanged; external CLI transports are not captured (`src/engine/provider-diagnostics.ts`). |
| `CLIO_CODER_FORCE_COMPACT` | off | `1` forces compaction before every interactive turn for as long as it is set ([chat-loop.ts](../../src/interactive/chat-loop.ts)). |
| `CLIO_CODER_LEGACY_MASK` | off | `1` temporarily restores the destructive stale-observation mask before summary compaction; remove it after compatibility diagnosis. |
| `CLIO_CODER_STATUS_STUCK_MS` | 180000 | Stuck-turn watchdog threshold ([watchdog.ts](../../src/interactive/status/watchdog.ts)). |
| `CLIO_CODER_SHUTDOWN_HOOK_MS` | 500 | Wall-clock budget per shutdown hook ([termination.ts](../../src/core/termination.ts)). |
| `CLIO_CODER_HOOK_BUDGET_MS` | per-phase built-ins | Global middleware hook wall-clock budget ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` | per-phase built-ins | Per-phase hook budget, e.g. `CLIO_CODER_HOOK_BUDGET_TURN_END_MS`; beats the global var. |
| `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS` | 1 | Hook calls exempted from budget accounting at startup. |
| `CLIO_CODER_HOOK_BUDGET_WINDOW` | 5 | Sliding-window size for steady-state hook-budget warnings. |
| `CLIO_CODER_HOOK_BUDGET_THRESHOLD` | 3 | Overruns within the window before a steady-state warning. |
| `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT` | 131072 | Largest context length Clio requests when it loads an LM Studio model while another model is resident on the same server. LM Studio reports no VRAM and caps GPU offload instead of refusing an oversized load, so a KV cache that does not fit is served from CPU at a crawl; the ceiling bounds that by evidence. `off` or `0` disables clamping ([lmstudio-residency.ts](../../src/engine/apis/lmstudio-residency.ts)). |
| `CLIO_CODER_SKILL_CATALOG_DIR` | unset | Local skill-catalog directory override ([marketplace.ts](../../src/domains/resources/skills/marketplace.ts)). |
| `CLIO_CODER_SKILL_MARKETPLACE_INDEX` | unset | Skill-marketplace index path override (`src/domains/resources/skills/marketplace.ts`). |
| `CLIO_CODER_MODEL_CATALOG_DIRS` | unset | Extra model-catalog directories ([knowledge-base-path.ts](../../src/domains/providers/knowledge-base-path.ts)). |
| `CLIO_CODER_ENDPOINT_SLOTS_TTL_MS` | 86400000 | How long a persisted endpoint slot count answers for an endpoint nothing has probed in this process. A record past the bound is ignored and pruned rather than allowed to over-admit ([endpoint-slots-store.ts](../../src/domains/providers/endpoint-slots-store.ts)). |
| `CLIO_CODER_DISABLE_RETRIEVE_TOOLS` | off | `1` strips RETRIEVE tools from registries. Bash, hooks, external CLIs, and provider networking remain available; hermetic runs require OS isolation. Legacy `CLIO_CODER_NO_NETWORK_TOOLS=1` is accepted. |
| `CLIO_CODER_NO_NETWORK_TOOLS` | off | Legacy alias of `CLIO_CODER_DISABLE_RETRIEVE_TOOLS`; disables retrieval tools only, with no shell network isolation. |
| `CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK` | off | `1` permits web_fetch to reach private and local services; operator process setting only, never a tool argument or project setting ([network-policy.ts](../../src/tools/network-policy.ts)). |
| `CLIO_CODER_REDUCE_MOTION` | off | `1` makes smooth-streaming `auto` use the immediate coalescer. Explicit `on` remains an operator request, while stdout backpressure still pauses frame production. |
| `CLIO_CODER_SCREEN_READER` | off | `1` makes smooth-streaming `auto` use the immediate coalescer so a screen reader receives the existing low-motion update behavior. |
| `CLIO_CODER_INSTANT_SHELL` | on | `0` disables the single-owner Stage 0 interactive shell for immediate rollback. Unset or `1` mounts one terminal/editor owner before service hydration; ACP, headless, ordinary non-TTY, and subcommand paths never mount it. An explicit `CLIO_CODER_INTERACTIVE=1` keeps its force-interactive non-TTY behavior. |
| `CLIO_CODER_TRACE_RETENTION_DAYS` | 30 | Maximum age in days for terminal rows in the rebuildable SQLite trace mirror. The value is an integer of at least 1 ([trace-store.ts](../../src/domains/observability/trace-store.ts)). |
| `CLIO_CODER_TRACE_MAX_BYTES` | 134217728 | Maximum allocated size for the SQLite trace mirror before the oldest terminal runs are pruned. The value is an integer of at least 1,048,576 (`src/domains/observability/trace-store.ts`). |

## Directory and install layout

| Variable | Default | Controls |
| --- | --- | --- |
| `CLIO_CODER_HOME` | unset | Single-tree install root; the per-role vars below beat it ([xdg.ts](../../src/core/xdg.ts)). |
| `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, `CLIO_CODER_CACHE_DIR` | XDG platform defaults | Per-role directory overrides (`src/core/xdg.ts`). |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | platform/user defaults | Linux base directories used when the corresponding `CLIO_CODER_*_DIR` and `CLIO_CODER_HOME` variables are unset (`src/core/xdg.ts`). |
| `APPDATA`, `LOCALAPPDATA` | Windows profile defaults | Windows roaming and local base directories used when Clio-specific directory overrides are unset (`src/core/xdg.ts`). |
| `CLIO_CODER_BIN_DIR` | `~/.local/bin` | Launcher symlink location ([uninstall.ts](../../src/cli/uninstall.ts)). |
| `CLIO_CODER_PACKAGE_ROOT` | auto-detected | Package root for bundled-asset resolution ([package-root.ts](../../src/core/package-root.ts)). |

## Ambient provider, runtime, and terminal inputs

These names follow an upstream or operating-system convention. They are not substitutes for settings keys, but source reads them when the associated integration is used.

| Variable or family | Controls |
| --- | --- |
| Provider credential variables | [env-api-keys.ts](../../src/engine/env-api-keys.ts) maps the selected provider to its conventional key, including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `AWS_*` Bedrock credentials, and Google Vertex application credentials. `clio-coder auth` remains the preferred managed credential path. |
| `VISUAL`, `EDITOR` | External editor command, with `VISUAL` taking precedence ([external-editor.ts](../../src/core/external-editor.ts)). |
| `TERM`, `COLORTERM`, `COLORFGBG`, `TERM_PROGRAM`, `WT_SESSION` | Terminal capability, color-depth, background, keybinding, and desktop-notification adaptation. These variables describe the terminal rather than Clio policy. |
| `SSH_CONNECTION`, `SSH_TTY`, `TMUX`, `STY` | Remote-session and terminal-multiplexer detection used by the adaptive stream-pacing policy ([stream-pacing-policy.ts](../../src/interactive/stream-pacing-policy.ts)). |
| `COLUMNS` | Fallback text width for non-TTY CLI output ([text-layout.ts](../../src/cli/text-layout.ts)). |
| `TZ` | Local timestamp formatting and daily audit-log date boundaries ([format-time.ts](../../src/interactive/format-time.ts), [audit.ts](../../src/domains/safety/audit.ts)). |
| `CI` | CI-sensitive presentation behavior. It grants no tool authority. |
| `ZELLIJ` | Zellij detection. Like `TMUX`, `STY`, or a `tmux` or `screen` terminal type, it marks a multiplexed terminal, where Clio restores mouse tracking after a text selection without any-motion reporting ([instrumented-tui.ts](../../src/engine/instrumented-tui.ts)). |
| `SHELL`, `ComSpec` | The shell that runs the external editor command and a stored API key written as a `!command`. Unset falls back to `/bin/sh`; on Windows the stored-key command runs under `ComSpec`, default `cmd.exe` ([external-editor.ts](../../src/core/external-editor.ts), [resolve-config-value.ts](../../src/core/resolve-config-value.ts)). |
| `OLLAMA_API_KEY` | Bearer token for an Ollama target whose URL is `https://ollama.com`, sent only when the request carries no `authorization` header of its own. Clio reads it directly in [ollama-http.ts](../../src/engine/apis/ollama-http.ts), not through the `env-api-keys.ts` mapping above. |
| `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` | herdr pane-host detection. Guest panes need `HERDR_ENV=1`, which herdr sets in every pane it opens; unless it is `1`, Clio opens no socket. `HERDR_SOCKET_PATH` names the socket, and `HERDR_SESSION` selects `sessions/<name>/herdr.sock` under herdr's config directory. The workspace, tab, and pane ids locate Clio's own pane: docks split from it, and only panes in its workspace are adopted ([detect.ts](../../src/domains/mux/detect.ts)). See [Panes and the Files Pane](panes-and-files.md). |
| `USER`, `LOGNAME`, `USERNAME` | Fallbacks, in that order, for the local account name when the operating-system lookup returns nothing. The account and host name are stamped into run receipts and stated in the session prompt's workspace section as execution-environment facts (`src/domains/dispatch/run-identity.ts`). |
| `XDG_RUNTIME_DIR` | First tmpfs candidate, ahead of `/dev/shm`, for task worktrees when `fleet.worktrees.root` is `tmpfs` or `auto`. It is used only when it is an absolute path ([worktree-root.ts](../../src/tools/worktree-root.ts)). See [Fleet dispatch](fleet-dispatch.md). |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTIGRAVITY_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR` | Home directory of each coding agent that interop inventories, in place of its default under your home directory ([registry.ts](../../src/domains/interop/registry.ts)). `CODEX_HOME` also locates Codex's `auth.json` for the quota reader and is passed to a Codex peer. See [Coding Agent Interoperability](interop.md). |
| `OPENCODE_CONFIG` | OpenCode's own config file. When Clio runs the OpenCode CLI as a peer, it reads this file and `opencode.json` or `opencode.jsonc` under `OPENCODE_CONFIG_DIR` for `{env:NAME}` API-key references, and forwards only those named variables to the child ([opencode.ts](../../src/engine/external-cli/opencode.ts)). |
| `NODE_COMPILE_CACHE`, `NODE_DISABLE_COMPILE_CACHE` | Node's own compile-cache controls, which beat Clio's. Any `NODE_DISABLE_COMPILE_CACHE` value turns Clio's V8 compile cache off, and a set `NODE_COMPILE_CACHE` replaces Clio's cache directory with the one it names. When either is set, workers inherit it unchanged and Clio injects no cache of its own ([compile-cache.ts](../../src/core/compile-cache.ts)). |
| `NODE_OPTIONS` | Read only for `--trace-warnings`. Clio drops Node's experimental warning for the SQLite trace mirror unless warning tracing is requested there or in Node's own flags ([trace-store.ts](../../src/domains/observability/trace-store.ts)). |

## Debug and trace toggles

All default off; enable with `1`.

| Variable | Controls |
| --- | --- |
| `CLIO_CODER_BUS_TRACE` | Event-bus channel tracing to stderr ([bus-trace.ts](../../src/core/bus-trace.ts)). |
| `CLIO_CODER_TRACE_BOOT` | Boot-phase timing trace ([boot-trace.ts](../../src/core/boot-trace.ts)). |
| `CLIO_CODER_TIMING` | Startup timing report, printed only on the bannered non-interactive boot ([orchestrator.ts](../../src/entry/orchestrator.ts)). |
| `CLIO_CODER_DEBUG_SHUTDOWN` | Shutdown-path diagnostics ([termination.ts](../../src/core/termination.ts)). |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | Per-overrun hook-budget diagnostics ([runtime.ts](../../src/domains/middleware/runtime.ts)). |

### File-writing traces

These two take a path, not `1`. Setting either to `1` writes a file named `1` in the working directory. Both are off when unset or empty, and both create parent directories.

| Variable | Contents | Controls |
| --- | --- | --- |
| `CLIO_CODER_RENDER_TRACE` | timing only | Versioned JSONL for the full interactive render pipeline, truncated on open so one file is one session. Records event/input sequence ranges, queue and panel high-water marks, explicit frames, grouped stdout commits, write return values, backpressure, and drain—but no conversation text. Output is bounded and asynchronous after the initial pre-TUI file open; trace failure is nonfatal. See [performance-methodology.md](../architecture/observability.md) for endpoint definitions ([render-trace.ts](../../src/interactive/render-trace.ts)). |
| `CLIO_CODER_MEMORY_TRACE` | conversation text | Proactive task-memory step envelopes, including up to 8000 characters of the text each step saw. This is content-bearing by construction, so the file carries whatever the session carried. Do not enable it on work you would not paste, and do not attach the file to a bug report without reading it first ([task-memory-trace.ts](../../src/domains/memory/task-memory-trace.ts)). |

Example:

```bash
CLIO_CODER_RENDER_TRACE=/tmp/clio-coder-render.jsonl clio-coder
```

## Internal plumbing

Set by Clio for its own processes; not operator knobs.

| Variable | Purpose |
| --- | --- |
| `AI_AGENT` | Clio sets this generic child-process attribution marker to `clio-coder` at both shipped entry points and reinforces it for bash tools, fleet workers, registered code steps, and command hooks. Child tooling may read it to identify the agent that launched it ([index.ts](../../src/cli/index.ts), [entry.ts](../../src/worker/entry.ts), [bash-exec.ts](../../src/core/bash-exec.ts)). |
| `CDPATH` | Removed from bash-tool children, whether inherited or set by the login profile, because it sends a relative `cd` somewhere the command does not name and bash admission judges a `cd` by its text (`src/core/bash-exec.ts`). |
| `CLIO_CODER_GIT_COMMITS_ENABLED` | Carries the effective `integrations.git.commitAttribution` setting to Clio-controlled child-process seams. It is set from validated settings and is not an operator override ([git-commit-attribution.ts](../../src/core/git-commit-attribution.ts)). |
| `CLIO_CODER_COMMIT_ASSISTED`, `CLIO_CODER_COMMIT_AUTHORED`, `CLIO_CODER_COMMIT_DECISIONS` | Per-spawn inputs to the managed `prepare-commit-msg` hook, which also requires `AI_AGENT=clio-coder` and `CLIO_CODER_GIT_COMMITS_ENABLED=1`; normal external shells never receive this set. Only assistance, authorship, and the space-separated decision refs the spawn was made under cross the environment. Testing, review, and receipt trailers are composed in process by the fleet seam, so a child shell cannot forge them by exporting a variable (`src/core/git-commit-attribution.ts`). |
| `CLIO_CODER_GIT_CONFIG_BASE_COUNT`, `CLIO_CODER_GIT_DEFAULT_HOOKS_EQUIVALENT` | Bookkeeping that lets each managed hook wrapper remove only Clio's command-scope `core.hooksPath` pair before chaining the repository's own hook of the same name. Existing `GIT_CONFIG_COUNT` entries remain in force; an explicit `core.hooksPath` is treated as composable only when it resolves exactly to the repository's default hooks directory (`src/core/git-commit-attribution.ts`). |
| `CLIO_CODER_INTERACTIVE` | Marks the interactive TUI process; scrubbed from bash-tool children so nested invocations do not inherit it ([clio.ts](../../src/cli/clio.ts), `src/core/bash-exec.ts`). |
| `CLIO_CODER_RUN_OVERRIDES` | JSON envelope for run-scoped CLI options (`--max-context-tokens`, sampling flags). One typed variable instead of one env var per option; worker subprocesses inherit it ([run-overrides.ts](../../src/core/run-overrides.ts)). |
| `CLIO_CODER_YAZI_PICK_TOKEN` | Per-session token the yazi file-pane integration hands its yazi child and expects back on a pick, so a pick from another session is ignored ([session.ts](../../src/domains/mux/yazi/session.ts), [profile.ts](../../src/domains/mux/yazi/profile.ts)). |
| `CLIO_CODER_WORKER_LABELS` | Comma-separated labels a dispatched worker reports as its own ([transport.ts](../../src/domains/dispatch/transport.ts), `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_PGID` | Process-group id the transport assigns a worker so its whole tree can be signalled (`src/domains/dispatch/transport.ts`, `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_RUN` | Marks a dispatched worker process; a skill install run inside it is stamped `installed-by: worker` (`src/worker/entry.ts`, [install.ts](../../src/domains/resources/skills/install.ts)). |
| `CLIO_CODER_INJECTED_COMPILE_CACHE` | Marks a `NODE_COMPILE_CACHE` value Clio injected into a native worker's environment so its module graph compiles from Clio's V8 compile cache. The worker entry consumes the pair from its own environment immediately after Node reads it, so no worker child of any kind inherits it, and the spawn path never lets the marker travel beside an operator-supplied `NODE_COMPILE_CACHE` ([compile-cache.ts](../../src/core/compile-cache.ts), [worker-spawn.ts](../../src/domains/dispatch/worker-spawn.ts), `src/worker/entry.ts`). |

## Test-only

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | Fake worker model for tests ([ai.ts](../../src/engine/ai.ts)). |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | Test guardrail: abort if resolved directories escape `CLIO_CODER_HOME` ([init.ts](../../src/core/init.ts)). |

Variables used only by external benchmark harnesses or install scripts are not
part of the shipped runtime and should be documented with those harnesses.
