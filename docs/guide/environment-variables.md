# Environment Variables

This page inventories Clio-specific runtime and build variables and the ambient variables that materially change documented operator behavior. `settings.yaml` is the durable home for operator policy; environment variables support per-process overrides, directory layout, debugging, credentials, terminal integration, and internal plumbing. When prose and source disagree, prefer the cited read site.

The `environment-variable-inventory` check in [check-hygiene.ts](../../scripts/check-hygiene.ts), run by `pnpm run lint`, enforces coverage for Clio's `CLIO_*` variables and `NO_COLOR`. It intentionally does not treat every operating-system or provider convention as a Clio knob. Examples outside that enforced family include `PATH`, `HOME`, terminal capability variables, and provider API-key names selected dynamically by [env-api-keys.ts](../../src/engine/env-api-keys.ts). The check also runs the other way: every variable this page names in backticks must still be read by Clio's source, so a variable that is removed cannot keep its row. It scans `src/` and `scripts/build-output.ts` only. Variables that only the installers, the package launcher or the graphical application read are listed in [Variables read outside src](#variables-read-outside-src), without backticks for that reason.

## Behavior knobs without a settings key

| Variable | Default | Controls |
| --- | --- | --- |
| `CLIO_CODER_BUILD_VERBOSE` | off | `1` prints complete tsup/Vite build logs and code-map statistics instead of concise stage summaries. Warnings and errors remain visible in either mode ([build-output.ts](../../scripts/build-output.ts)). |
| `NO_COLOR` | unset | Set to any non-empty value to drop every foreground and background color. Terminals declaring `TERM=dumb` or `TERM=unknown` also use color-disabled output. Bold, dim, italic, and underline stay, because they are what is left to read the interface by ([terminal-preferences.ts](../../src/core/terminal-preferences.ts)). |
| `CLIO_CODER_THEME` | unset | `dark` or `light` picks the palette drawn for that terminal background and skips the startup OSC 11 query; `neutral` forces the mid-luminance palette that reads on either. Unset detects the background from the terminal's OSC 11 reply, then `COLORFGBG` ([terminal-background.ts](../../src/core/terminal-background.ts)). |
| `CLIO_CODER_UPDATE_CHECK` | on | `0` disables background update checks, detection of a replaced installation, upgrade hints, and the native installer's background updates, which run only from this monitor. Checks start only in an interactive session, after its first full frame and a five-second delay ([interactive-application.ts](../../src/interactive/interactive-application.ts), [update-check.ts](../../src/domains/lifecycle/update-check.ts)). |
| `NO_UPDATE_NOTIFIER` | unset | Any non-empty value suppresses the update monitor. A non-empty `CI` also suppresses it. Explicit `clio-coder upgrade` still works. |
| `CLIO_CODER_RIGOR` | repo-derived | Finish-contract evidence bar, `normal` or `high`, layered over the repo-derived default ([rigor.ts](../../src/domains/safety/rigor.ts)). |
| `CLIO_CODER_ANTHROPIC_CACHE_RETENTION` | unset | Native engine requests using `anthropic-messages` accept `none`, `short`, or `long`. Long requests ask for a one-hour cache TTL when the model's compatibility metadata supports it. An explicit per-call preference wins; unset preserves SDK defaults, and other APIs are unchanged ([provider-diagnostics.ts](../../src/engine/provider-diagnostics.ts)). |
| `CLIO_CODER_PROVIDER_DUMP_PATH` | unset | Absolute path for opt-in native-provider JSONL diagnostics. One record per completed call contains payloads after caller callbacks and the terminal response. The parent directory must exist; the file must be operator-owned, regular, mode `0600`, and not a symlink. New files use that mode. Auth options and headers are omitted, known provider credentials are redacted, and prompt/message/tool content is retained. Keep this diagnostic private and delete it when finished. Ledger events are unchanged; external CLI transports are not captured. A sink that cannot be written or closed raises a process warning with code `CLIO_CODER_PROVIDER_DUMP_FAILED` and the call still completes (`src/engine/provider-diagnostics.ts`). |
| `CLIO_CODER_FORCE_COMPACT` | off | `1` forces compaction before every interactive turn for as long as it is set ([chat-loop.ts](../../src/interactive/chat-loop.ts)). |
| `CLIO_CODER_LEGACY_MASK` | off | `1` temporarily restores the destructive stale-observation mask before summary compaction; remove it after compatibility diagnosis. |
| `CLIO_CODER_STATUS_STUCK_MS` | 180000 | Stuck-turn watchdog threshold in milliseconds. A value that is not a positive number keeps the default ([watchdog.ts](../../src/interactive/status/watchdog.ts)). |
| `CLIO_CODER_SHUTDOWN_HOOK_MS` | 500 | Wall-clock budget in milliseconds per shutdown hook and per domain stop. A value that is not a positive integer keeps the default ([termination.ts](../../src/core/termination.ts)). |
| `CLIO_CODER_HOOK_BUDGET_MS` | per-phase built-ins | Global middleware hook wall-clock budget ([budget.ts](../../src/domains/middleware/budget.ts)). |
| `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` | per-phase built-ins | Per-phase hook budget, e.g. `CLIO_CODER_HOOK_BUDGET_TURN_END_MS`; beats the global var. |
| `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS` | 1 | Hook calls exempted from budget accounting at startup. |
| `CLIO_CODER_HOOK_BUDGET_WINDOW` | 5 | Sliding-window size for steady-state hook-budget warnings. |
| `CLIO_CODER_HOOK_BUDGET_THRESHOLD` | 3 | Overruns within the window before a steady-state warning. |
| `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT` | 131072 | Largest context length Clio requests when it loads an LM Studio model while another model is resident on the same server. LM Studio reports no VRAM and caps GPU offload instead of refusing an oversized load, so a KV cache that does not fit is served from CPU at a crawl; the ceiling bounds that by evidence. A positive integer sets another ceiling. `off`, `false` or `0` disables clamping. An empty, non-numeric or negative value keeps the default ([lmstudio-residency.ts](../../src/engine/apis/lmstudio-residency.ts)). |
| `CLIO_CODER_SKILL_CATALOG_DIR` | unset | Local skill-catalog directory override ([marketplace.ts](../../src/domains/resources/skills/marketplace.ts)). |
| `CLIO_CODER_SKILL_MARKETPLACE_INDEX` | unset | Skill-marketplace index path override (`src/domains/resources/skills/marketplace.ts`). |
| `CLIO_CODER_MODEL_CATALOG_DIRS` | unset | Extra model-catalog directories, separated by the platform path delimiter (`:` on Linux and macOS) ([knowledge-base-path.ts](../../src/domains/providers/knowledge-base-path.ts)). |
| `CLIO_CODER_ENDPOINT_SLOTS_TTL_MS` | 86400000 | How long a persisted endpoint slot count answers for an endpoint nothing has probed in this process. A record past the bound is ignored and pruned rather than allowed to over-admit ([endpoint-slots-store.ts](../../src/domains/providers/endpoint-slots-store.ts)). |
| `CLIO_CODER_DISABLE_RETRIEVE_TOOLS` | off | `1` strips RETRIEVE tools from registries. Bash, hooks, external CLIs, and provider networking remain available; hermetic runs require OS isolation. Legacy `CLIO_CODER_NO_NETWORK_TOOLS=1` is accepted. |
| `CLIO_CODER_NO_NETWORK_TOOLS` | off | Legacy alias of `CLIO_CODER_DISABLE_RETRIEVE_TOOLS`; disables retrieval tools only, with no shell network isolation. |
| `CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK` | off | `1` permits web_fetch to reach private and local services; operator process setting only, never a tool argument or project setting ([network-policy.ts](../../src/tools/network-policy.ts)). |
| `CLIO_CODER_REDUCE_MOTION` | off | `1` makes smooth-streaming `auto` use the immediate coalescer. Explicit `on` remains an operator request, while stdout backpressure still pauses frame production. |
| `CLIO_CODER_NERD_FONT` | off | `1` opts into Nerd Font brain icons on the thinking rail. Ordinary filled and hollow dots are the default; terminal color capability does not establish font coverage. |
| `CLIO_CODER_SCREEN_READER` | off | `1` uses the compact welcome header and textual thinking effort, disables attention animation, and makes smooth-streaming `auto` use the immediate coalescer. |
| `CLIO_CODER_INSTANT_SHELL` | on | `0` disables the single-owner Stage 0 interactive shell for immediate rollback. Unset or `1` mounts one terminal/editor owner before service hydration; ACP, headless, ordinary non-TTY, and subcommand paths never mount it. An explicit `CLIO_CODER_INTERACTIVE=1` keeps its force-interactive non-TTY behavior. |
| `CLIO_CODER_TRACE_RETENTION_DAYS` | 30 | Maximum age in days for terminal rows in the rebuildable SQLite trace mirror. The value is an integer of at least 1; anything else fails with `CLIO_CODER_TRACE_RETENTION_DAYS must be an integer of at least 1` ([trace-store.ts](../../src/domains/observability/trace-store.ts)). |
| `CLIO_CODER_TRACE_MAX_BYTES` | 134217728 | Maximum allocated size for the SQLite trace mirror before the oldest terminal runs are pruned. The value is an integer of at least 1,048,576; anything else fails with `CLIO_CODER_TRACE_MAX_BYTES must be an integer of at least 1048576` (`src/domains/observability/trace-store.ts`). |

## Directory and install layout

| Variable | Default | Controls |
| --- | --- | --- |
| `CLIO_CODER_HOME` | unset | Single-tree install root; the per-role vars below beat it ([xdg.ts](../../src/core/xdg.ts)). |
| `CLIO_CODER_CLAUDE_SDK_DIR` | unset | Absolute administrator-prepared component prefix containing `node_modules/@anthropic-ai/claude-agent-sdk`. This prefix takes precedence and is never modified. Unset, explicit `clio-coder tools install claude-sdk` provisions the pinned SDK under the per-user data directory, separately from Clio; existing package-local installations remain a fallback. |
| `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, `CLIO_CODER_CACHE_DIR` | XDG platform defaults | Per-role directory overrides (`src/core/xdg.ts`). |
| `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | platform/user defaults | Linux base directories used when the corresponding `CLIO_CODER_*_DIR` and `CLIO_CODER_HOME` variables are unset (`src/core/xdg.ts`). |
| `APPDATA`, `LOCALAPPDATA` | Windows profile defaults | Windows roaming and local base directories used when Clio-specific directory overrides are unset (`src/core/xdg.ts`). |
| `CLIO_CODER_BIN_DIR` | `~/.local/bin` | Directory holding the `clio-coder` launcher. A leading `~` or `~/` expands to the home directory in `install.sh` and `install-local.sh`. The local install script (`scripts/install-local.sh`) and the installers (`scripts/install.sh`, `scripts/install.ps1`) create it there, and `clio-coder uninstall` looks for a source-checkout launcher there. An installer install uses the launcher its record names, and an npm global install uses `bin/` under its prefix ([uninstall.ts](../../src/cli/uninstall.ts)). |
| `CLIO_CODER_NODE_VERSION` | the managed runtime | Node.js version the installers install, a major such as `24` or an exact version. `clio-coder upgrade` sets it to the installed runtime's version so an upgrade keeps that Node, and clears it for `--refresh-runtime` ([upgrade.ts](../../src/cli/upgrade.ts)). The other installer variables are listed in [Installer environment variables](installation-and-lifecycle.md#installer-environment-variables). |
| `CLIO_CODER_AUTO_UPDATE` | the recorded choice | `0` stops background updates of a native installer install: the installers record the opt-out like `--no-auto-update` or `-NoAutoUpdate`, and a running session neither starts nor activates a background update while it is set. Unset keeps the choice recorded in `install.json`; `1` turns them on for an unpinned install like `--auto-update` ([native-update.ts](../../src/domains/lifecycle/native-update.ts), `src/domains/lifecycle/update-check.ts`, [native-install.cjs](../../scripts/native-install.cjs)). |
| `CLIO_CODER_VERSION` | the channel | Clio Coder version the installers install, an exact version such as `0.6.0` or a dist-tag. An exact version pins the install and disables background updates; `latest`, `beta` or `dev` clears a recorded pin. A background update removes it from the installer's environment so an operator's value cannot redirect it (`src/domains/lifecycle/native-update.ts`). |
| `CLIO_CODER_PACKAGE` | unset | Local `npm pack` tarball the installers install instead of the registry package. A package install is pinned, and a background update removes the variable from the installer's environment (`src/domains/lifecycle/native-update.ts`). |
| `CLIO_CODER_PACKAGE_ROOT` | auto-detected | Package root for bundled-asset resolution: the shipped agents, fleets, prompt fragments, model catalog, library and `docs/` that `clio_docs` and the bundled-doc reader search ([package-root.ts](../../src/core/package-root.ts), [docs-engine.ts](../../src/tools/context/docs-engine.ts)). `clio-coder gui` sets it for the graphical server and its background service. |

## Ambient provider, runtime, and terminal inputs

These names follow an upstream or operating-system convention. They are not substitutes for settings keys, but source reads them when the associated integration is used.

| Variable or family | Controls |
| --- | --- |
| Provider credential variables | [env-api-keys.ts](../../src/engine/env-api-keys.ts) maps the selected provider to its conventional key, including `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `AWS_*` Bedrock credentials, and Google Vertex application credentials. `clio-coder auth` remains the preferred managed credential path. |
| `VISUAL`, `EDITOR` | External editor command, with `VISUAL` taking precedence ([external-editor.ts](../../src/core/external-editor.ts)). |
| `TERM`, `COLORTERM`, `COLORFGBG`, `TERM_PROGRAM`, `WT_SESSION` | Terminal capability, color-depth, background, keybinding, and desktop-notification adaptation. These variables describe the terminal rather than Clio policy. |
| `SSH_CONNECTION`, `SSH_TTY`, `TMUX`, `STY` | Remote-session and terminal-multiplexer detection used by the adaptive stream-pacing policy ([stream-pacing-policy.ts](../../src/interactive/stream-pacing-policy.ts)). |
| `COLUMNS` | Fallback text width for non-TTY CLI output ([text-layout.ts](../../src/cli/text-layout.ts)). |
| `VIRTUAL_ENV` | Python interpreter for typed Python verify entries when the project has neither a uv lock nor a `.venv`: Clio uses `$VIRTUAL_ENV/bin/python` (`Scripts/python.exe` on Windows) before looking for `python` or `python3` on `PATH` ([toolchain.ts](../../src/tools/verify/toolchain.ts)). |
| `TZ` | Local timestamp formatting and daily audit-log date boundaries ([format-time.ts](../../src/interactive/format-time.ts), [audit.ts](../../src/domains/safety/audit.ts)). |
| `CI` | CI-sensitive presentation behavior. It grants no tool authority. |
| `ZELLIJ` | Zellij detection. Like `TMUX`, `STY`, or a `tmux` or `screen` terminal type, it marks a multiplexed terminal, where Clio restores mouse tracking after a text selection without any-motion reporting ([instrumented-tui.ts](../../src/engine/instrumented-tui.ts)). |
| `SHELL`, `ComSpec` | The shell that runs the external editor command and a stored API key written as a `!command`. Unset falls back to `/bin/sh`; on Windows the stored-key command runs under `ComSpec`, default `cmd.exe` ([external-editor.ts](../../src/core/external-editor.ts), [resolve-config-value.ts](../../src/core/resolve-config-value.ts)). |
| `OLLAMA_API_KEY` | Bearer token for an Ollama target whose URL is `https://ollama.com`, sent only when the request carries no `authorization` header of its own. Clio reads it directly in [ollama-http.ts](../../src/engine/apis/ollama-http.ts), not through the `env-api-keys.ts` mapping above. |
| `HERDR_ENV`, `HERDR_SOCKET_PATH`, `HERDR_SESSION`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `HERDR_PANE_ID` | herdr pane-host detection. Guest panes need `HERDR_ENV=1`, which herdr sets in every pane it opens; unless it is `1`, Clio opens no socket. `HERDR_SOCKET_PATH` names the socket, and `HERDR_SESSION` selects `sessions/<name>/herdr.sock` under herdr's config directory. The workspace, tab, and pane ids locate Clio's own pane: docks split from it, and only panes in its workspace are adopted ([detect.ts](../../src/domains/mux/detect.ts)). See [Panes and the Files Pane](panes-and-files.md). |
| `USER`, `LOGNAME`, `USERNAME` | Fallbacks, in that order, for the local account name when the operating-system lookup returns nothing. The account and host name are stamped into run receipts and stated in the session prompt's workspace section as execution-environment facts (`src/domains/dispatch/run-identity.ts`). |
| `XDG_RUNTIME_DIR` | Second tmpfs candidate, after `/dev/shm`, for task worktrees when `fleet.worktrees.root` is `tmpfs` or `auto`. It is used only when it is an absolute path ([worktree-root.ts](../../src/tools/worktree-root.ts)). See [Fleet dispatch](fleet-dispatch.md). |
| `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `ANTIGRAVITY_HOME`, `COPILOT_HOME`, `OPENCODE_CONFIG_DIR` | Home directory of each coding agent that interop inventories, in place of its default under your home directory ([registry.ts](../../src/domains/interop/registry.ts)). `CODEX_HOME` also locates Codex's `auth.json` for the quota reader and is passed to a Codex peer. See [Coding Agent Interoperability](interop.md). |
| `OPENCODE_CONFIG` | OpenCode's own config file. When Clio runs the OpenCode CLI as a peer, it reads this file and `opencode.json` or `opencode.jsonc` under `OPENCODE_CONFIG_DIR` for `{env:NAME}` API-key references, and forwards only those named variables to the child ([opencode.ts](../../src/engine/external-cli/opencode.ts)). |
| `NODE_COMPILE_CACHE`, `NODE_DISABLE_COMPILE_CACHE` | Node's own compile-cache controls, which beat Clio's. Any `NODE_DISABLE_COMPILE_CACHE` value turns Clio's V8 compile cache off, and a set `NODE_COMPILE_CACHE` replaces Clio's cache directory with the one it names. When either is set, workers inherit it unchanged and Clio injects no cache of her own ([compile-cache.ts](../../src/core/compile-cache.ts)). |
| `NODE_OPTIONS` | Read only for `--trace-warnings`. Clio drops Node's experimental warning for the SQLite trace mirror unless warning tracing is requested there or in Node's own flags ([trace-store.ts](../../src/domains/observability/trace-store.ts)). |

## Debug and trace toggles

All default off; enable with `1`.

| Variable | Controls |
| --- | --- |
| `CLIO_CODER_BUS_TRACE` | Event-bus channel tracing to stderr ([bus-trace.ts](../../src/core/bus-trace.ts)). |
| `CLIO_CODER_PROFILE_COMPARE` | Prints each configured route that matches no entry in `models/profiles.yaml`, or whose profile differs from the legacy catalog, once per process ([extension.ts](../../src/domains/providers/extension.ts)). |
| `CLIO_CODER_TRACE_BOOT` | Boot-phase timing trace ([boot-trace.ts](../../src/core/boot-trace.ts)). |
| `CLIO_CODER_TIMING` | Startup timing report, printed only on the bannered non-interactive boot ([orchestrator.ts](../../src/entry/orchestrator.ts)). |
| `CLIO_CODER_DEBUG_SHUTDOWN` | Shutdown-path diagnostics ([termination.ts](../../src/core/termination.ts)). |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | Per-overrun hook-budget diagnostics ([runtime.ts](../../src/domains/middleware/runtime.ts)). |

### File-writing traces

These two take a path, not `1`. Setting either to `1` writes a file named `1` in the working directory. Both are off when unset or empty, and both create parent directories.

| Variable | Contents | Controls |
| --- | --- | --- |
| `CLIO_CODER_RENDER_TRACE` | timing only | Versioned JSONL for the full interactive render pipeline, truncated on open so one file is one session. Records event/input sequence ranges, queue and panel high-water marks, explicit frames, grouped stdout commits, write return values, backpressure, and drain, but no conversation text. Output is bounded and asynchronous after the initial pre-TUI file open; trace failure is nonfatal. See [Observability](../architecture/observability.md) for endpoint definitions ([render-trace.ts](../../src/interactive/render-trace.ts)). |
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
| `CLIO_CODER_BACKGROUND_UPDATE`, `CLIO_CODER_BACKGROUND_CURRENT` | Set by an interactive session on the installer it runs for a native background update: the first marks the run as a background update, the second names the package prefix that was current when it started. The installer's activation step refuses the candidate if that prefix changed or the install was pinned, opted out, or moved to another channel meanwhile, so an update cannot overwrite a concurrent operator choice (`src/domains/lifecycle/native-update.ts`, `scripts/native-install.cjs`). |
| `CLIO_CODER_LAUNCHER_PID` | Set by the native installer's launcher on the CLI process it starts. `clio-coder uninstall` uses it so that its own launcher does not count as another running session (`scripts/native-install.cjs`, `src/cli/uninstall.ts`). |
| `CLIO_CODER_MANAGER_UNINSTALL` | `1` makes a WinGet-managed native install read as a plain installer install, so a package manager's uninstall handoff can run Clio's own removal instead of being sent back to the manager ([install-method.ts](../../src/domains/lifecycle/install-method.ts)). |
| `CLIO_CODER_PATH_REFRESH` | Windows only. A user-scope variable that the installer and the uninstaller write as null after they change the user `PATH`, because setting any user variable broadcasts the environment change to running terminals. Clio never reads its value ([uninstall.ts](../../src/cli/uninstall.ts)). |
| `CLIO_CODER_INTERACTIVE` | `1` selects the interactive TUI boot. A bare `clio-coder` sets it to `1` itself when stdin is a terminal and the variable is unset; with stdin not a terminal and the variable unset, the boot prints the banner, `(non-interactive boot. pass CLIO_CODER_INTERACTIVE=1 to launch the TUI.)` and exits 0. While it is `1`, startup hints, dispatch ledger recovery lines and delegated ACP child stderr are not written to stderr. Scrubbed from bash-tool children so nested invocations do not inherit it ([clio.ts](../../src/cli/clio.ts), [orchestrator.ts](../../src/entry/orchestrator.ts), `src/core/bash-exec.ts`). |
| `CLIO_CODER_RUN_OVERRIDES` | JSON envelope for run-scoped CLI options (`--max-context-tokens`, sampling flags). One typed variable instead of one env var per option; worker subprocesses inherit it ([run-overrides.ts](../../src/core/run-overrides.ts)). |
| `CLIO_CODER_YAZI_PICK_TOKEN` | Per-session token the yazi file-pane integration hands its yazi child and expects back on a pick, so a pick from another session is ignored ([session.ts](../../src/domains/mux/yazi/session.ts), [profile.ts](../../src/domains/mux/yazi/profile.ts)). |
| `CLIO_CODER_WORKER_LABELS` | Comma-separated labels of the SSH node a remote worker runs on, which the worker reports as its own ([transport.ts](../../src/domains/dispatch/transport.ts), `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_PGID` | Process-group id a remote SSH worker announces, set to the login shell's pid so an abort can signal the whole remote tree. A local worker announces its own pid (`src/domains/dispatch/transport.ts`, `src/worker/entry.ts`). |
| `CLIO_CODER_WORKER_RUN` | Marks a dispatched worker process; a skill install run inside it is stamped `installed-by: worker` (`src/worker/entry.ts`, [install.ts](../../src/domains/resources/skills/install.ts)). |
| `CLIO_CODER_INJECTED_COMPILE_CACHE` | Marks a `NODE_COMPILE_CACHE` value Clio injected into a native worker's environment so its module graph compiles from Clio's V8 compile cache. The worker entry consumes the pair from its own environment immediately after Node reads it, so no worker child of any kind inherits it, and the spawn path never lets the marker travel beside an operator-supplied `NODE_COMPILE_CACHE` ([compile-cache.ts](../../src/core/compile-cache.ts), [worker-spawn.ts](../../src/domains/dispatch/worker-spawn.ts), `src/worker/entry.ts`). |

## Variables read outside src

These names are read by the installers, the package launcher, the graphical application or maintainer scripts. They are written without backticks because the inventory check scans `src/` only and would reject a backticked name it cannot find there.

| Name | Read by | Controls |
| --- | --- | --- |
| CLIO_CODER_NODE | [clio-coder.cjs](../../bin/clio-coder.cjs) | Path to a Node.js 22.19 or newer binary. When it differs from the running Node, the package's `clio-coder` command reruns itself under it before loading anything else. See [HPC clusters](hpc-clusters.md#using-a-node-you-already-have). |
| CLIO_CODER_NODE_GUARD | [clio-coder.cjs](../../bin/clio-coder.cjs) | Marker the launcher sets on that rerun so it cannot repeat. Do not set it. |
| CLIO_CODER_CHANNEL, CLIO_CODER_NODE_TARBALL, CLIO_CODER_NODE_SHASUMS, CLIO_CODER_NODE_MIRROR, CLIO_CODER_NODE_UNOFFICIAL_MIRROR, CLIO_CODER_NODE_KEYRING, CLIO_CODER_NODE_BUILD, CLIO_CODER_REQUIRE_SIGNATURE, CLIO_CODER_INSTALL_DIR, CLIO_CODER_MODIFY_PATH, CLIO_CODER_INSTALL_ALLOW_SUDO | [install.sh](../../scripts/install.sh), [install.ps1](../../scripts/install.ps1) | Installer inputs, each with a flag or a default. The table in [Installer environment variables](installation-and-lifecycle.md#installer-environment-variables) says which installer reads which. |
| CLIO_CODER_INSTALL_GUI | [install.sh](../../scripts/install.sh) | `1` installs the desktop app without asking, `0` skips it, and unset asks on a terminal. Any other value stops the run with `CLIO_CODER_INSTALL_GUI must be 1 or 0, got '<value>'`. `install.ps1` does not read it. |
| CLIO_CODER_INSTALL_MANAGER | [native-install.cjs](../../scripts/native-install.cjs) | Names the package manager (for example `winget`) that wraps the install. It is recorded as `manager` in the installer manifest and changes how `upgrade` and `uninstall` treat that install. |
| CLIO_CODER_BOOTSTRAP_FILE, CLIO_CODER_BOOTSTRAP_EXIT, CLIO_CODER_LAUNCHER_CP, CLIO_CODER_LAUNCHER_EXIT | [install.cmd](../../scripts/install.cmd), [native-install.cjs](../../scripts/native-install.cjs) | Internal plumbing of the Windows bootstrap and the `.cmd` launcher: the downloaded script path, the exit status to forward, and the console code page to restore. |
| CLIO_CODER_WEB_CLI | [process-policy.ts](../../apps/clio-coder-gui/server/process-policy.ts) | Absolute path of the Clio CLI file the graphical server starts for its ACP child. Unset, it uses the checkout's `dist/cli/index.js`, then `clio-coder` on `PATH`. See [the graphical application](gui.md). |
| CLIO_CODER_REAL_SYSTEMD | [process-policy.ts](../../apps/clio-coder-gui/server/process-policy.ts) | `1` lets the background-service installer enable a systemd unit whose file sits in a temporary directory. Without it that request is refused, so a test fixture cannot leave login units pointing at deleted paths. |
| CLIO_CODER_RELEASE_TARBALL | [release-candidate.mjs](../../scripts/release-candidate.mjs) | Absolute path of the packed tarball that `pnpm run test:package` installs. |
| CLIO_CODER_RELEASE_CONTEXT | [check-release.mjs](../../scripts/check-release.mjs) | `publish` marks the run as an immutable release, so the changelog must carry the dated version heading. |

The graphical application's tests also read CLIO_CODER_WEB_COMMAND_LOG, CLIO_CODER_WEB_COMMAND_SCENARIO, CLIO_CODER_WEB_FIXTURE_LOG, CLIO_CODER_WEB_FIXTURE_SCENARIO, CLIO_CODER_WEB_FIXTURE_ROUTE, CLIO_CODER_WEB_FIXTURE_PROMPT_TURNS, CLIO_CODER_WEB_FIXTURE_LIBRARY_RELOAD and CLIO_CODER_TEST_OPENAI_KEY. They select fixture behavior and do nothing in a shipped build.

## Test-only

| Variable | Purpose |
| --- | --- |
| `CLIO_CODER_WORKER_FAUX` (+ `_MODEL`, `_TEXT`, `_STOP_REASON`, `_ERROR_MESSAGE`) | Fake worker model for tests ([ai.ts](../../src/engine/ai.ts)). |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | Test guardrail: abort if resolved directories escape `CLIO_CODER_HOME` ([init.ts](../../src/core/init.ts)). |

At the default Clio directories, authenticated sibling CLIs remain connected accounts even without a Clio target. When any resolved Clio directory differs from its platform/XDG default, sibling quota adapters are excluded unless their own home is explicitly set: `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude Code, or `ANTIGRAVITY_HOME` for agy. Those directories contain `auth.json`, `.credentials.json`, and `antigravity-oauth-token`, respectively. Excluded adapters read no credentials, make no requests, and display no cached account rows. Clio-owned Anthropic Max credentials remain available in relocated homes.
