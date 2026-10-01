# Configuration, Targets, Runtimes, and Auth

Use this guide to connect a provider and choose where chat and workers run. Exact settings and runtime contracts live in source: [settings](../../src/core/defaults.ts), [validation](../../src/core/config.ts), [target descriptors](../../src/domains/providers/types/target-descriptor.ts), and the [runtime registry](../../src/domains/providers/runtimes/builtins.ts).

## Start here

| Task | Entry point |
| --- | --- |
| Connect a model | [First-run flow](#first-run-flow), or `clio-coder configure --quick` when you already know the endpoint |
| Edit saved settings | `clio-coder configure --settings` or TUI `/settings` (alias `/config`) |
| Inspect or probe targets | `clio-coder targets` |
| Check a model list | `clio-coder models --target <id>` |
| Find exact keys, flags, and project file owners | [Configuration reference](configuration-reference.md) |
| Troubleshoot startup and provider errors | [Troubleshooting checklist](#troubleshooting-checklist) |

## Directory locations

`clio-coder paths --json` prints the resolved config, data, state, and cache directories. `CLIO_CODER_HOME` sets a shared root; `CLIO_CODER_CONFIG_DIR`, `CLIO_CODER_DATA_DIR`, `CLIO_CODER_STATE_DIR`, and `CLIO_CODER_CACHE_DIR` override individual roots. See the [environment reference](environment-variables.md) and [directory resolver](../../src/core/xdg.ts).

User settings are stored at `<configDir>/settings.yaml`. Project layers are `.clio-coder/settings.yaml` and `.clio-coder/settings.local.yaml`. Later layers win: built-in defaults, then the user file, then the project file, then the local file, then CLI flags.

## First-run flow

For terminal setup, run `clio-coder configure` or start `clio-coder` without a chat target. For browser setup, run `clio-coder gui --open` and use **Guided setup** on the home page; a prior configure run is optional. Both presentations run the same connection wizard. Choose **Guided setup** and then the source you recognize: an app on this computer, a model server, an AI subscription, or a provider account/API. Clio chooses a unique internal connection id, fills known local addresses, and lists the relevant providers. An installed coding agent is a separate worker-only choice when adding another connection.

1. Choose the provider or app. Provide a key or complete browser sign-in only when required.
2. Confirm the server address when that provider has one. Clio performs a passive reachability and model-catalog probe when the runtime supports it; this sends no generation request.
3. Select a model from the live or clearly labeled catalog/cache list. If a discoverable endpoint returns no models, the normal path is to start the server or load a model and choose **Check again**. Typing an unverified wire id is an explicitly advanced fallback.
4. Review the evidence. The screen distinguishes reachable, live model discovery, catalog/cache fallback, and facts not checked. The compact summary keeps Save, Back, and Cancel visible on a short terminal. **Connection and machine details** shows usable CPUs, available memory, and automatic local-worker sizing. Clio states that GPU/VRAM, model fit, answer quality, and tool use were not tested.
5. Save. The first connection becomes the chat and fleet model; shipped defaults handle the remaining settings.

`clio-coder configure --quick` retains the URL-first shortcut. It identifies compatible local runtimes where possible, requires live model discovery, and is intended for users who already know the endpoint.

For saved defaults use `clio-coder configure --settings`. Each area shows its complete setting catalog in one grouped menu; uncommon controls are not hidden behind a second page. Chat, fleet, and proactive-memory routes select a connection and then offer its discovered/catalog models instead of asking for a handwritten model id. **Use connection default** keeps inheritance, so later changes to that connection’s default also apply to the route. Proactive memory offers **Rules only** to avoid a background model call. Jump to a section with `clio-coder configure --section targets|chat|fleet|context|safety|interface|integrations|advanced`. Runtime IDs available in the installed build come from `clio-coder configure --list`.

## Advanced settings

Configure and GUI Settings use the same eight sections. TUI `/settings` groups its controls into the twelve areas described in [Settings Center](#settings-center). The GUI hides or identifies controls specific to terminal presentation. Configure and GUI sections are:

| Section | Owns |
| --- | --- |
| Connections | Targets, provider credentials, models |
| Chat | Chat route, thinking, output budget, retries |
| Fleet | Worker defaults, profiles, routing, capacity, limits |
| Context & Memory | Working-set eviction, compaction, memory |
| Permissions & Limits | Autonomy, approvals, spending, safety limits |
| Appearance | Output style, terminal mode, streaming, panes |
| Integrations | External agents, project resources, plugins, library, Git |
| Advanced | Diagnostics and validated full-file editor |

Settings YAML paths shown in the inventory below are canonical. Use [Configuration reference](configuration-reference.md) for the full settings-key/default map and the owning code for exact types.

## Strict validation and lifecycle repair

Settings use one strict version-2 schema. Unknown keys and invalid values stop startup with a path-specific diagnostic. Objects merge by key; arrays and scalars replace the lower layer. Project layers are read only after the workspace's project settings are trusted; until then Clio ignores them and prints a notice, and `clio-coder config trust settings` shows the captured files and how to approve exactly those bytes. Credential-bearing keys (`auth`, `apiKey`, `token`, `secret`, `password`) and `safety.autonomy` in project layers are dropped with a diagnostic.

`clio-coder upgrade` runs the registered version-1 migration and preserves the original as `settings.yaml.v1.bak`. `clio-coder doctor --fix` repairs selected installation state. It also rewrites a retired enum value, such as `safety.autonomy: auto-edit`, to the replacement the validation error names, and YAML 1.1 `on`/`off` booleans, preserving comments and formatting. Plain `doctor` lists those repairs without writing them. `doctor --fix` does not run migrations or remove retired keys. See [settings validation and migration](../../src/core/config.ts).

## Live routing vs saved defaults

Saved `chat.*`, `fleet.default.*`, and `context.memory.*` values seed routing at session start. The active interactive session owns its current route. `/model`, `/thinking`, and `/settings` can change that route; choose apply-this-session, save for this project, or save globally where offered. Project saves write `.clio-coder/settings.local.yaml` and require existing project settings to be trusted; Clio approves the exact bytes it writes. A write from another process updates saved defaults but does not redirect a running session. Clio saves a setting by editing the YAML document in place, so a save changes only the keys that changed. Comments, blank lines, quoting (a quoted `'on'` stays quoted), flow style and list indentation elsewhere in the file are kept.

Other settings apply at the boundary shown in the inventory. The routing classifier is in [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts) and [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts).

## Settings Center

Open `/settings` in the TUI, `clio-coder configure --settings`, or Settings in the GUI. The TUI starts with **Recent & Pinned**, **Connections**, **Models & Inference**, **Chat**, **Agents & Delegation**, **Fleet**, **Context & Memory**, **Workspace & Files**, **Permissions & Limits**, **Appearance**, **Integrations**, and **Advanced**, in that order. Configure and GUI use the eight sections listed above. A connection is the provider/app/server entry stored as a `target`; the CLI's `targets` commands and the YAML keys keep that technical name.

Use **Connections → Add a target** to reopen Guided setup inside the TUI. It runs the same setup flow as configure, including model inventories, passive checks, and review before Save. **Chat** selects the connection and model that answer you. **Fleet → Default model** selects the connection, model, and thinking level for delegated work; profiles and agent routes stay in Fleet. Worker approvals and external-agent tool permissions live in **Permissions & Limits**, alongside autonomy and spending/tool limits.

Each section keeps related controls together. Configure combines a route's connection and model into one guided action; the TUI offers separate connection and model pickers in the same group. Select **Use connection default** in a TUI or GUI model picker to clear that route's model override. A blank override in the text fallback has the same meaning; a typed model id is unverified. **Context & Memory → Proactive memory → Memory connection → Rules only** clears the background model route while leaving rules-based memory available when proactive memory is enabled.

In the TUI, use arrows to move, Enter to open, and `/` to filter by name or canonical key. On wide terminals, Tab switches between sections and their controls; narrow terminals show one level at a time. Esc goes back. Previewing a value does not save it. Edits offer this session, this project, global, or cancel when the control supports that scope. Project saves require trusted project settings. Restart-required controls explain that timing before saving; target and profile removal shows affected routes before confirmation.

Configure edits saved global defaults. It does not offer the TUI's session/project scope menu or redirect an already-running chat session. In **Advanced**, the TUI's **Check setup** and **Edit all settings** rows show the terminal commands for diagnostics and the validated file editor.

In the GUI, **Connections → Guided setup** runs the same connection wizard before
or after opening a project. A configured home page goes straight to project
selection; an incomplete saved chat route offers repair. Setup does not send a
generation request. Live, catalog, and cached model evidence retain the wizard's
labels and limitations. Keys are entered in a masked field or supplied through
an existing credential or environment variable; supported subscriptions offer an
explicit browser sign-in link. Setup replies are not stored as conversations or
operation history. OAuth credentials are saved when sign-in succeeds, while
connection settings wait for **Save target**. Adding or editing another connection
preserves explicit chat, fleet, and memory routes. Saved settings in the GUI apply
to new conversations; active conversation model controls have their own scope.
See [the graphical application guide](commands-and-modes.md#graphical-application)
for launch, cancellation, credential storage, and project override behavior.

## Settings inventory

This is the version-2 durable schema shipped in `DEFAULT_SETTINGS`. Validation is strict: a path absent from this inventory is rejected, including a retired version-1 path. `clio-coder upgrade` performs the one-time v1-to-v2 rename before configuration-domain load and keeps the original as the sibling `settings.yaml.v1.bak` backup.

"When it applies" follows the configuration classifier. **Immediately** means a running process observes the value without rebuilding runtime state. **Next turn** and **next dispatch** mean current work finishes on the old value. **Next session** identifies routing defaults copied into session-owned state at launch. **Restart** means process or pane-host setup must be rebuilt.

### Structural and target catalog

| Key | Default | When it applies |
| --- | --- | --- |
| `version` | `2` | restart |
| `turnControl.workflows` | `["orientation", "direction", "ledger-facts", "detached-collection"]` | next turn |
| `turnControl.orientation.maxSplit` | `4` | next turn |
| `turnControl.orientation.maxCostUsdPerTurn` | `null` | next turn |
| `targets` | `[]` | next turn for the catalog; next session for saved routing defaults |

### Chat

| Key | Default | When it applies |
| --- | --- | --- |
| `chat.target` | `null` | next session |
| `chat.model` | `null` | next session |
| `chat.thinkingLevel` | `low` | next session |
| `chat.modelPicker.cycleSet` | `[]` | immediately for this session; next session as the saved default |
| `chat.modelPicker.favorites` | `[]` | immediately |
| `chat.modelPicker.recentLimit` | `12` | immediately |
| `chat.maxOutputTokens` | `0` | next turn |
| `chat.prewarm` | `false` | next turn |
| `chat.retry.enabled` | `true` | next turn |
| `chat.retry.maxRetries` | `3` | next turn |
| `chat.retry.baseDelayMs` | `2000` | next turn |
| `chat.retry.maxDelayMs` | `60000` | next turn |
| `chat.retry.streamStallMs` | `180000` | next turn |
| `chat.retry.firstTokenStallMs` | `600000` | next turn |

### Configure a different model for workers

To configure a different model for workers, open `/settings` and choose
**Fleet**, then set `fleet.default.target` and `fleet.default.model`. For a
saved route, use `clio-coder targets profile` to bind a worker or agent to a
profile. These values affect dispatch as shown in the table below; they do not
change the current chat model. The [fleet dispatch guide](fleet-dispatch.md)
explains worker route selection.

### Fleet

`fleet.rosters.<name>.members` contains two to five members. Each member has a unique `label`, a `target`, and optional `model`, `thinkingLevel`, and `color`. `fleet.agentProfiles` is the persisted agent-id-to-profile map.

| Key | Default | When it applies |
| --- | --- | --- |
| `fleet.default.target` | `null` | next session |
| `fleet.default.model` | `null` | next session |
| `fleet.default.thinkingLevel` | `off` | next session |
| `fleet.profiles` | `{}` | next dispatch |
| `fleet.rosters` | `{}` | next dispatch |
| `fleet.agentProfiles` | `{}` | next dispatch |
| `fleet.speculativeDispatch` | `false` | next turn |
| `fleet.nodes` | `[]` | next dispatch |
| `fleet.adaptiveRouting.roles` | `[]` | next dispatch |
| `fleet.adaptiveRouting.postures` | `[]` | next dispatch |
| `fleet.adaptiveRouting.agentRoles` | `[]` | next dispatch |
| `fleet.permissions.mode` | `deny` | next dispatch |
| `fleet.permissions.escalation.timeoutMs` | `120000` | next dispatch |
| `fleet.permissions.escalation.fallback` | `deny` | next dispatch |
| `fleet.concurrency` | `auto` | restart |
| `fleet.retry.maxRetries` | `2` | next dispatch |
| `fleet.retry.routeCooldownMs` | `15000` | next dispatch |
| `fleet.retry.breakerThreshold` | `1` | next dispatch |
| `fleet.worktrees.root` | `disk` | next dispatch |
| `fleet.limits.toolCallsPerRun` | `150` | next dispatch |
| `fleet.limits.internalRunTimeoutMs` | `900000` | next dispatch |
| `fleet.history.maxRuns` | `1000` | next dispatch |
| `fleet.history.journal` | `true` | next dispatch |

### Context

| Key | Default | When it applies |
| --- | --- | --- |
| `context.toolResultMaxBytes` | `65536` | next turn; a live session change applies to the next tool result |
| `context.workingSet.enabled` | `true` | next turn |
| `context.workingSet.policy` | `structural-v2` | next turn |
| `context.workingSet.profile` | `default` | next turn |
| `context.workingSet.target` | `0.6` | next turn |
| `context.workingSet.protectLastTurns` | `6` | next turn |
| `context.workingSet.protectLastSteps` | `8` | next turn |
| `context.workingSet.minEvictableTokens` | `200` | next turn |
| `context.workingSet.rearmFraction` | `0.1` | next turn |
| `context.compaction.auto` | `true` | next turn |
| `context.compaction.threshold` | `0.8` | next turn |
| `context.compaction.model` | unset | next turn |
| `context.compaction.systemPrompt` | unset | next turn |
| `context.memory.enabled` | `true` | next turn |
| `context.memory.target` | `null` | next turn |
| `context.memory.model` | `null` | next turn |
| `context.memory.cadenceToolCalls` | `10` | next turn |
| `context.memory.trajectorySteps` | `8` | next turn |
| `context.memory.maxOutputTokens` | `2000` | next turn |
| `context.memory.timeoutMs` | `60000` | next turn |

The compaction and memory controls serve different roles. An unset `context.compaction.model` uses active chat; an explicit model must uniquely resolve to an available eligible summary route or fail visibly. `context.compaction.systemPrompt` is a nonempty UTF-8 prompt file, at most 65,536 bytes, read at compaction time and resolved relative to the session workspace.

Configure `context.memory.target` and `context.memory.model` to opt into model-based memory; unset roles remain rules-only. Memory prefers its dedicated route and can use active chat when that route is unavailable and request capacity permits. Known dedicated saturation skips the step rather than initiating failover; neither routing choice edits saved settings.

### System One

`systemOne.engines` maps a name you choose to `{ kind, target, model?, mode? }`, where `kind` is `systemone` or `llm` and `target` is a `targets[].id`. `systemOne.sites` binds a site (`turn`, `toolCall`, `toolResult`, `turnEnd`, `relevance`, `consult`, `drafts`) to an engine name, or to `{ engine, timeoutMs }`. A site with no entry is off. `systemOne.cuts` holds per-build overrides keyed by answering build, then `<site>.<key>`, with values from 0.01 to 0.99. The [System One guide](system-one.md) explains each key, and `systemOne.sites.consult` needs a restart because the `consult` tool is registered at startup.

| Key | Default | When it applies |
| --- | --- | --- |
| `systemOne.engines` | `{}` | next turn |
| `systemOne.sites` | `{}` | next turn; `systemOne.sites.consult` on restart |
| `systemOne.cuts` | `{}` | next turn |
| `systemOne.record` | `false` | next turn |
| `systemOne.retentionDays` | `30` | next turn |
| `systemOne.maxMiB` | `64` | next turn |

### Safety

The safety-limit leaves have no one-process `CLIO_CODER_*` overrides in the current schema. Resolution follows the normal settings stack, from session or project layers where supported through user `settings.yaml`, then the compiled default. `safety.autonomy` is an operator choice: only the user layer and operator session controls can set it.

| Key | Default | When it applies |
| --- | --- | --- |
| `safety.autonomy` | `default` | immediately; user layer or operator session control only |
| `safety.limits.sessionCostUsd` | `5` | next turn |
| `safety.limits.chatToolCallsPerTurn` | `60` | next turn |
| `safety.limits.readBytesPerCall` | `51200` | next turn |
| `safety.limits.observationBytesPerTurn` | `196608` | next turn |
| `safety.review.enabled` | `false` | immediately |
| `safety.review.target` | unset | immediately |
| `safety.review.cadenceToolCalls` | unset | immediately |
| `safety.sandbox` | `auto` | next dispatch; `auto` runs native worker bash, run_script and verify under bubblewrap on Linux when available, or under a `sandbox-exec` seatbelt profile on macOS, whose profile is unverified, `required` refuses those commands without a sandbox, `off` never sandboxes |
| `safety.sandboxNetwork` | `false` | next dispatch; `true` gives sandboxed worker commands network access, which workers holding `web_fetch` already get |

On macOS, `sandbox-exec` provides a seatbelt backend when its probe succeeds. The profile exists but remains unverified on macOS, as the availability check reports. `required` refuses worker commands if the backend is unavailable.

### Interface

| Key | Default | When it applies |
| --- | --- | --- |
| `interface.terminalProgress` | `false` | next turn |
| `interface.demo` | `true` | welcome presentation, attention motion, streaming pacing, tips and footer hints immediately; prompt line next turn |
| `interface.outputDetail` | `standard` | immediately |
| `interface.mode` | `regular` | restart |
| `interface.fullscreenScrollbar` | `auto` | restart |
| `interface.smoothStreaming` | `auto` | immediately |
| `interface.desktopNotifications` | `false` | next turn |
| `interface.panes.enabled` | `off` | restart |
| `interface.panes.notifications` | `failures` | immediately |
| `interface.panes.layout` | `off` | restart |
| `interface.panes.workers.ratio` | `0.34` | immediately on the next workers dock open |
| `interface.panes.files.enabled` | `false` | immediately on the next files-pane open |
| `interface.panes.files.mode` | `companion` | immediately on the next files-pane open |
| `interface.panes.files.profile` | `managed` | immediately on the next files-pane open |
| `interface.panes.files.followCwd` | `true` | immediately on the next files-pane open |
| `interface.panes.files.ratio` | `0.3` | immediately on the next files-pane open |
| `interface.keybindings` | `{}` | immediately |

### Integrations

| Key | Default | When it applies |
| --- | --- | --- |
| `integrations.projectResources.trustProjectImports` | `false` | next turn |
| `integrations.externalAgents.entries` | `[]` | next dispatch |
| `integrations.externalAgents.defaults.connectTimeoutMs` | `30000` | next dispatch |
| `integrations.externalAgents.defaults.turnTimeoutMs` | `0` | next dispatch |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | `120000` | next dispatch |
| `integrations.externalAgents.defaults.toolGovernance` | `clio-coder-policy` | next dispatch |
| `integrations.runtimePlugins` | `[]` | restart |
| `integrations.library.catalog` | `null` | next turn |
| `integrations.library.remote` | `null` | next turn |
| `integrations.library.confirmedRemote` | `null` | next turn |
| `integrations.library.sync` | `false` | next turn |
| `integrations.git.commitAttribution` | `true` | immediately for subsequent commits |

The retired v1-only paths `identity`, `background.thinkingLevel`, `theme`, and `compaction.excludeLastTurns` have no v2 replacement. Fresh v2 files naming them receive targeted removal diagnostics. The v1 migrator drops them with the reason recorded in its migration report; they are tombstones, not executable aliases.

Four version-2 paths are retired the same way. `integrations.externalAgents.entries[].permissionTimeoutMs` did nothing, because a delegated agent's permission ask is decided at once and never waits for the operator; `integrations.externalAgents.defaults.permissionTimeoutMs` still bounds Clio's own ACP server. `integrations.externalAgents.entries[].labels` was never read or displayed. `fleet.decisionProfiles` and `turnControl.interpretation` belonged to the decision layer that System One replaced: bind an engine under `systemOne.engines` and `systemOne.sites` instead, as the [System One guide](system-one.md#migration-from-057) describes. An empty `fleet.decisionProfiles: {}`, which `init` wrote from 0.5.3 through 0.5.7, is accepted silently, and any other use of these two paths is refused. A user `settings.yaml` naming a retired path is refused with a targeted removal message, and a project or local layer drops the leaf with the same diagnostic. The v1 migrator drops the two per-agent keys from moved `delegation.agents` entries and records why.

---

## Configure targets

In the TUI, open `/settings connections` (or `/settings targets`, `/config targets`), choose **Add a target**, or open a connection and choose **Edit URL, runtime and default model**. The configure wizard runs in the composer dock, with the same probing, model validation and review-before-save behavior. Enter advances, Esc goes back, and Ctrl+C cancels target setup. **Save target** writes global target settings and keeps explicit chat, fleet and memory route defaults. Browser sign-in stores credentials immediately; other target settings wait for Save.

Use guided `clio-coder configure` for source-led setup, `clio-coder configure --quick` for the URL-first shortcut, `clio-coder configure --section targets` for the target console, or `clio-coder targets add` for the target wizard. The non-interactive flag surface is documented by `clio-coder configure --help` and implemented in [`src/cli/configure.ts`](../../src/cli/configure.ts).

A target binds an id to a registered runtime, endpoint/auth, model defaults, and optional capability or runtime-specific settings. Example user settings:

    version: 2
    targets:
      - id: lab
        runtime: openai-compat
        url: https://api.example.test/v1
        defaultModel: model-id
        auth:
          apiKeyEnvVar: OPENAI_API_KEY
    chat:
      target: lab

`clio-coder doctor` reports a target whose runtime id is unknown and names a replacement for the retired `lmstudio-native` and `ollama-native` ids. Update that target's `runtime` in `settings.yaml` to `lmstudio` or `ollama`, respectively; `doctor --fix` does not rewrite it.

Keep credentials in user settings or the credential store. Project settings deliberately discard credential-bearing keys.

For ALCF, the `configure` wizard asks for a gateway URL and shows a
Sophia example because the endpoint varies by cluster or resource.
`gatewayUrlGuidance` in [configure-target.ts](../../src/cli/configure-target.ts)
provides that prompt. See the [ALCF provider contract](../architecture/alcf-provider.md#configure)
for the Sophia and Metis URLs and model IDs.

## Target management

| Command | Use |
| --- | --- |
| `clio-coder targets [--json] [--target <id>]` | List configured targets and status, or only one target. |
| `clio-coder targets --probe` | Probe configured endpoints and refresh discovery. With `--target <id>` it probes only that target. |
| `clio-coder targets add` | Run target setup. |
| `clio-coder targets use <id>` | Set the chat target. Optional `--model`, `--orchestrator-model`, `--background-model`, `--fleet-target` and `--fleet-model` also set those routes. |
| `clio-coder targets fleet [--json]` | Show the worker (fleet) routing. Alias `workers`. |
| `clio-coder targets profile <subcommand>` | Use `list`, `set <name> <id> [--model] [--thinking]`, `remove <name> [--force]`, `rename`, `bind <agentId> <profileName>`, `unbind <agentId>`, or `bindings` for worker routes and agent bindings. Alias `worker`. |
| `clio-coder targets remove <id>`, `rename <old> <new>`, `convert <id> --runtime <runtimeId>` | Maintain target entries. |

`targets --probe --reasoning` and `targets --probe --tools` (with optional `--tools-timeout <seconds>`) opt into generating qualification probes; they may load a local model. Use them only when that qualification is intended. Exact accepted flags and restrictions are printed by `clio-coder targets --help`.

## Context-window provenance

Clio keeps the window a route serves apart from the maximum a model declares. The serving window bounds a session. A profile's `claims.modelMaxContext` and a row in Pi's model catalog are model maxima, and neither becomes an inference server's serving window. When a resident model's serving window differs from the target's model maximum, `clio-coder targets` names both, as in `ctx <serving> (serving; model max <maximum>)`.

`targets --json` reports `contextWindowProvenance` for the window of the target's default model, as defined in [`contract.ts`](../../src/domains/providers/contract.ts):

| Value | Meaning |
| --- | --- |
| `configured` | Set by `targets[].capabilities.contextWindow`. |
| `discovered` | Reported by the live endpoint for that exact model id. For `openai-codex` it is the window the Codex backend lists for the model. |
| `catalog` | Taken from Pi's catalog row for the model. It is an estimate, not a server report. |
| `runtime-default` | Nothing answered, so the number is the runtime's placeholder, which the text listing marks `unverified runtime default`. `openai-codex` reports `0` instead until its backend answers. |

A session plans against the serving window resolved on each turn by [`runtime-resolution.ts`](../../src/domains/providers/runtime-resolution.ts). `/context` labels its source as follows ([`context-overlay.ts`](../../src/interactive/context-overlay.ts)), and the footer's context page prints the raw source value:

| `/context` label | Source | Meaning |
| --- | --- | --- |
| `loaded window` | `loaded` | The backend reports the model open at this window. |
| `probed window` | `probe` | The target reported a route or model limit without resident instance state. A llama.cpp slot share shows as `<share> (<total> / <n> slots)`. |
| `configured window` | `target-override` | `targets[].capabilities.contextWindow`, a window sent with every request such as `ollama.numCtx`, or `clio-coder run --max-context-tokens`. A setting can lower a live limit but never raise it. |
| `catalog estimate window` | `catalog` | A cloud route whose runtime has no window endpoint. The window is the model maximum from its profile or Pi's catalog, labeled an estimate. |
| `context window unknown` | `unknown` | No live report or setting answered. |

Older session snapshots can carry `descriptor-default`, which `/context` shows as `assumed`.

Only a cloud route without a window endpoint plans a session against an estimate. Local servers, protocol endpoints such as `openai-compat` and `litellm`, and `openai-codex` before its backend answers have no fallback number. When no probe, loaded state or setting reports their window, it is unknown: `/context` shows `context window unknown` beside the estimated token count, threshold compaction is disabled, and the transcript prints once per target and model `Serving context window is unknown. Probe the target or configure its deployment limit; threshold compaction is disabled until a limit is known.` Run `clio-coder targets --probe`, load the model, or set `targets[].capabilities.contextWindow` to the deployment's limit.

The server stays the authority on its own limit. When it rejects a chat request for exceeding its context window, Clio compacts once and retries the request, whether or not the window or output limit is known ([`turn-recovery.ts`](../../src/interactive/turn-recovery.ts)). A second overflow is reported instead of retried. A worker makes one recovery attempt after a server overflow: it evicts reversible observations from its projected request and retries once when that shrinks the request enough ([`pressure.ts`](../../src/domains/context/worker/pressure.ts)). The worker's initial fork is never trimmed, and the attempt needs `context.compaction.auto` and `context.workingSet.enabled`; otherwise the server's error ends the run.

## Model profiles

The package ships [`models/profiles.yaml`](../../models/profiles.yaml), which describes what each known model is: capability flags, a declared context and output maximum, its thinking mechanism, and a recommended output budget. A profile describes the model, not a deployment, so it cannot set `contextWindow`, `maxTokens`, `reasoningLevels`, `thinkingControlRuntime` or `parallelSlots`; only a live server report supplies those. Loading, matching and validation are in [`model-profiles.ts`](../../src/domains/providers/model-profiles.ts).

A profile's `match` block selects models by id, ignoring case:

- `exactIds` compares the full model id, including a route prefix such as `mini/`.
- `familyPrefixes` compares the model name after its last `/`. A prefix matches that name exactly or when followed by `-`, `_`, `.` or `@`. Prefixes are literal, so `/` and regular-expression characters are rejected.
- `runtimeIds` limits the profile to those runtime ids. A profile without it applies on every runtime.

An exact match beats a prefix match, a longer match beats a shorter one, and a runtime-qualified profile beats an unqualified one. Two profiles still tied after those rules are an error.

Profile claims merge under live reports and target settings ([`capabilities.ts`](../../src/domains/providers/capabilities.ts)):

| Field | Precedence |
| --- | --- |
| `tools`, `vision`, `reasoning` | A live server report decides. A target's `capabilities` value of `false` can lower a reported `true`, but `true` never raises a reported `false`, and Clio notes that the report stands. The profile fills the flag only when the server and the target are both silent. |
| Serving window and output cap | A live limit is the ceiling. `targets[].capabilities.contextWindow` and `maxTokens` can lower it, or stand alone when the server reports none. `claims.modelMaxContext` is never a serving window, and `claims.modelMaxOutput` ranks below server and target limits. |
| Other flags, such as `toolCallFormat`, `thinkingFormat` and `structuredOutputs` | The profile outranks the server's flag list, and a target's `capabilities` outranks the profile. A live report of no audio input still wins. |

When `chat.maxOutputTokens` is `0` and the request sets no limit, the profile's `recommendations.outputTokens` becomes the output budget, clamped to the model's output cap and the remaining window ([`output-budget.ts`](../../src/engine/apis/output-budget.ts)). Sampling presets still come from the [local model catalog](../../src/domains/providers/models/local-models/clio-coder-local-coding-targets.yaml), so a profile's `recommendations.sampling` is not applied.

`behavior.thinking` names the mechanism (`effort-levels`, `budget-tokens`, `on-off`, `always-on` or `none`) and, for `effort-levels`, the effort string each Clio level sends in `effortByLevel`. Beyond `off`, the thinking picker offers only the mapped levels. The ThinkingCap-Qwen3.8-27B (`thinkingcap-qwen3.8-27b`) and Qwopus3.8-27B-Flash-V2 (`qwopus3.8v2-27b-dense`) profiles map levels onto `low`, `medium` and `xhigh`, the only efforts their chat templates accept. A requested `high` or `max` is sent as `xhigh`.

### User override file

`<configDir>/model-profiles.yaml` layers the operator's profiles over the packaged ones. It uses the packaged shape:

    version: 1
    models:
      - id: qwen3.8-27b
        claims:
          capabilities:
            vision: false
      - id: lab-coder
        match:
          familyPrefixes:
            - lab-coder
        claims:
          capabilities:
            tools: true
            toolCallFormat: openai

The first entry adjusts a packaged profile and the second adds one. An entry whose `id` names a packaged profile, ignoring case, merges onto it field by field: nested maps merge, while lists and scalar values replace the packaged value. An entry with a new `id` adds a profile and needs its own `match` with `exactIds` or `familyPrefixes`. An entry may set `id`, `match`, `claims` (`modelMaxContext`, `modelMaxOutput` and `capabilities`), `behavior`, `recommendations` and `provenance`. Capability fields are the booleans `chat`, `tools`, `reasoning`, `vision`, `audio`, `embeddings`, `rerank`, `fim` and `decisions`, and the enums `toolCallFormat`, `thinkingFormat` and `structuredOutputs`. Profile claims still rank below live reports as the table above describes.

A mistake in the override costs the smallest unit, and each is reported as a `[providers:profiles]` diagnostic naming the file and entry:

| Diagnostic | Effect |
| --- | --- |
| `<file> entry '<id>': <field> ignored, <problem>` | An unknown field, a live-only capability, or a wrong value type is dropped. The rest of the entry loads. |
| `<file> entry '<id>' skipped: <reason>` | The entry lacks a trimmed nonempty `id`, repeats an earlier override `id`, or fails validation after merging, for example a new profile without `match` or a prefix that is not literal. |
| `<file> ignored: <reason>` | The file does not parse, lacks `version: 1` and a `models` list, or has another top-level key. The packaged profiles still load. |
| `model profiles disabled: <reason>` | Two profiles claim the same exact id or prefix for the same runtime scope. Every profile is disabled, and Clio runs as if no profile matched. |

Clio reads both files at startup and rereads them whenever the `/model` overlay refreshes targets: when it opens, and on `r` or `R`.

## Target fields

A `targets[]` entry accepts `id` and `runtime` (both required), `url`, `auth`, `defaultModel`, `wireModels`, `capabilities`, `lifecycle`, `gateway`, `pricing`, `cache`, `lmstudio`, `litellm`, `ollama`, `maxConcurrentRequests` and `trustedUnmediated`. Any other key is rejected. When `defaultModel` is omitted, the first `wireModels` entry is used.

`auth` takes `apiKeyEnvVar` (environment variable read per request), `apiKeyRef`, `oauthProfile` and `headers`. `pricing` takes `input` and `output` (both required) plus `cacheRead` and `cacheWrite`. `cache.retention` is `none`, `short` or `long`. `maxConcurrentRequests` is an explicit request-slot limit for the endpoint and overrides live discovery. `lifecycle` is `user-managed` or `clio-coder-managed`; `user-managed` keeps Clio from loading or unloading models on that server. `trustedUnmediated: true` lets a runtime that runs its own tool loop (claude-code, codex-cli, pi-cli, opencode-cli, antigravity) take write-capable dispatch work under its own authority; without it such work is refused, and the opt-in is recorded on the run receipt. Only user settings may set it; a project layer's value is ignored.

## Local model settings

Target-specific options are typed in [`target-descriptor.ts`](../../src/domains/providers/types/target-descriptor.ts). For example, `ollama.numCtx` is sent as the request context and is also the window Clio plans against; changing it can reload a model on a shared Ollama server. Runtime probing and loaded-model state are implemented in [`src/domains/providers/runtimes/local-native/`](../../src/domains/providers/runtimes/local-native/ollama.ts).

### LM Studio load profile

`lmstudio.load` states how Clio loads a model on an LM Studio server, so the server's GUI defaults stop deciding the context window, slot count or speculative draft. `lmstudio.models.<model id>.load` overrides fields for one model; the key is the model id selected on that target. Every field maps to the key LM Studio's `POST /api/v1/models/load` takes: `contextLength`, `parallel`, `flashAttention`, `speculativeDraftMaxTokens`, `evalBatchSize`, `numExperts` and `offloadKvCacheToGpu`. The adapter sends these fields to the load API; configure them for the installed server and model.

    targets:
      - id: blade
        runtime: litellm
        url: http://gateway.example:4000
        lmstudio:
          load:
            contextLength: 131072
            parallel: 4
            flashAttention: true
            speculativeDraftMaxTokens: 2
          models:
            dynamo/qwen3.8-27b:
              load:
                contextLength: 65536

Before a request, Clio loads the model with the profile when it is not resident. When it is resident with a different value for a field the profile sets, for example because another client's just-in-time load took the GUI defaults, Clio unloads that instance and loads it again, then prints one `reloading '<model>' ... to match its load profile` line. A field the loaded instance does not report is never treated as drifted. The profile applies on the next turn after the setting changes.

While another model is resident on the same server, Clio caps a context length it chose, including one inherited from the target-level `lmstudio.load`, at the co-residency ceiling that `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT` sets ([environment reference](environment-variables.md)), and prints `loading '<model>' alongside <models>: context clamped <requested> to <ceiling> tokens`. A `contextLength` set for that model under `lmstudio.models.<model id>.load` is never clamped; Clio loads it and warns that it is above the ceiling. When a drift reload fails, Clio restores the previous instance, plans against the window that instance serves, and does not retry the profile until the instance or the profile changes. If the restore also fails, the error names both failures and the model must be reloaded on the server ([`lmstudio.ts`](../../src/engine/apis/lmstudio.ts)).

It applies to a `lmstudio` target and to a `litellm` target. On a LiteLLM gateway, Clio reads `/v1/model/info` and acts only on a route with exactly one deployment that declares `model_info.runtime: lm-studio`; it loads on that deployment's `api_base` under the upstream model key and still sends the request to the gateway alias. Routes on other runtimes, gateways that hide detail metadata from the key, and targets without a profile stay observe-only, and `lifecycle: user-managed` disables every load and unload. The gateway credential is never sent to the LM Studio server. Loads and reloads are serialized across the orchestrator and its workers by the residency lock.

Clio remembers the LM Studio instances it loads in one state file per server (`lmstudio-ownership/` under the state directory), shared by the orchestrator, its workers and separate runs. Before loading a model under a profile, Clio unloads the instances any Clio process loaded earlier on that server for other models, and prints one `unloading '<model>', which Clio loaded earlier ...` line for each. LM Studio offloads an oversubscribed model to CPU instead of refusing it, so leaving two large models resident degrades both. A model another client loaded is never unloaded. While a Clio process streams on a model it holds a lease on it, so neither another process's load nor a profile reload unloads it mid-request; a lease whose process has exited protects nothing. Back-to-back turns and runs on one model reuse the resident instance. Clio does not unload anything when it exits.

### Per-request options for LM Studio and LiteLLM

`lmstudio.request` accepts `ttlSeconds`, `draftModel` and `reasoning` (`auto`, `off`, `on`, `low`, `medium` or `high`). `litellm.request` accepts `tags` (no commas; Clio always adds `clio-coder`), `sendSessionId` (default true, sent as `x-litellm-session-id`), `timeoutSeconds` and `streamTimeoutSeconds` (0.001 to 86400), and `numRetries` (0 to 100, a router retry count and not a client SDK retry).

Sampling is per request and follows the model catalog; see [model-catalog.md](../architecture/model-catalog.md).

Model-family quirks belong to the local model catalog, not the target descriptor. See [`src/domains/providers/models/local-models/`](../../src/domains/providers/models/local-models/clio-coder-local-coding-targets.yaml) for current entries.

## Model listing and refresh

Use `clio-coder models --target <id>` to inspect configured, discovered, and catalog models. `--json` is available for scripts; `--offline` avoids live refresh; `--target` is the only other flag. The model-list command is implemented in [`src/cli/models.ts`](../../src/cli/models.ts).

## Built-in runtime categories

Runtime IDs and support groups vary by installed build. Use `clio-coder configure --list` for user-facing runtimes and `clio-coder configure --list --all` to include aliases and hidden registrations. Chat targets must resolve to an orchestrator-eligible runtime; worker-only SDK and subprocess runtimes are selected through fleet routes. See [runtime eligibility](../../src/domains/providers/runtime-resolution.ts).

## Auth

| Command | Effect |
| --- | --- |
| `clio-coder auth list` | List runtimes that Clio can authenticate. |
| `clio-coder auth status [target-or-runtime]` | Inspect credential availability and source. |
| `clio-coder auth login [target-or-runtime]` | Sign in or store an API key. |
| `clio-coder auth logout [target-or-runtime]` | Remove stored credentials. |

`auth login` also accepts `--api-key <value>`. Prefer `clio-coder configure --api-key-env <VAR>` (the target's `auth.apiKeyEnvVar`): Clio reads the variable when making a request and stores no key. Stored API keys and OAuth credentials live in `credentials.yaml` in the config directory with mode `0600`, but are plaintext and are not encrypted. The auth CLI and storage are in [`src/cli/auth.ts`](../../src/cli/auth.ts) and [`src/domains/providers/auth/`](../../src/domains/providers/auth/index.ts).

## Subscription-based Targets and Runtimes

OAuth providers, supported worker runtimes, and external-agent delegation have different runtime roles. Check the installed registry with `clio-coder configure --list` and use [Interop](interop.md) for detected coding-agent peers. Runtime descriptors in [`src/domains/providers/runtimes/`](../../src/domains/providers/runtimes/builtins.ts) define their auth method and whether they serve chat or dispatch.

## Troubleshooting checklist

    clio-coder doctor --json
    clio-coder targets --probe
    clio-coder models --target <id>
    clio-coder auth status <target-or-runtime>

For a report, include the Clio and Node versions, target id/runtime, model id, probe result, and a redacted receipt or transcript. Do not include API keys or credential files.

Inception Mercury requests retain the runtime-required `reasoning_effort: "instant"` for both tool probes and chat, including after discovery classifies the model as nonreasoning. Thinking controls supplied by callers are still removed for nonreasoning models.
