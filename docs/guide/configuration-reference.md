# Configuration reference

The [model catalog contract](../architecture/model-catalog.md) explains how live discovery, model profiles and catalog settings interact.

This page is a map to the implemented configuration surface. Source defines the complete key, flag, and argument contracts; use the linked files when exact schemas or defaults matter. For setup choices, see [Configuration and targets](configuration-and-targets.md). For `CLIO_*` variables, see the [environment variable reference](environment-variables.md).

## Settings keys

The visible settings hierarchy is shared by `clio-coder configure --settings` and TUI `/settings`: **Connections → Chat → Fleet → Context & Memory → Permissions & Limits → Appearance → Integrations → Advanced**. Names describe what the settings change; YAML paths remain the version-2 schema below. For example, Connections manages `targets`, Appearance manages `interface.*`, and Permissions & Limits includes `fleet.permissions.*` and external-agent tool governance. See the [Settings Center walkthrough](configuration-and-targets.md#settings-center) for navigation, model inheritance, and save scopes.

Section names and ownership come from [`settings-navigation.ts`](../../src/core/settings-navigation.ts). Control labels, descriptions, and ordering come from [`settings-controls.ts`](../../src/core/settings-controls.ts). UI adapters should consume these catalogs instead of deriving headings from schema roots or maintaining a separate list of names.

Settings use one strict version-2 schema. Unknown keys and invalid values are errors; omitted keys take compiled defaults. Objects merge by key, while arrays and scalar values replace the lower layer.

The table lists every leaf in `DEFAULT_SETTINGS` in schema order, with its compiled default, the accepted values, and when a change takes effect. Types, validation and optional schema fields live in [`src/core/defaults.ts`](../../src/core/defaults.ts) and [`src/core/config.ts`](../../src/core/config.ts).

### Effect timing

[`settingsChangeKind`](../../src/domains/config/classify.ts) sorts every settings path into one of three buckets. Settings editors, the file watcher and `configure_clio` all read the same classifier.

| Effect | Meaning |
| --- | --- |
| hot reload | A live reader observes the value without rebuilding runtime state. |
| next turn | The next request, dispatch, or explicit open observes the value. Work already running keeps the value it started with. |
| restart required | Process or pane-host setup must be rebuilt, so the value applies to a new Clio Coder session. A path the classifier does not list falls here. |

Routing defaults are a separate rule. `chat.target`, `chat.model`, `chat.thinkingLevel`, `chat.modelPicker.cycleSet`, `fleet.default.target`, `.model` and `.thinkingLevel`, and `context.memory.target` and `.model` seed a session's own routing when it starts. A memory route with both unset is not a seed: it follows the live chat route. A later write from another process updates the saved default but never redirects a running session; see [live routing vs saved defaults](configuration-and-targets.md#live-routing-vs-saved-defaults).

### Chat settings

Default chat settings control interactive conversation routing, reasoning effort, token output budgets, and prefix prewarming:
- `chat.target`: default chat target id (`null`).
- `chat.model`: default chat model id (`null`).
- `chat.thinkingLevel`: default reasoning effort for the chat model (`"low"`; clamped to supported provider levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- `chat.prewarm`: whether prompt-prefix prewarming runs on session start (`false`). When enabled, prewarming prefills the prompt prefix before the first turn, and again after a resume or a compaction settles. It runs against `local-native` runtimes and against a `litellm` target that binds `cache.deployment`; every other tier is skipped whatever this setting says. Dispatched workers and headless runs do not prewarm.
- `chat.maxOutputTokens`: per-turn output token limit (`0`, meaning each model's own cap and its profile's recommended output budget).
- `chat.retry.*`: retry backoff (`baseDelayMs: 2000`, `maxDelayMs: 60000`), attempt limit (`maxRetries: 3`), and stream stall timeouts (`streamStallMs: 180000`, `firstTokenStallMs: 600000`).

| Key | Default | Accepted values and meaning | Effect |
| --- | --- | --- | --- |
| `version` | `2` | Schema version. Any other value fails validation and points at `clio-coder upgrade`. | restart required |
| `turnControl.workflows` | `["orientation", "direction", "ledger-facts", "detached-collection"]` | Subset of those four names: which pre-answer workflows the turn controller may run. `orientation` and `direction` need a fitted System One `turn` site, which is experimental. | next turn |
| `turnControl.orientation.maxSplit` | `4` | Integer 1 to 4. Most read-only scouts started to tour a project before answering. | next turn |
| `turnControl.orientation.maxCostUsdPerTurn` | `null` | Number or `null`. USD ceiling for the scouts started before one answer; `null` sets no per-turn ceiling and a scout split is sized against `safety.limits.sessionCostUsd`, where a session ceiling of 0 gives the split a ceiling of 0 that enforces nothing. | next turn |
| `targets` | `[]` | List of target entries with unique ids. Fields are in [target fields](configuration-and-targets.md#target-fields). | next turn |
| `chat.target` | `null` | Target id that answers chat. An id that is not in `targets` normalizes to `null`. | next turn |
| `chat.model` | `null` | Wire model id. With a target set, `null` resolves to that target's `defaultModel`; with no target it is `null`. | next turn |
| `chat.thinkingLevel` | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. | next turn |
| `chat.modelPicker.cycleSet` | `[]` | `target/model` refs the quick-switch key cycles. | hot reload |
| `chat.modelPicker.favorites` | `[]` | `target/model` refs pinned in `/model`. A ref that does not name an existing target is dropped. | hot reload |
| `chat.modelPicker.recentLimit` | `12` | Integer at least 1. Recently used refs `/model` keeps. | hot reload |
| `chat.maxOutputTokens` | `0` | Integer at least 0. Output tokens requested per turn on every target, clamped to the model's output cap and the remaining window. `0` leaves the budget to the model cap and the profile's recommendation. | next turn |
| `chat.prewarm` | `false` | Boolean. See above. | next turn |
| `chat.retry.enabled` | `true` | Boolean. Retry transient provider errors. | next turn |
| `chat.retry.maxRetries` | `3` | Integer at least 0. Attempts after the first failure. | next turn |
| `chat.retry.baseDelayMs` | `2000` | Integer at least 0. First retry delay. | next turn |
| `chat.retry.maxDelayMs` | `60000` | Integer at least 0. Longest retry delay. | next turn |
| `chat.retry.streamStallMs` | `180000` | Integer at least 0. Silence mid-stream past this many ms aborts the call and retries. | next turn |
| `chat.retry.firstTokenStallMs` | `600000` | Integer at least 0. Silence allowed before the first token; `0` never aborts a call that has not started streaming. | next turn |
| `chat.steering.triage.enabled` | `false` | Boolean, experimental. A side model reads queued steering messages once the queue settles: an unrelated task waits for the end of the turn and a confident stop may interrupt the run. | next turn |
| `chat.steering.triage.target` | `null` | Target id for the triage round; `null` uses the session's active target. | next turn |
| `chat.steering.triage.model` | `null` | Wire model id on that target; cleared when `target` is `null`. | next turn |
| `chat.steering.triage.minQueued` | `2` | Integer at least 1. Queue length that starts a round. | next turn |
| `chat.steering.triage.timeoutMs` | `8000` | Integer at least 1. A slower round is dropped and the queue stays as it was. | next turn |
| `chat.steering.triage.autoInterrupt` | `true` | Boolean. Let a confident `stop` reading cancel the run and deliver that message now. | next turn |
| `fleet.defaultNode` | `null` | `null`, `local`, or a `fleet.nodes[].id`. Standing placement preference for unpinned work; explicit and profile pins win. | next turn |
| `fleet.default.target` | `null` | Target id for delegated fleet work. | next turn |
| `fleet.default.model` | `null` | Wire model id. With a target set, `null` resolves to that target's `defaultModel`. | next turn |
| `fleet.default.thinkingLevel` | `"off"` | Same levels as `chat.thinkingLevel`. | next turn |
| `fleet.profiles` | `{}` | Map of profile name to `{ target, model, thinkingLevel, node? }`. | next turn |
| `fleet.rosters` | `{}` | Map of roster name to `members`, two to five entries of `{ label, target, model?, thinkingLevel?, color? }` with unique labels matching `[a-z][a-z0-9_-]{0,31}`. | next turn |
| `fleet.agentProfiles` | `{}` | Map of native agent id to a `fleet.profiles` name. | next turn |
| `fleet.speculativeDispatch` | `false` | Boolean, experimental. A fitted System One `turn` reading may start the worker a dispatch is predicted to name and hold it. | next turn |
| `fleet.nodes` | `[]` | List of SSH nodes: `id` (not `local`), `host`, `user?`, `port?`, `identityFile?`, `clioCoderEntry?`, `clioCoderVersionCommand?`, `labels?`, `maxWorkers` (default 2), `residency?` (`observe` or `manage`). | next turn |
| `fleet.adaptiveRouting.roles` | `[]` | Subset of `researcher`, `verifier`, `reviewer`, `judge`. | next turn |
| `fleet.adaptiveRouting.postures` | `[]` | Subset of `quality`, `balanced`, `latency`, `economy`. | next turn |
| `fleet.adaptiveRouting.agentRoles` | `[]` | Exact `{ agentId, executionRole }` pairs, with `executionRole` one of `builder`, `researcher`, `verifier`, `reviewer`, `judge`. | next turn |
| `fleet.permissions.mode` | `"deny"` | What a worker's permission ask does: `deny` returns a structured denial and the run continues, `fail` ends the run as `permission_required`, `escalate` asks the interactive operator and applies the fallback on timeout, `main` is the opt-in for the main agent to decide asks through its grant broker. It reaches native local workers only, and a dispatch that cannot carry a bound grant is refused at admission. | next turn |
| `fleet.permissions.escalation.timeoutMs` | `120000` | Integer at least 1. How long an escalated ask waits. | next turn |
| `fleet.permissions.escalation.fallback` | `"deny"` | `deny` or `fail`, applied when the wait expires or nobody is attached. | next turn |
| `fleet.concurrency` | `"auto"` | `auto` or an integer at least 1. `auto` derives a limit from CPU and memory, up to eight workers. | restart required |
| `fleet.worktrees.root` | `"disk"` | `disk`, `tmpfs`, `auto` (tmpfs when one exists and has room), or an absolute path. Where a `worktree: true` task's working tree is created for local placement. | next turn |
| `fleet.retry.maxRetries` | `2` | Integer at least 0. Automatic retries of a retryable worker outcome. | next turn |
| `fleet.retry.routeCooldownMs` | `15000` | Integer at least 0. How long a failing target, runtime and model route is skipped; `0` disables the wait. | next turn |
| `fleet.retry.breakerThreshold` | `1` | Integer at least 1. Consecutive failures that open a route's breaker. | next turn |
| `fleet.limits.toolCallsPerRun` | `150` | Integer at least 1. Tool calls one worker may make; a worker's own smaller cap still applies. | next turn |
| `fleet.limits.internalRunTimeoutMs` | `900000` | Integer at least 1. Ceiling for one internal worker run such as the wiki writer or the first project scout. | next turn |
| `fleet.history.maxRuns` | `1000` | Integer at least 1. Finished runs kept in the run ledger; the oldest run and its event log go first. | next turn |
| `fleet.history.journal` | `true` | Boolean. Keep the per-run event journal. | next turn |
| `context.toolResultMaxBytes` | `65536` | Integer at least 4096. One tool result larger than this spills to scratch. | next turn |
| `context.workingSet.enabled` | `true` | Boolean. Off skips eviction and goes straight to summary compaction. | next turn |
| `context.workingSet.policy` | `"structural-v2"` | `structural-v2`, `structural-v1` or `age-horizon`. | next turn |
| `context.workingSet.profile` | `"default"` | `default`, `data-analysis` or `web-design`. A protection profile for the main agent; workers run their own guard. | next turn |
| `context.workingSet.target` | `0.6` | Number above 0 and below 1. Used-to-window ratio an eviction event batches down to. Choose a value below `context.compaction.threshold`. | next turn |
| `context.workingSet.protectLastTurns` | `6` | Integer at least 1. Recent user turns whose observations are never evicted. | next turn |
| `context.workingSet.protectLastSteps` | `8` | Integer at least 1. Recent assistant steps never evicted, inside the turn window. | next turn |
| `context.workingSet.minEvictableTokens` | `200` | Integer at least 0. Results smaller than this stay. | next turn |
| `context.workingSet.rearmFraction` | `0.1` | Number from 0 up to but not including 1. Growth, as a fraction of the window, required before another automatic cleanup; `0` disables the band. | next turn |
| `context.compaction.auto` | `true` | Boolean. Off still allows `/context compact` and overflow recovery. | next turn |
| `context.compaction.threshold` | `0.8` | Number from 0 to 1. Context pressure at which compaction acts. | next turn |
| `context.memory.enabled` | `true` | Boolean. Task memory updates. `false` turns proactive memory off, including its model calls. | next turn |
| `context.memory.target` | `null` | Target id for a dedicated memory route. With `target` and `model` both `null`, the memory tier runs on the active chat route (`chat.target` and `chat.model`) and its calls are billed to the chat model. An explicit route wins. | next turn |
| `context.memory.model` | `null` | Wire model id; cleared when `target` is `null`, otherwise defaults to the target's `defaultModel`. | next turn |
| `context.memory.cadenceToolCalls` | `10` | Integer at least 2. Most tool calls between memory updates. | next turn |
| `context.memory.trajectorySteps` | `8` | Integer at least 1. Recent steps considered. | next turn |
| `context.memory.maxOutputTokens` | `2000` | Integer at least 1. Length cap of one memory note. | next turn |
| `context.memory.timeoutMs` | `60000` | Integer at least 1. Wait for the memory model. | next turn |
| `systemOne.engines` | `{}` | Map of engine name to `{ kind, target, model?, mode?, profile? }`. | next turn |
| `systemOne.sites` | `{}` | Map of site id to an engine name or `{ engine, timeoutMs?, tasks? }`. A site with no entry is off. | next turn; `systemOne.sites.consult` needs a restart |
| `systemOne.cuts` | `{}` | Per-build overrides keyed by answering build, then `<site>.<key>`, with values from 0.01 to 0.99. | next turn |
| `systemOne.record` | `false` | Boolean. Keep every decision and its outcome as a local dataset. | next turn |
| `systemOne.retentionDays` | `30` | Integer at least 1. Days of dataset day files kept. | next turn |
| `systemOne.maxMiB` | `64` | Integer at least 1. Size cap of the dataset directory. | next turn |
| `safety.autonomy` | `"default"` | `default` or `yolo`. User layer or operator session control. A project layer can only tighten the user level (`default` over `yolo`); a looser value is ignored with a layer issue. | hot reload |
| `safety.limits.sessionCostUsd` | `5` | Finite number at least 0, in USD; a negative value fails validation. Session cost ceiling. It gates requests on routes priced `known` or `estimated`; see [pricing](configuration-and-targets.md#pricing-and-cost-provenance). `0` means no session ceiling: paid requests are admitted, dispatch plans and Scout continuations carry a ceiling of 0, and fleet previews skip the remaining-budget check. | next turn |
| `safety.limits.chatToolCallsPerTurn` | `60` | Integer at least 1. At the limit Clio stops using tools and summarizes the turn. | next turn |
| `safety.limits.readBytesPerCall` | `51200` | Integer at least 1. Most text one file read returns; a read gets at least 1 KB. | next turn |
| `safety.limits.observationBytesPerTurn` | `196608` | Integer at least 1. Combined tool output the model may receive in one turn. While the value stays at this default the pool scales to 1.5 bytes per context-window token, between 192 KiB and 1 MiB; any other value applies exactly. | next turn |
| `safety.review.enabled` | `false` | Boolean. After a mutating turn a read-only reviewer worker checks the changed files. Interactive sessions only. | hot reload |
| `safety.sandbox` | `"auto"` | `auto`, `required` or `off`. OS sandbox for a dispatched worker's bash, `run_script` and verify commands; main-agent commands are not sandboxed. | next turn |
| `safety.sandboxNetwork` | `false` | Boolean. Let sandboxed worker commands reach the network. Workers holding `web_fetch` get network either way. | next turn |
| `interface.exitSummary` | `"full"` | `full` prints the visit's activity and usage, `brief` prints models, tokens and cost, `off` prints only how to resume. Read at the next exit. | hot reload |
| `interface.demo` | `true` | Boolean. Full welcome presentation, tips and footer hints; off starts with a compact header. | hot reload |
| `interface.terminalProgress` | `false` | Boolean. Running-task progress in terminals that show tab or taskbar badges. | next turn |
| `interface.outputDetail` | `"standard"` | `compact`, `standard` or `detailed`. `minimal`, `default` and `verbose` are accepted as synonyms. | hot reload |
| `interface.mode` | `"regular"` | `regular` keeps scrollback; `fullscreen` uses the alternate screen with a sticky composer and footer. | restart required |
| `interface.fullscreenScrollbar` | `"auto"` | `hidden`, `auto` or `always`. | restart required |
| `interface.smoothStreaming` | `"auto"` | `off`, `auto` or `on`. Presentation-only pacing of streamed text and thinking. | hot reload |
| `interface.desktopNotifications` | `false` | Boolean. Content-free alerts when a turn ends, a detached batch settles or an approval parks. Interactive TTY sessions only. | next turn |
| `interface.panes.enabled` | `"embedded"` | `auto`, `embedded` or `off`. `embedded` lets bare `clio-coder` open a workspace in a pane host after one remembered question, and joins a host it is started inside. `auto` uses a detected pane host and never starts one. `off` never detects or opens a pane. | restart required |
| `interface.panes.notifications` | `"failures"` | `failures`, `all` or `off`. Which run states raise a pane-host toast. | hot reload |
| `interface.panes.layout` | `"off"` | `off`, `workers` or `cockpit`. Panes composed at interactive boot. | restart required |
| `interface.panes.workers.ratio` | `0.34` | Number from 0.05 to 0.5. Share of the width the workers dock takes. | hot reload |
| `interface.panes.files.enabled` | `false` | Boolean. Whether `/files` and `/panes open files` may open the files pane. | hot reload |
| `interface.panes.files.mode` | `"companion"` | `companion` or `chooser`. | hot reload |
| `interface.panes.files.profile` | `"managed"` | `managed` or `user`. | hot reload |
| `interface.panes.files.followCwd` | `true` | Boolean. | hot reload |
| `interface.panes.files.ratio` | `0.3` | Number from 0.05 to 0.5. Share of the height the files dock takes. | hot reload |
| `interface.keybindings` | `{}` | Map of action id to a key string or a list of key strings. | hot reload |
| `integrations.projectResources.trustProjectImports` | `false` | Boolean. Admit explicitly imported foreign skills and prompts at either scope; loose compatibility roots stay discovery-only. | next turn |
| `integrations.externalAgents.entries` | `[]` | List of ACP peers: `id`, `command`, `args`, `cwd?`, `env?`, `connectTimeoutMs?`, `turnTimeoutMs?`, `stallTimeoutMs?`, `toolGovernance?`, `trustedUnmediated?`, `projectContext?` (`none` or `bounded`). | next turn |
| `integrations.externalAgents.defaults.connectTimeoutMs` | `30000` | Integer at least 1. | next turn |
| `integrations.externalAgents.defaults.turnTimeoutMs` | `0` | Integer at least 0. `0` sets no elapsed deadline. | next turn |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | `120000` | Integer at least 1. Bounds Clio Coder's own ACP server permission requests. | next turn |
| `integrations.externalAgents.defaults.toolGovernance` | `"clio-coder-policy"` | `clio-coder-policy`, `agent-managed` or `deny-all`. | next turn |
| `integrations.runtimePlugins` | `[]` | Package names of runtime plugins loaded at startup. | restart required |
| `integrations.library.catalog` | `null` | Absolute catalog path, or `null` for the one in the config directory. | next turn |
| `integrations.library.remote` | `null` | Git remote URL the catalog syncs with, or `null` for a local library. | next turn |
| `integrations.library.confirmedRemote` | `null` | The remote the operator approved. Written by Clio Coder, read-only in the UI. | next turn |
| `integrations.library.sync` | `false` | Boolean. Whether library sync and push may contact the remote. | next turn |
| `integrations.git.commitAttribution` | `true` | Boolean. Evidence-backed role trailers on commits created through Clio Coder. | hot reload |
| `integrations.music.enabled` | `false` | Boolean. Allows `/music` to open cliamp in a Herdr dock. Needs Herdr panes and cliamp. | hot reload |
| `integrations.music.station` | `"http://radio.cliamp.stream/lofi/stream"` | Non-empty string, a stream URL or a station name. What `/music on` plays. | hot reload |
| `integrations.music.agentControl` | `false` | Boolean. Registers the `music` tool at startup so the model can drive the pane; off, the tool does not exist and costs no prompt bytes. | restart required |

`systemOne.*` and `fleet.speculativeDispatch` are experimental and off by default. The [System One guide](system-one.md) describes them, including the engine `profile` field (`generic`, `jev`, `laya`, `laya-multilingual`, `julia-1`, `gliner2.5-small`, `gliner2.5-decide` or `strands-decider`) and the per-site `tasks` routes, which have no default. A decision engine's window is the `capabilities.contextWindow` of its `systemone` target (480 when unset), bounded by the profile's ceiling. There is no placement setting: which processor an engine runs on is decided by the server behind its target, as the placing-engines section of the [System One guide](system-one.md) describes.

The music keys are documented in the [music guide](music.md). The exit summary is part of [commands and modes](commands-and-modes.md).

### Optional keys with no default

These schema keys are absent from `DEFAULT_SETTINGS` because an unset value selects automatic behavior. Clearing the field removes the override.

| Key | Accepted values and meaning | Effect |
| --- | --- | --- |
| `fleet.default.node` | `local` or a `fleet.nodes[].id`. Where workers run unless their profile says otherwise. Profiles accept the same `node` field. | next turn |
| `context.compaction.model` | Model pattern for a dedicated summarizer; unset uses the chat model. An explicit pattern must resolve uniquely or compaction fails visibly. | next turn |
| `context.compaction.systemPrompt` | Path to a nonempty UTF-8 prompt file of at most 65,536 bytes, resolved relative to the session workspace at compaction time; unset uses the built-in instructions. | next turn |
| `safety.review.target` | Target id for the reviewer; unset uses the chat target. An id that is not in `targets` is an error. | hot reload |
| `safety.review.cadenceToolCalls` | Integer at least 1. Also review after this many tool calls inside a turn; unset reviews only at turn end. | hot reload |

| Precedence, low to high | Use |
| --- | --- |
| Compiled defaults | Baseline values in [`src/core/defaults.ts`](../../src/core/defaults.ts). |
| User `settings.yaml` | Personal defaults under the resolved Clio Coder config directory. |
| .clio-coder/settings.yaml | Shared project defaults. Credential-bearing keys are ignored. |
| .clio-coder/settings.local.yaml | Untracked project overrides. Credential-bearing keys are ignored. |
| Session controls | `/settings`, `/model`, and `/thinking` change the active session where supported. `/config` runs the configure flow and applies the saved routing to the session. |
| CLI options | Run-specific values such as `--target`, `--model`, and turn constraints. |

The schema, validation, migration paths, and user settings path are in [`src/core/config.ts`](../../src/core/config.ts). Layering and project-file merge behavior are in [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts). Settings control groups are defined in [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts) and [`src/core/settings-navigation.ts`](../../src/core/settings-navigation.ts).

| Need to inspect | Source of truth |
| --- | --- |
| Setting names, types, defaults, enums | [`src/core/defaults.ts`](../../src/core/defaults.ts) and [`src/core/config.ts`](../../src/core/config.ts) |
| Effect timing | [`src/domains/config/classify.ts`](../../src/domains/config/classify.ts) |
| Project settings precedence and secret filtering | [`src/core/settings-layers.ts`](../../src/core/settings-layers.ts) |
| Settings UI sections and editable controls | [`src/core/settings-navigation.ts`](../../src/core/settings-navigation.ts), [`src/core/settings-controls.ts`](../../src/core/settings-controls.ts) |
| Target and provider settings | [`src/domains/providers/`](../../src/domains/providers/registry.ts) |
| CLI flags and accepted values | [`src/cli/args.ts`](../../src/cli/args.ts), then `clio-coder <command> --help` |
| Environment variables | [Environment variable reference](environment-variables.md) and their cited read sites |
| Built-in tool arguments | [`src/tools/`](../../src/tools/registry.ts) and [Tool usage](tool-usage.md) |
| Agent definition frontmatter | [`src/domains/agents/recipe-schema.ts`](../../src/domains/agents/recipe-schema.ts) |
| Prompt fragment metadata | [`src/domains/prompts/`](../../src/domains/prompts/compiler.ts) |
| Model facts per model | [`models/profiles.yaml`](../../models/profiles.yaml) and [`src/domains/providers/model-profiles.ts`](../../src/domains/providers/model-profiles.ts) |
| Sampling presets and family notes | [`src/domains/providers/models/local-models/`](../../src/domains/providers/models/local-models/clio-coder-local-coding-targets.yaml) |

For an ACP peer, `integrations.externalAgents.entries[].env` may use an exact
`"{env:NAME}"` value. Clio resolves that named host variable for the configured
peer at launch and refuses a missing reference. Keep provider keys out of the
settings file; see [Coding Agent Interoperability](interop.md).

## Version 1 to version 2 key map

`clio-coder upgrade` runs the version-1 to version-2 migration and keeps the original as `settings.yaml.v1.bak`. Validation is strict and has no read-time aliases: a version-2 file that still names a version-1 path is rejected with a message naming the replacement. The manifest is `SETTINGS_V1_PATH_MOVES` in [`src/core/config.ts`](../../src/core/config.ts). `*` stands for a map key and `[]` for a list element, and values move without reinterpretation. A non-canonical v1 `autonomy` value becomes `default` and the migration report says so.

### Chat

| Version 1 path | Version 2 path |
| --- | --- |
| `orchestrator.target` | `chat.target` |
| `orchestrator.model` | `chat.model` |
| `orchestrator.thinkingLevel` | `chat.thinkingLevel` |
| `scope[]` | `chat.modelPicker.cycleSet[]` |
| `modelSelector.favorites[]` | `chat.modelPicker.favorites[]` |
| `modelSelector.recentLimit` | `chat.modelPicker.recentLimit` |
| `defaults.maxTokens` | `chat.maxOutputTokens` |
| `prewarm.enabled` | `chat.prewarm` |
| `retry.enabled` | `chat.retry.enabled` |
| `retry.maxRetries` | `chat.retry.maxRetries` |
| `retry.baseDelayMs` | `chat.retry.baseDelayMs` |
| `retry.maxDelayMs` | `chat.retry.maxDelayMs` |
| `retry.streamStallMs` | `chat.retry.streamStallMs` |

### Fleet

| Version 1 path | Version 2 path |
| --- | --- |
| `workers.default.target` | `fleet.default.target` |
| `workers.default.model` | `fleet.default.model` |
| `workers.default.thinkingLevel` | `fleet.default.thinkingLevel` |
| `workers.default.node` | `fleet.default.node` |
| `workers.profiles.*.target` | `fleet.profiles.*.target` |
| `workers.profiles.*.model` | `fleet.profiles.*.model` |
| `workers.profiles.*.thinkingLevel` | `fleet.profiles.*.thinkingLevel` |
| `workers.profiles.*.node` | `fleet.profiles.*.node` |
| `workers.rosters.*.members[].label` | `fleet.rosters.*.members[].label` |
| `workers.rosters.*.members[].target` | `fleet.rosters.*.members[].target` |
| `workers.rosters.*.members[].model` | `fleet.rosters.*.members[].model` |
| `workers.rosters.*.members[].thinking` | `fleet.rosters.*.members[].thinkingLevel` |
| `workers.rosters.*.members[].color` | `fleet.rosters.*.members[].color` |
| `workers.agentBindings.*` | `fleet.agentProfiles.*` |
| `routing.activeRoles[]` | `fleet.adaptiveRouting.roles[]` |
| `routing.activePostures[]` | `fleet.adaptiveRouting.postures[]` |
| `routing.agentAutomation.activeAgentRoles[].agentId` | `fleet.adaptiveRouting.agentRoles[].agentId` |
| `routing.agentAutomation.activeAgentRoles[].executionRole` | `fleet.adaptiveRouting.agentRoles[].executionRole` |
| `budget.concurrency` | `fleet.concurrency` |
| `workers.maxRetries` | `fleet.retry.maxRetries` |
| `workers.resilienceCooldownMs` | `fleet.retry.routeCooldownMs` |
| `workers.onPermission` | `fleet.permissions.mode` |
| `workers.escalation.timeoutMs` | `fleet.permissions.escalation.timeoutMs` |
| `workers.escalation.fallback` | `fleet.permissions.escalation.fallback` |
| `guardrails.workerToolCallCap` | `fleet.limits.toolCallsPerRun` |
| `guardrails.internalDispatchTimeoutMs` | `fleet.limits.internalRunTimeoutMs` |
| `guardrails.maxDispatchRuns` | `fleet.history.maxRuns` |
| `panes.journal` | `fleet.history.journal` |

Inside `fleet.nodes`, the key `clioEntry` is renamed `clioCoderEntry`. A file that still says `clioEntry` is refused with the same replacement message, and the migrator renames it.

### Context and memory

| Version 1 path | Version 2 path |
| --- | --- |
| `compaction.auto` | `context.compaction.auto` |
| `compaction.threshold` | `context.compaction.threshold` |
| `compaction.model` | `context.compaction.model` |
| `compaction.systemPrompt` | `context.compaction.systemPrompt` |
| `background.target` | `context.memory.target` |
| `background.model` | `context.memory.model` |
| `memory.intervention.enabled` | `context.memory.enabled` |
| `memory.intervention.everyNTools` | `context.memory.cadenceToolCalls` |
| `memory.intervention.windowSteps` | `context.memory.trajectorySteps` |
| `memory.intervention.maxTokens` | `context.memory.maxOutputTokens` |
| `memory.intervention.timeoutMs` | `context.memory.timeoutMs` |

### Safety

| Version 1 path | Version 2 path |
| --- | --- |
| `autonomy` | `safety.autonomy` |
| `budget.sessionCeilingUsd` | `safety.limits.sessionCostUsd` |
| `guardrails.turnToolCallBudget` | `safety.limits.chatToolCallsPerTurn` |
| `guardrails.readMaxBytes` | `safety.limits.readBytesPerCall` |
| `guardrails.observationTurnBudgetBytes` | `safety.limits.observationBytesPerTurn` |
| `watchdog.enabled` | `safety.review.enabled` |
| `watchdog.target` | `safety.review.target` |
| `watchdog.cadenceToolCalls` | `safety.review.cadenceToolCalls` |

### Interface

| Version 1 path | Version 2 path |
| --- | --- |
| `terminal.outputVerbosity` | `interface.outputDetail` |
| `terminal.smoothStreaming` | `interface.smoothStreaming` |
| `terminal.tuiMode` | `interface.mode` |
| `terminal.fullscreenScrollbar` | `interface.fullscreenScrollbar` |
| `terminal.showTerminalProgress` | `interface.terminalProgress` |
| `terminal.notify` | `interface.desktopNotifications` |
| `panes.enabled` | `interface.panes.enabled` |
| `panes.notifications` | `interface.panes.notifications` |
| `panes.yazi.enabled` | `interface.panes.files.enabled` |
| `panes.yazi.mode` | `interface.panes.files.mode` |
| `panes.yazi.profile` | `interface.panes.files.profile` |
| `panes.yazi.followCwd` | `interface.panes.files.followCwd` |
| `keybindings.*` | `interface.keybindings.*` |

### Integrations

| Version 1 path | Version 2 path |
| --- | --- |
| `skills.trustProjectCompatRoots` | `integrations.projectResources.trustProjectImports` |
| `delegation.defaults.connectTimeoutMs` | `integrations.externalAgents.defaults.connectTimeoutMs` |
| `delegation.defaults.turnTimeoutMs` | `integrations.externalAgents.defaults.turnTimeoutMs` |
| `delegation.defaults.permissionTimeoutMs` | `integrations.externalAgents.defaults.permissionTimeoutMs` |
| `delegation.defaults.toolGovernance` | `integrations.externalAgents.defaults.toolGovernance` |
| `delegation.agents[].id` | `integrations.externalAgents.entries[].id` |
| `delegation.agents[].command` | `integrations.externalAgents.entries[].command` |
| `delegation.agents[].args[]` | `integrations.externalAgents.entries[].args[]` |
| `delegation.agents[].cwd` | `integrations.externalAgents.entries[].cwd` |
| `delegation.agents[].env.*` | `integrations.externalAgents.entries[].env.*` |
| `delegation.agents[].connectTimeoutMs` | `integrations.externalAgents.entries[].connectTimeoutMs` |
| `delegation.agents[].turnTimeoutMs` | `integrations.externalAgents.entries[].turnTimeoutMs` |
| `delegation.agents[].stallTimeoutMs` | `integrations.externalAgents.entries[].stallTimeoutMs` |
| `delegation.agents[].toolGovernance` | `integrations.externalAgents.entries[].toolGovernance` |
| `delegation.agents[].projectContext` | `integrations.externalAgents.entries[].projectContext` |
| `runtimePlugins[]` | `integrations.runtimePlugins[]` |
| `library.catalog` | `integrations.library.catalog` |
| `library.remote` | `integrations.library.remote` |
| `library.confirmedRemote` | `integrations.library.confirmedRemote` |
| `library.sync` | `integrations.library.sync` |
| `attribution.gitCommits` | `integrations.git.commitAttribution` |

## Retired keys and values

`SETTINGS_V1_RETIRED_PATHS` in [`src/core/config.ts`](../../src/core/config.ts) lists keys removed with no replacement. A user `settings.yaml` that names one is refused with a targeted removal message; a project or local layer drops the leaf with the same diagnostic. The v1 migrator drops the version-1 entries and records the reason in its migration report.

| Retired path | Reason |
| --- | --- |
| `identity` | Accepted and ignored. |
| `background.thinkingLevel` | Proactive memory always resolves thinking off. |
| `theme` | The only registered theme was not read by runtime rendering. |
| `compaction.excludeLastTurns` and `context.compaction.excludeLastTurns` | Only the temporary legacy mask used it. Use `context.workingSet.protectLastTurns`. |
| `delegation.agents[].permissionTimeoutMs` and `integrations.externalAgents.entries[].permissionTimeoutMs` | A delegated agent's permission ask is decided at once and never waits for the operator. `integrations.externalAgents.defaults.permissionTimeoutMs` still bounds Clio Coder's own ACP server. |
| `delegation.agents[].labels` and `integrations.externalAgents.entries[].labels` | Nothing read or displayed external agent labels. |
| `fleet.decisionProfiles` | System One replaced decision profiles. Bind an engine under `systemOne.engines` and `systemOne.sites`. An empty `{}` is accepted silently. |
| `turnControl.interpretation` | The `systemOne.sites.turn` site reads the request, and nothing falls back to the main model. |

Three enum spellings are retired and stay validation errors until `clio-coder doctor --fix` rewrites them, so loading never changes policy silently.

| Key | Retired value | Replacement |
| --- | --- | --- |
| `safety.autonomy` | `auto-edit`, `suggest`, `read-only` | `default` |
| `safety.autonomy` | `full-auto` | `yolo` |
| `targets[].lifecycle` | `clio-managed` | `clio-coder-managed` |
| `integrations.externalAgents.defaults.toolGovernance` and `entries[].toolGovernance` | `clio-policy` | `clio-coder-policy` |

`doctor --fix` also rewrites YAML 1.1 `on` and `off` booleans written where a field takes the strings `on` or `off`.

## Project files

Project configuration lives under `.clio-coder/`. The owning loader or validator is authoritative for each file's schema.

| File | Purpose / owner |
| --- | --- |
| `settings.yaml`, `settings.local.yaml` | Shared and local settings layers; [settings-layers.ts](../../src/core/settings-layers.ts) |
| `safety.yaml` | Project command and path policy; [project-policy.ts](../../src/domains/safety/project-policy.ts) |
| `mcp.yaml` | Project MCP declarations; [trust rules below](#local-stdio-mcp-configuration-and-trust), [config.ts](../../src/domains/gateway/mcp/config.ts) |
| `verifiers.yaml` | Declared verification checks; [catalog.ts](../../src/tools/verify/catalog.ts) |
| `hooks.yaml`, `hooks.local.yaml` | Project and local middleware hooks; [hooks-io.ts](../../src/domains/middleware/hooks-io.ts) |
| `profile.yaml` | Project operator profile; [operator-profile.ts](../../src/domains/context/operator-profile.ts) |
| `agents/`, `playbooks/` | Agents and playbooks; `src/domains/agents/` |
| `prompts/`, `skills/` | Prompt templates and skills; `src/domains/resources/` |
| `rules/` | Path-scoped project rules; [project-rules.ts](../../src/domains/context/project-rules.ts) |
| `model-catalog.d/` | Project overlay of sampling presets and family notes; see [local catalog overlays](../architecture/model-catalog.md#local-catalog-overlays) |

User-level model profile overrides live at `<configDir>/model-profiles.yaml`, not under `.clio-coder/`; see [model profiles](configuration-and-targets.md#model-profiles).

## Local stdio MCP configuration and trust

User MCP declarations are stored at `<config>/mcp.yaml`; project declarations are stored at `.clio-coder/mcp.yaml`. The declaration contract is implemented in [`src/domains/gateway/mcp/config.ts`](../../src/domains/gateway/mcp/config.ts). A server entry accepts `id`, `command`, `args`, `cwd`, `env`, `timeoutMs`, `actionClass` and `toolActionClasses`; `toolActionClasses` maps individual tool names to `read`, `execute` or `unknown` and overrides the server class for those tools.

| Declaration | Launch rule |
| --- | --- |
| User scope | Trusted by file ownership; actions still pass through tool policy. Set `actionClass: read` for an operator-reviewed read-only server, or `actionClass: execute` for an executing server. Omitted classes remain `unknown` and require approval. |
| Project scope | Does not launch until an operator trusts the declaration with `clio-coder mcp trust <id>` or `/mcp trust <id>`. |
| Trust record | User-owned `<config>/mcp-trust.json`, bound to project root, server id, and declaration digest. |
| Changed declaration | Editing command, args, cwd, environment, timeout, or tool action classes makes trust stale; review and trust it again. |
| Trust boundary | Trust enables launch; it is not operating-system isolation. Server annotations do not grant authority. |

Only user declarations may set `actionClass`; project declarations receive their class from the explicit trust record. Classify the entire server by its most powerful tool, since the declaration applies to every tool it exposes. For example, a locally installed literature-search server whose tools only query or transform citation metadata can use `actionClass: read` to work in `yolo` without a headless approval dead end.

Trust and declaration loading are implemented in [`src/domains/gateway/mcp/trust.ts`](../../src/domains/gateway/mcp/trust.ts). The model-facing discovery and call contract is in [gateway tool usage](tool-usage.md).

## Let Clio Coder propose settings changes

In an interactive `default` or `yolo` session, ask Clio to change a chat model, fleet route, or profile. Clio can discover `configure_clio` through the gateway and preview one saved setting change. The tool accepts only these paths: `chat.target`, `chat.model`, `chat.thinkingLevel`, `chat.modelPicker.*`, `fleet.default.*`, `fleet.profiles`, `fleet.agentProfiles`, `fleet.concurrency`, `fleet.limits.*`, and `context.memory.target` and `.model`. Any other path is refused and points at `/settings` or `configure`.

Applying behaves by path. In `default`, applying a chat or memory setting requests an **Apply** or **Cancel** decision from the host UI; in `yolo`, the exact preview applies directly. A persistent fleet routing change (`fleet.default`, `fleet.profiles`, `fleet.agentProfiles`) always asks the operator to approve the exact preview, at every autonomy level, and the preview names the alternative for a one-off run: pin the dispatch call's `target` and `model` instead of saving routing. Applying checks that the saved value still matches the preview; a proposal expires after 10 minutes, and expired or stale proposals need a fresh preview. The tool excludes credentials, connection definitions, and `safety.autonomy`. The running session keeps its current routing, so run `/restart` (it saves and restarts into this session and workspace) or start a new Clio Coder session to use a newly saved route. `/reload [settings|library|extensions|all]` re-reads those resources and reports what changed and what still needs a new session. Other settings take effect as the save result says: live settings pick up automatically, next-turn settings apply to the next request or dispatch, and restart-required settings need a new session.

`safety.autonomy` accepts only **default** and **yolo**. Set it in user `settings.yaml` or through an operator surface: `/settings`, `clio-coder configure`, `--autonomy`, or a session control in ACP or the GUI. A project layer may only tighten the user level; Clio ignores a looser project value and reports a layer issue. `configure_clio` cannot change it. An explicit v1 upgrade resets every other v1 autonomy value to `default` and records the reset in the migration report.

## Exact CLI and tool contracts

CLI help is generated from the registered command surface. Run `clio-coder --help` or `clio-coder <command> --help` for the installed version; the parser lives in [`src/cli/`](../../src/cli/index.ts), with headless run options in [`src/cli/args.ts`](../../src/cli/args.ts).

Tool schemas are registered in [`src/tools/`](../../src/tools/registry.ts). Use [Tool usage](tool-usage.md) for operational behavior and source for exact argument types. Runtime-discovered MCP and extension schemas are supplied by those integrations rather than a static settings catalog.

## CLI flags

### `context`

Run `clio-coder context <subcommand> --help` for the installed usage. The subcommands are `init`, `refresh`, `wiki`, `reset`, `index`, `map`, `replay` and `working-set`; each rejects a flag it does not take.

| Flag | Controls |
|---|---|
| `--help`, `-h` | Print the command's usage and exit. |
| `--all` | For `context reset`, also remove the local CLIO-CODER.md after a second confirmation; override files stay human-owned. |
| `--yes`, `-y` | For `context reset`, answer the confirmations without prompting; without a terminal the reset needs it. For `context init`, update `.gitignore` without prompting. |
| `--preview` | For `context init`, show the plan without writing any files. |
| `--heuristic` | For `context init`, skip model exploration and use the deterministic generator. |
| `--adopt` | For `context init`, refresh only the managed imported-agent-context section. |
| `--global` | For `context init`, include global sibling agent context from the user home directory. |
| `--propose`, `--apply`, `--rewrite` | For `context init` over an existing CLIO-CODER.md: write an ignored draft, update the handbook from a draft grounded in it, or replace it with a fresh draft that ignores it. |
| `--depth` | For `context init`, exploration bound: `quick` (8 calls, 2 minutes), `standard` (16, 4) or `deep` (32, 8). For `context wiki`, generation depth: `auto`, `simple`, `medium`, or `detailed`. |
| `--target`, `--model`, `--thinking` | For `context init` and `context wiki`, override the route for one run. `--model` and `--thinking` need `--target` on `init`. The wiki accepts `off`, `low`, `medium` or `high` for `--thinking`. For `context replay`, `--target` is the fraction of the window an eviction batches down to, above 0 and below 1 and below `--threshold`. |
| `--wiki` | For `context refresh`, also update the Markdown wiki. |
| `--update`, `--retry-pending`, `--replan`, `--status` | For `context wiki`: force an update, retry pending pages once without replanning, rebuild the plan (not with `--retry-pending`), or print the wiki status. |
| `--out` | For `context map`, where to write the architecture seed. |
| `--json` | For `context index`, `context map` and `context init`, emit machine-readable output; for `context replay`, `--json <path>` writes the stable JSON report to that path instead. |
| `--sessions` | For `context replay`, one or more session ledger paths to replay. Either `--sessions` or `--synthetic` is required. |
| `--synthetic` | For `context replay`, comma-separated ids of procedural corpora. |
| `--threshold` | For `context replay`, the compaction threshold, above 0 and at most 1. |
| `--budgets` | For `context replay`, comma-separated positive-integer token budgets each policy is replayed against. |
| `--md` | For `context replay`, path to write the Markdown report to instead of printing it. |
| `--min-evictable-tokens` | For `context replay`, non-negative integer tool-result size in tokens below which results are never evicted. |
| `--no-filter` | For `context replay`, include every readable transcript instead of only the filtered active-path sessions. |
| `--policies` | For `context replay`, comma-separated policy ids from none, random, age-horizon, structural-v1, structural-v2, oracle, or a rung composition (`<id>+<rung>`, `<id>-<rung>`, `rungs:<a>/<b>`). |
| `--profile` | For `context replay`, `default`, `data-analysis`, or `web-design`; a non-default profile includes paired default-profile results over the same corpus. |
| `--protect-last-steps` | For `context replay`, positive integer count of recent assistant steps whose observations are protected. |
| `--protect-last-turns` | For `context replay`, integer (at least 1) count of recent user turns whose observations are never evicted. |
| `--rearm-fraction` | For `context replay`, projected growth as a fraction of the window before another automatic reduction, at least 0 and below 1; default 0.1. |
| `--overflow-fraction` | For `context replay`, modeled request-fit limit as a fraction of the budget; reduction bypasses the rearm band above it, default 0.95. |
| `--seed` | For `context replay`, integer seed for the deterministic random policy. |
| `--session` | For `context working-set`, the session id or path whose working-set fold and path index are printed (required). |

## Tool arguments

### `context`

| Argument | Class | Controls |
|---|---|---|
| `context.include_tree` | policy | scope=skills: list files under the skill base_dir. |
| `context.limit` | policy | scope=settings: max controls (default/max 12); scope=recall discovery: max refs (default 8, max 12); scope=skills: rows (max 200). |
| `context.name` | task | scope=skills: skill name to load; omit to list. |
| `context.path` | task | scope=recall: the newest evicted read of this file. |
| `context.query` | task | scope=settings: path, section alias, or search terms; scope=recall discovery: path, tool, or ref terms; scope=skills: narrow the list; omit to list. |
| `context.ref` | task | scope=recall: ref of the evicted item, as named in its marker. |
| `context.scope` | policy | workspace, settings, skills, recall, or budget. `budget` inspects the live request budget and accepts no other argument. |
| `context.offset` | policy | Zero-based settings, recall discovery or skills offset; follow nextOffset. |
