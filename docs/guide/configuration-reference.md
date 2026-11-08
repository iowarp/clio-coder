# Configuration reference

The [model catalog contract](../architecture/model-catalog.md) explains how live discovery, model profiles and catalog settings interact.

This page is a map to the implemented configuration surface. Source defines the complete key, flag, and argument contracts; use the linked files when exact schemas or defaults matter. For setup choices, see [Configuration and targets](configuration-and-targets.md). For `CLIO_*` variables, see the [environment variable reference](environment-variables.md).

## Settings keys

`clio-coder configure --settings` and GUI Settings use eight sections: **Connections → Chat → Fleet → Context & Memory → Permissions & Limits → Appearance → Integrations → Advanced**. TUI `/settings` uses twelve areas, including Recent & Pinned, Models & Inference, Agents & Delegation, and Workspace & Files. Names describe what the settings change; YAML paths remain the version-2 schema below. For example, Connections manages `targets`, Appearance manages `interface.*`, and Permissions & Limits includes `fleet.permissions.*` and external-agent tool governance. See the [Settings Center walkthrough](configuration-and-targets.md#settings-center) for navigation, model inheritance, and save scopes.

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

Default chat settings control interactive conversation routing, reasoning effort, token output budgets, prefix prewarming, and prompt-cache keepalive:
- `chat.target`: default chat target id (`null`).
- `chat.model`: default chat model id (`null`).
- `chat.thinkingLevel`: default reasoning effort for the chat model (`"low"`; clamped to supported provider levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`).
- `chat.prewarm`: whether prompt-prefix prewarming runs on session start (`false`). When enabled, prewarming prefills the prompt prefix before the first turn, and again after a resume or a compaction settles. It runs against `local-native` runtimes and against a `litellm` target that binds `cache.deployment`; every other tier is skipped whatever this setting says. Dispatched workers and headless runs do not prewarm.
- `chat.maxOutputTokens`: per-turn output token limit (`0`, meaning each model's own cap and its profile's recommended output budget).
- `chat.cacheKeepalive`: whether Clio refreshes a hosted provider's prompt cache while a turn waits on its own tools (`true`). A hosted cache entry expires after a few idle minutes, and a turn that waits on an attached dispatch can outlast it. Clio then replays the turn's last request, with the route's smallest output cap (1 token on Anthropic, 16 on OpenAI Responses and Codex), at 90% of the entry's lifetime, only when the refresh is expected to save at least $0.05 over the miss it prevents. The keepalive follows one turn for up to two hours while a dispatch is attached and up to one hour for any other tool. It stands down while a permission ask or `ask_user` round waits on a person, between turns, and when the route declares no lifetime, retention is `none`, or the cost ceiling would be reached. Each refresh is booked as `prewarm` usage and recorded on the session ledger. `false` turns it off.
- `chat.retry.*`: retry backoff (`baseDelayMs: 2000`, `maxDelayMs: 60000`), attempt limit (`maxRetries: 3`), and stream stall timeouts (`streamStallMs: 180000`, `firstTokenStallMs: 600000`). Clio never retries before a wait the provider states, whether in a `Retry-After` header or in the error text (`retry after 30s`, `try again in 5m`). When the failure is one that waiting can clear, Clio honors such a wait in every autonomy mode while `chat.retry.enabled` is on and `maxRetries` is above 0, with a countdown that Esc cancels, and the wait does not spend one of `maxRetries`. One request waits at most one hour in total; a stated wait that would take it past that stops the turn without retrying, and the notice names the wait the provider asked for. `maxDelayMs` limits only Clio's own backoff and never shortens a stated wait.

| Key | Default | Accepted values and meaning | Effect |
| --- | --- | --- | --- |
| `version` | `2` | Schema version. Any other value fails validation and points at `clio-coder upgrade`. | restart required |
| `turnControl.workflows` | `["detached-collection"]` | Which turn-control workflows may run. `detached-collection` collects finished detached batches before an answer. The retired values `orientation`, `direction` and `ledger-facts` load silently and do nothing. | next turn |
| `targets` | `[]` | List of target entries with unique ids. Fields are in [target fields](configuration-and-targets.md#target-fields). | next turn |
| `chat.target` | `null` | Target id that answers chat. An id that is not in `targets` normalizes to `null`. | next turn |
| `chat.model` | `null` | Wire model id. With a target set, `null` resolves to that target's `defaultModel`; with no target it is `null`. | next turn |
| `chat.thinkingLevel` | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. | next turn |
| `chat.modelPicker.cycleSet` | `[]` | `target/model` refs the quick-switch key cycles. | hot reload |
| `chat.modelPicker.favorites` | `[]` | `target/model` refs pinned in `/model`. A ref that does not name an existing target is dropped. | hot reload |
| `chat.modelPicker.recentLimit` | `12` | Integer at least 1. Recently used refs `/model` keeps. | hot reload |
| `chat.maxOutputTokens` | `0` | Integer at least 0. Output tokens requested per turn on every target, clamped to the model's output cap and the remaining window. `0` leaves the budget to the model cap and the profile's recommendation. | next turn |
| `chat.prewarm` | `false` | Boolean. See above. | next turn |
| `chat.cacheKeepalive` | `true` | Boolean. See above. | hot reload |
| `chat.retry.enabled` | `true` | Boolean. Retry transient provider errors. | next turn |
| `chat.retry.maxRetries` | `3` | Integer at least 0. Attempts after the first failure. A retry that sits out a provider's stated wait does not count. | next turn |
| `chat.retry.baseDelayMs` | `2000` | Integer at least 0. First retry delay. | next turn |
| `chat.retry.maxDelayMs` | `60000` | Integer at least 0. Longest delay of Clio's own backoff. A wait the provider states is honored in full, up to one hour per request. | next turn |
| `chat.retry.streamStallMs` | `180000` | Integer at least 0. Silence mid-stream past this many ms aborts the call and retries. | next turn |
| `chat.retry.firstTokenStallMs` | `600000` | Integer at least 0. Silence allowed before the first token; `0` never aborts a call that has not started streaming. | next turn |
| `chat.steering.triage.enabled` | `false` | Boolean, experimental. A bound System One route, or else a side model, reads queued steering messages once the queue settles: an unrelated task waits for the end of the turn and a confident stop may interrupt the run. | next turn |
| `chat.steering.triage.target` | `null` | Target id for the side-model triage round; `null` uses a bound System One route, or the session's active target when none is bound. Naming a target keeps the side model. | next turn |
| `chat.steering.triage.model` | `null` | Wire model id on that target; cleared when `target` is `null`. | next turn |
| `chat.steering.triage.minQueued` | `2` | Integer at least 1. Queue length that starts a side-model round. A bound route starts at one message. | next turn |
| `chat.steering.triage.timeoutMs` | `8000` | Integer at least 1. A slower round is dropped and the queue stays as it was. | next turn |
| `chat.steering.triage.autoInterrupt` | `true` | Boolean. Let a confident `stop` reading cancel the run and deliver that message now. | next turn |
| `fleet.defaultNode` | `null` | `null`, `local`, or a `fleet.nodes[].id`. Standing placement preference for unpinned work; explicit and profile pins win. | next turn |
| `fleet.default.target` | `null` | Target id for delegated fleet work. | next turn |
| `fleet.default.model` | `null` | Wire model id. With a target set, `null` resolves to that target's `defaultModel`. | next turn |
| `fleet.default.thinkingLevel` | `"off"` | Same levels as `chat.thinkingLevel`. | next turn |
| `fleet.profiles` | `{}` | Map of profile name to `{ target, model, thinkingLevel, node? }`. | next turn |
| `fleet.rosters` | `{}` | Map of roster name to `members`, two to five entries of `{ label, target, model?, thinkingLevel?, color? }` with unique labels matching `[a-z][a-z0-9_-]{0,31}`. | next turn |
| `fleet.agentProfiles` | `{}` | Map of native agent id to a `fleet.profiles` name. | next turn |
| `fleet.nodes` | `[]` | List of SSH nodes: `id` (not `local`), `host`, `user?`, `port?`, `identityFile?`, `clioCoderEntry?`, `clioCoderVersionCommand?`, `labels?`, `maxWorkers` (default 2), `residency?` (`observe` or `manage`). | next turn |
| `fleet.adaptiveRouting.roles` | `[]` | Subset of `researcher`, `verifier`, `reviewer`, `judge`. | next turn |
| `fleet.adaptiveRouting.postures` | `[]` | Subset of `quality`, `balanced`, `latency`, `economy`. | next turn |
| `fleet.adaptiveRouting.agentRoles` | `[]` | Exact `{ agentId, executionRole }` pairs, with `executionRole` one of `builder`, `researcher`, `verifier`, `reviewer`, `judge`. | next turn |
| `fleet.permissions.mode` | `"judge"` | What a worker's permission ask does: `judge` hands a native local worker's ordinary ask to the main session's safety judge while the main session runs at `default`, which grants it once on an allow and denies it otherwise, and runs as `deny` at `yolo`, with the judge off, and on runtimes and placements no judge can answer; `deny` returns a structured denial and the run continues, `fail` ends the run as `permission_required`, `escalate` asks the interactive operator and applies the fallback on timeout, `main` is the opt-in for the main agent to decide asks through its grant broker. `main` reaches native local workers only, and a dispatch that cannot carry a bound grant is refused at admission. Operator-authority asks always go to the operator and are denied with nobody attached. | next turn |
| `fleet.permissions.escalation.timeoutMs` | `120000` | Integer at least 1. How long an escalated ask waits. A key on the card holds it up to 15 minutes from when it opened, or this value when longer. | next turn |
| `fleet.permissions.escalation.fallback` | `"deny"` | `deny` or `fail`, applied when the wait expires or nobody is attached. | next turn |
| `fleet.concurrency` | `"auto"` | `auto` or an integer at least 1. `auto` derives a limit from CPU and memory, up to eight workers. | restart required |
| `fleet.worktrees.root` | `"disk"` | `disk`, `tmpfs`, `auto` (tmpfs when one exists and has room), or an absolute path. Where a `worktree: true` task's working tree is created for local placement. | next turn |
| `fleet.retry.maxRetries` | `2` | Integer at least 0. Automatic retries of a retryable worker outcome. | next turn |
| `fleet.retry.routeCooldownMs` | `15000` | Integer at least 0. How long a failing target, runtime and model route is skipped; `0` disables the wait. | next turn |
| `fleet.retry.breakerThreshold` | `1` | Integer at least 1. Consecutive failures that open a route's breaker. | next turn |
| `fleet.limits.toolCallsPerRun` | `150` | Integer at least 1. The hard tool-call cap for native workers. In advisory mode it lowers a larger recipe maximum but never below the dispatch's admitted `budget.toolCalls`. Claude SDK advisory runs, CLI subprocess workers and ACP peers have no per-tool cap. | next turn |
| `fleet.limits.internalRunTimeoutMs` | `900000` | Integer at least 1. Ceiling for one internal worker run such as the wiki writer or the first project scout. | next turn |
| `fleet.history.maxRuns` | `1000` | Integer at least 1. Finished runs kept in the run ledger; the oldest row and its display feed go first. Telemetry journals follow the separate reference-aware `telemetry prune` policy. | next turn |
| `fleet.history.journal` | `true` | Boolean. Keep each run's display feed and its structural projection in the run journal. | next turn |
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
| `context.compaction.maxTokens` | `200000` | Integer at least 1. Request-size ceiling in tokens that starts compaction whatever the model's window is, and the stand-in window while the serving window is unknown. A model whose input price steps up at a token count lowers it to 98% of that boundary. | hot reload |
| `context.compaction.provider` | `"off"` | `off` or `native`. `native` asks the Codex backend for opaque checkpoints on the `openai-codex` runtime and keeps them under `<stateDir>/provider-checkpoints/`; `off` keeps portable Clio summaries. | hot reload |
| `context.memory.enabled` | `true` | Boolean. Task memory updates. `false` turns proactive memory off, including its model calls. | next turn |
| `context.memory.target` | `null` | Target id for a dedicated memory route. With `target` and `model` both `null`, the memory tier runs on the active chat route (`chat.target` and `chat.model`) and its calls are billed to the chat model. An explicit route wins. | next turn |
| `context.memory.model` | `null` | Wire model id; cleared when `target` is `null`, otherwise defaults to the target's `defaultModel`. | next turn |
| `context.memory.cadenceToolCalls` | `10` | Integer at least 2. Most tool calls between memory updates. | next turn |
| `context.memory.trajectorySteps` | `8` | Integer at least 1. Recent steps considered. | next turn |
| `context.memory.maxOutputTokens` | `2000` | Integer at least 1. Length cap of one memory note. | next turn |
| `context.memory.timeoutMs` | `60000` | Integer at least 1. Wait for the memory model. | next turn |
| `context.memory.observations.enabled` | `false` | Boolean. Prepares source-linked observation notes in the background that a later compaction may use in place of the history they cover. Needs `context.memory.enabled`. | next turn |
| `context.semantic.enabled` | `false` | Boolean. Exposes the optional semantic search capability after model pins are configured. | next turn |
| `context.semantic.target` | `null` | Qualified embedding target id; accepts the llama.cpp embedding or LiteLLM runtime. | next turn |
| `context.semantic.model` | `null` | Exact embedding wire model id. | next semantic request |
| `context.semantic.assetIdentity` | `null` | GGUF SHA-256 or an explicitly unverified operator asset label. | next semantic request |
| `context.semantic.projectorIdentity` | `null` | Multimodal projector SHA-256 or operator label. | next semantic request |
| `context.semantic.canaryFingerprint` | `null` | Fixed text canary fingerprint written by `semantic configure --qualify`. | next semantic request |
| `context.semantic.modalities` | `[text]` | Enabled subset of `text`, `image`, `audio`, and `mixed`. | next semantic request |
| `context.semantic.background` | `false` | Boolean. Schedule bounded refresh at session start and after code map changes. | next session |
| `context.semantic.inboxes` | `[]` | Explicit project or global artifact roots registered with `semantic inbox add`. | next refresh or search |
| `systemOne.use` | `null` | The opt-in: one route or an ordered list of `jev`, `memory`, `main`, a declared engine or a target. A named route answers the `consult` tool, the judge screen and steering triage, so on a hosted route web and MCP result text leaves the machine at judge time. `off` anywhere in the list turns System One off. | restart required |
| `systemOne.engines` | `{}` | Map of engine name to `{ kind, target, model?, profile? }`. An engine does nothing until `systemOne.use` names it. | next turn |
| `safety.autonomy` | `"default"` | `default` or `yolo` (contained unless `safety.yoloConfinement` says otherwise). User layer or operator session control. A project layer can only tighten the user level (`default` over `yolo`); a looser value is ignored with a layer issue. | hot reload |
| `safety.limits.sessionCostUsd` | `5` | Finite number at least 0, in USD; a negative value fails validation. Session cost ceiling. It gates requests on routes priced by target rates or the catalog; see [pricing](configuration-and-targets.md#pricing-and-cost-provenance). `0` means no session ceiling: paid requests are admitted, dispatch plans and Scout continuations carry a ceiling of 0, and fleet previews skip the remaining-budget check. A parked request re-reads the ceiling every 250 ms and dispatch admission reads it per call, so raising it releases a waiting request. | hot reload |
| `safety.limits.chatToolCallsPerTurn` | `60` | Integer at least 1. At the limit Clio stops using tools and summarizes the turn. At `yolo` the turn then continues with a fresh budget. | next turn |
| `safety.limits.readBytesPerCall` | `51200` | Integer at least 1. Most text one file read returns; a read gets at least 1 KB. | next turn |
| `safety.limits.observationBytesPerTurn` | `196608` | Integer at least 1. Combined tool output the model may receive in one turn. While the value stays at this default the pool scales to 1.5 bytes per context-window token, between 192 KiB and 1 MiB; any other value applies exactly. | next turn |
| `safety.limits.workerResponseSeconds` | `600` | Integer at least 1. Host deadline per native worker model response, including locked synthesis rounds. | next turn |
| `safety.limits.autonomousToolCalls` | `600` | Integer at least 0. At `yolo`, contained or unconfined, the main session pauses for the operator after this many tool calls since the operator last spoke; `0` is off. Interactive: Enter continues for another stretch. `clio-coder run` exits 4 with `autonomous-cap`; `run --continue` resumes. A project layer can only tighten it (a positive value at most the user value); anything else is ignored with a layer issue. | hot reload |
| `safety.limits.autonomousMinutes` | `120` | Integer at least 0. As `autonomousToolCalls`, counting minutes of active turn time; idle time between turns does not count. | hot reload |
| `safety.limits.autonomousTokens` | `5000000` | Integer at least 0. As `autonomousToolCalls`, counting main-session model tokens (input, cache reads and writes, and output). | hot reload |
| `safety.review.enabled` | `false` | Boolean. After a mutating turn a read-only reviewer worker checks the changed files. Interactive sessions only. | hot reload |
| `safety.sandbox` | `"auto"` | `auto`, `required` or `off`. OS sandbox for a dispatched worker's bash, `run_script` and verify commands, and for the main session's `bash`, `run_script` and command-running `verify` checks at `default`: with a backend those run contained, writing only to the workspace, the scratch roots (the real `/tmp` included), `~/.cache`, `~/.npm` and the repository's git dirs but not their hooks, `core.hooksPath` directories or config, with credentials, credential variables, secret files and the SSH agent hidden, new Unix sockets refused, and the network on. `required` refuses worker commands without a backend; the main session at `default` then runs uncontained with the default rails. `yolo` runs unsandboxed unless the value is `required`, which runs every command `default` would contain, and every script, in the main-session sandbox, refuses them without a backend, and refuses `unsandboxed: true`. `off` never sandboxes. | next turn |
| `safety.sandboxNetwork` | `false` | Boolean. Let sandboxed worker commands reach the network. Workers holding `web_fetch` get network either way. | next turn |
| `safety.sandboxPassEnv` | `[]` | List of environment variable names a sandboxed command keeps although their names or values look like credentials. Every other credential variable (names carrying `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `AUTH` and similar, the AWS, PyPI, Twine and Vault families, values with embedded URL credentials) is removed before the sandbox starts. User layer only. The main session reads it per contained call; a worker keeps the list it was dispatched with. | hot reload |
| `safety.sandboxUnixSockets` | `"block"` | `block` or `allow`. `block` makes creating a Unix-domain socket fail with `EPERM` in every OS sandbox (a seccomp filter under bubblewrap, profile rules under the unverified Seatbelt), because a socket a contained command reaches, such as tmux's, an X11 display or a daemon's control socket, runs commands outside it. Tools that need a local socket then fail inside the sandbox. `allow` leaves every socket reachable. User layer only. | hot reload |
| `safety.scratchRoots` | `[]` | List of absolute paths the main session's contained commands and its typed `write` and `edit` tools may write at `default` without asking, and where its deletes are judged as deletes inside the workspace; the temp directories (`os.tmpdir()`, which follows `$TMPDIR`, `/tmp` and `/var/tmp`) always count. User layer only: a project layer value is ignored with a layer issue. `/`, `$HOME` or an ancestor of it, a root inside a system tree (`/etc`, `/usr`, `/var`, `/opt`, `/srv`, `/nix`, `/boot`, `/proc`, `/sys`, `/dev`, `/run`, `/private` and the like) other than the temp trees, and `/mnt`, `/media` or `/Volumes` or a mount root directly inside them fail validation. A root that contains the workspace is ignored, and `clio-coder doctor` warns about it. Yolo commands under `safety.sandbox: required` may write these roots too. | hot reload |
| `safety.snapshots` | `"auto"` | `auto` or `off`. `auto` writes a private Git snapshot of the work tree before the main agent's first mutating call of each turn and before every destructive call, delete or git discard, at both autonomy levels; `/rewind` restores files from them. `off` takes none, and the main session at `default` then asks before workspace deletes instead of running them. | hot reload |
| `safety.unattendedAfterSeconds` | `300` | Integer seconds, `0` waits forever. How long a TUI approval card or `ask_user` round waits for the operator before Clio denies the call or answers each question with its recommended option, and the turn continues. User layer only. ACP clients, headless runs and worker escalations are not affected. | hot reload |
| `safety.yoloAccepted` | `false` | Boolean. Set by the one-time card that turns `yolo` on interactively; `false` shows the card at the next activation. User layer only. Headless `--autonomy yolo` and an ACP mode choice count as acceptance and write nothing. | hot reload |
| `safety.yoloConfinement` | `"contained"` | `contained` or `unconfined`. What `yolo` gives up to avoid waiting: `contained` admits as `default` does, with the main-session sandbox, snapshots and the safety judge, and refuses back to the agent a call `default` would ask the operator about; `unconfined` is the skip-permissions yolo. Unconfined takes effect only with `safety.yoloUnconfinedAccepted`. User layer only. | hot reload |
| `safety.yoloUnconfinedAccepted` | `false` | Boolean. Set by the separate card that turns unconfined `yolo` on interactively, or by hand; required on every surface, headless included, for `safety.yoloConfinement: unconfined` to take effect. User layer only. | hot reload |
| `safety.judge.enabled` | `true` | Boolean. At `default`, a model reviews each call that would park for an operator approval against the operator's own messages, then runs it or refuses it with a reason; it also answers worker asks under `fleet.permissions.mode: judge`. `false` sends those asks to the operator, or denies them headless. User layer only, like every `safety.judge` key. | hot reload |
| `safety.judge.target` | `null` | Target id the judge asks; `null` asks the session's chat route. | hot reload |
| `safety.judge.model` | `null` | Model on that target; `null` asks the chat model, or the judge target's default model when a target is set. | hot reload |
| `safety.judge.environment` | `[]` | List of facts about the operator's environment, in their own words, that the judge reads. | hot reload |
| `safety.judge.allow` | `[]` | List of allow rules appended to the judge's defaults. | hot reload |
| `safety.judge.deny` | `[]` | List of block rules appended to the judge's defaults. | hot reload |
| `interface.exitSummary` | `"auto"` | `auto`, `brief`, `standard`, `report` or `off`. `auto` follows `interface.outputDetail` (`compact` gives `brief`, `detailed` gives `report`, otherwise `standard`). `brief` prints the model, total tokens and cost, `standard` the visit's activity and usage, `report` a one-page report, `off` only how to resume. `full` is read as `standard`. Read at the next exit. | hot reload |
| `interface.demo` | `true` | Boolean. Tier-bounded welcome and learning tips; off starts with an identity header. Immediate controls, motion preferences and stream pacing are independent. | hot reload |
| `interface.terminalProgress` | `false` | Boolean. Running-task progress in terminals that show tab or taskbar badges. | next turn |
| `interface.outputDetail` | `"standard"` | `compact`, `standard` or `detailed`, labelled Minimal, Default and Detailed. Governs terminal presentation, not model reasoning. `minimal`, `default` and `verbose` are accepted as synonyms. | hot reload |
| `interface.mode` | `"regular"` | `regular` keeps scrollback; `fullscreen` uses the alternate screen with a sticky composer and footer. | restart required |
| `interface.fullscreenScrollbar` | `"auto"` | `hidden`, `auto` or `always`. | restart required |
| `interface.smoothStreaming` | `"auto"` | `off`, `auto` or `on`. Presentation-only pacing of streamed text and thinking. | hot reload |
| `interface.desktopNotifications` | `false` | Boolean. Content-free alerts when a turn ends, a detached batch settles or an approval parks. Interactive TTY sessions only. | next turn |
| `interface.autoUpdate` | `true` | Boolean. A native-installer install fetches and activates a newer release in the background; running sessions keep their version until restart. A user-writable npm, pnpm, Bun or Volta install on Linux or macOS updates after the session quits, once every session of that install has exited (the wait is bounded at 30 minutes). `false` keeps the update notice and leaves the install to `clio-coder upgrade`. Other layouts only show their upgrade command. | hot reload |
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
| `integrations.git.commitAuthor` | `"auto"` | `auto` or `human`. Who authors an autonomous commit; see [Commit authorship](#commit-authorship). Ignored when `commitAttribution` is `false`. | hot reload |
| `integrations.music.enabled` | `false` | Boolean. Allows `/music` to open cliamp in a Herdr dock. Needs Herdr panes and cliamp. | hot reload |
| `integrations.music.station` | `"http://radio.cliamp.stream/lofi/stream"` | Non-empty string, a stream URL or a station name. What `/music on` plays. | hot reload |
| `integrations.music.agentControl` | `false` | Boolean. Registers the `music` tool at startup so the model can drive the pane; off, the tool does not exist and costs no prompt bytes. | restart required |
| `telemetry.mode` | `"standard"` | `standard` or `research`. What each scope's telemetry journal admits; a project or local layer can only lower it. | next turn |
| `telemetry.research.content` | `false` | Boolean. In research mode with workspace consent, keep prompts, request bodies and background memory and compaction text as telemetry objects. | next turn |
| `telemetry.research.deltas` | `true` | Boolean. In research mode, keep each call's inter-delta gaps as one `call.timing_captured` histogram. | next turn |
| `telemetry.research.providerHeaders` | `true` | Boolean. In research mode, keep allow-listed provider response headers as `provider.headers_captured`. | next turn |
| `telemetry.research.busTrace` | `false` | Boolean. In research mode, journal a `bus.traced` record naming each live event the telemetry hub delivers. | next turn |

`systemOne.*` is experimental and off by default. The [System One guide](system-one.md) describes them, including the engine `profile` field (`generic`, `jev`, `laya`, `laya-multilingual`, `julia-1`, `gliner2.5-small`, `gliner2.5-decide` or `strands-decider`), which has no default. A decision engine's window is the `capabilities.contextWindow` of its `systemone` target (480 when unset), bounded by the profile's ceiling. There is no placement setting: which processor an engine runs on is decided by the server behind its target.

The music keys are documented in the [music guide](music.md). The exit summary is part of [commands and modes](commands-and-modes.md).

### Commit authorship

With `integrations.git.commitAuthor: auto`, a commit Clio Coder makes with nobody attending names Clio as the Git author (`Clio Coder <…clio-coder[bot]@users.noreply.github.com>`). Your configured identity stays the committer and gets a `Co-authored-by:` trailer, so GitHub credits both and nobody is dropped. Clio's own `Assisted-by:` and `Co-authored-by:` lines are left off such a commit because the author field already says it. `Tested-by:`, `Reviewed-by:`, receipt and `Clio-Decision:` trailers are kept.

Autonomous means a dispatched worker or fleet run, the host commits and merges that land a worker's worktree (`fleet land` included), a fleet commit step, a headless `clio-coder run`, and a scheduled job's turn. An interactive TUI or ACP session keeps you as author with Clio's trailers at every autonomy level, as does every commit under `commitAuthor: human`.

You stay author when an explicit `--author` or `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` chose someone else, when Git has no configured `user.name`/`user.email` (so the human co-author cannot be named), for operator hooks and delegated external harnesses, and when a repository uses its own `core.hooksPath` (your hooks run untouched and the commit carries no Clio trailer). Windows behaves like Linux and macOS: a `git.cmd` wrapper serves cmd.exe and PowerShell lookups and the POSIX wrapper serves Git Bash. You also stay author of any commit Git writes without running Clio's message hook when it goes through `git` on `PATH`: an editor or template `git commit`, `git commit-tree`, `git stash`, `git notes` and other plumbing. A git reached another way (an absolute path such as `/usr/bin/git`, or a Git library) sees Clio as author too: a commit through it that runs Clio's hooks credits you as co-author, while plumbing such as `commit-tree` or `stash` keeps Clio as author and you as committer with no trailer. On Windows, a `git` command that cmd.exe or PowerShell resolves to `git.cmd` is a batch file. cmd.exe expands `%NAME%` in its arguments before git sees them, even inside quotes, whenever `NAME` is a set environment variable. So `git add 'file%USERNAME%.txt'`, or a commit message containing `%PATH%`, reaches git with the value substituted, where `git.exe` would have received the text literally. Git Bash and programs that spawn `git.exe` without a shell are not affected. To pass such text literally from cmd.exe or PowerShell, call `git.exe` by name or use `-F <file>` for the message. A cherry-pick keeps the picked commit's author. A revert, including one continued after a conflict, is Clio's with you as co-author. If a process that started in a default-hooks repository commits in one with its own `core.hooksPath`, your hooks run first and you are still added as co-author. With `commitAttribution: false` Clio Coder changes neither author nor message.

This follows the split other agents use: an agent that works on its own authors its commits (Copilot coding agent, Claude Code on the web), while one you drive in your terminal leaves you as author and adds a trailer (Copilot CLI, Claude Code CLI).

### Optional keys with no default

These schema keys are absent from `DEFAULT_SETTINGS` because an unset value selects automatic behavior. Clearing the field removes the override.

| Key | Accepted values and meaning | Effect |
| --- | --- | --- |
| `fleet.default.node` | `local` or a `fleet.nodes[].id`. Accepted and displayed as Default worker location, but placement does not read it. Use `fleet.defaultNode` or `fleet.profiles.<name>.node` to select a node. | next turn |
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

`SETTINGS_V1_RETIRED_PATHS` in [`src/core/config.ts`](../../src/core/config.ts) lists keys removed with no replacement. A retired key never blocks loading, in any layer: the file loads, the key is ignored, `clio-coder doctor` warns that it is retired and ignored and names the reason below, and `clio-coder doctor --fix` removes it from the user `settings.yaml`. A renamed path from the [key map](#version-1-to-version-2-key-map) is different: a user `settings.yaml` that still uses one is refused with a message naming the version-2 path. The v1 migrator drops the version-1 entries and records the reason in its migration report.

| Retired path | Reason |
| --- | --- |
| `identity` | Accepted and ignored. |
| `background.thinkingLevel` | Proactive memory always resolves thinking off. |
| `theme` | The only registered theme was not read by runtime rendering. |
| `compaction.excludeLastTurns` and `context.compaction.excludeLastTurns` | Only the temporary legacy mask used it. Use `context.workingSet.protectLastTurns`. |
| `delegation.agents[].permissionTimeoutMs` and `integrations.externalAgents.entries[].permissionTimeoutMs` | A delegated agent's permission ask is decided at once and never waits for the operator. `integrations.externalAgents.defaults.permissionTimeoutMs` still bounds Clio Coder's own ACP server. |
| `delegation.agents[].labels` and `integrations.externalAgents.entries[].labels` | Nothing read or displayed external agent labels. |
| `fleet.decisionProfiles` | System One replaced decision profiles. Name an engine with `systemOne.use`. An empty `{}` is accepted silently. |
| `turnControl.interpretation` | No harness workflow reads the request before a turn any more. |
| `turnControl.orientation` | The orientation workflow is gone. The main agent dispatches Scout when it wants a tour. |
| `fleet.speculativeDispatch` | Workers are no longer held ahead of a predicted dispatch. |
| `systemOne.sites` | There are no decision sites any more. `systemOne.use` binds one route to the `consult` tool, the judge screen and steering triage. An empty `{}` is accepted silently. |
| `systemOne.engines.<name>.mode` | Every `llm` engine reads as one batch request. |
| `systemOne.cuts` | No build-keyed cut acts any more. An empty `{}` is accepted silently. |
| `interface.panes.enabled` | Bare `clio-coder` always opens its own private pane host when the terminal allows it; `--with-panes` joins an existing host instead. Ignored when present; `clio-coder doctor` names it and `doctor --fix` removes it. |
| `systemOne.record`, `systemOne.retentionDays`, `systemOne.maxMiB` and `telemetry.research.systemOneDataset` | The decision dataset is gone. |

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

### Add an MCP server

To add an MCP server, put its launch declaration in user `<config>/mcp.yaml` or project `.clio-coder/mcp.yaml`, then inspect it with `clio-coder mcp list` and test it with `clio-coder mcp test <id>`. A project or plugin server needs operator trust before it launches.

User MCP declarations are stored at `<config>/mcp.yaml`; project declarations are stored at `.clio-coder/mcp.yaml`. The declaration contract is implemented in [`src/domains/gateway/mcp/config.ts`](../../src/domains/gateway/mcp/config.ts). A server entry accepts `id`, `command`, `args`, `cwd`, `env`, `timeoutMs`, `actionClass`, `toolActionClasses` and `network`; `toolActionClasses` maps individual tool names to `read`, `execute`, `destructive` or `unknown` and overrides the server class for those tools. `network` takes effect only in a user declaration.

### Why is my MCP server untrusted?

An MCP server becomes untrusted when you change its args or other digest-bound fields: the existing trust record is stale. Review the changed declaration, then run `clio-coder mcp trust <id>` to approve it again.

| Declaration | Launch rule |
| --- | --- |
| User scope | Trusted by file ownership; actions still pass through tool policy. Set `actionClass: read` for an operator-reviewed read-only server, or `actionClass: execute` for an executing server. When the server-wide class is omitted, `readOnlyHint: true` supplies `read` and `destructiveHint: true` supplies `destructive`. Other tools remain `unknown`. These are advisory defaults; an explicit server class or per-tool override takes precedence. |
| Project scope | Does not launch until an operator trusts the declaration with `clio-coder mcp trust <id>` or `/mcp trust <id>`. |
| Trust record | User-owned `<config>/mcp-trust.json`, bound to project root, server id, and declaration digest. |
| Changed declaration | Editing command, args, cwd, environment, timeout, or tool action classes makes trust stale; review and trust it again. |
| Entry script | A project server binds every file its launch names inside the project: an absolute `command`, and each argument not shaped like a flag and each value a flag carries after `=`, when it resolves against the server's `cwd` to an existing file in the project. `node --require ./a.cjs ./s.mjs` and `node --require=./a.cjs ./s.mjs` both bind both files. Each bound file's SHA-256 enters the digest, so editing one makes trust stale. A file both spelled and resolved outside the project is skipped and does not stop the scan. A symlink spelled inside the project binds where it points; a target outside the project is bound by path only, so repointing the link makes trust stale and editing the target does not. Nothing else is bound: not modules a bound file imports, a module run with `python -m`, a directory entry, a bin fetched by `npx` or `uvx`, or a file reached through the environment such as `NODE_OPTIONS` or `PATH`. A project server whose bound file cannot be read stays untrusted. `clio-coder mcp list` and `clio-coder mcp trust` print `entry=<path>[, ...]`, or `entry=none` when the trust pins no file. |
| When it is checked | Clio computes the digest and the entry hashes when a session or a fleet worker takes its MCP snapshot. Before each launch or reconnect it computes them again and compares them with that snapshot. A changed declaration or entry file, a removed trust record, or a changed action class or network grant refuses the launch and asks for a new session; a running session never adopts the change. This closes stale snapshots, not the race between hashing a file and running it. `mcp trust` and `mcp untrust` lock and reread `mcp-trust.json`, so a concurrent revocation is never overwritten. |
| Network grant | `network: true` in a user declaration, or `clio-coder mcp trust <id> --network` for a project or plugin server, lets that server's sandboxed process in a fleet worker reach the network. A project or plugin declaration's own `network` field is ignored. The [worker OS sandbox](../architecture/safety-model.md#worker-os-sandbox) states what the grant opens and when a writing worker loses it. |
| Older builds | A Clio build without the network grant or entry binding that shares this config directory drops a record's `network` and `entryScriptHashes` fields whenever it rewrites `mcp-trust.json`, reads every record whose digest binds entry files as stale, and rejects a user `mcp.yaml` that sets `network` as an unknown field. |
| Trust boundary | Trust enables launch; it is not operating-system isolation. Annotations never authorize launching an untrusted server. Calls still pass through turn scope, tool policy and autonomy. |

Only user declarations may set the server-wide `actionClass`; project and plugin declarations receive their default class from the explicit trust record. Every declaration scope accepts operator-approved `toolActionClasses` for individual tools. Once launch trust is established, a per-tool entry overrides the trust-record class in every scope. These entries are covered by the declaration's trust digest, so changing them in a project or plugin declaration requires re-approval. Set a server-wide class for the most powerful tool it exposes, or use per-tool entries. A reviewed read-only literature-search server can use `actionClass: read` to run in a headless session. Under `run --read-only`, the server's own `readOnlyHint` does not authorize a call; the read class must come from Clio's built-in classification or the operator.

`clio-coder mcp list` includes recorded per-tool action classes. Use `clio-coder mcp list --refresh` to connect trusted servers, read their current annotations and update the catalogs. Cached hints are advisory and are combined with the current operator declarations when listed. When no per-tool override applies, project trust records remain authoritative, including an `unknown` class.

In a session, a server's `notifications/tools/list_changed` marks its catalog stale, and the next discovery or call through that server lists its tools again. A gateway refresh of a connected server lists them again too. Listings run one at a time per server and replace the registered tools. A call whose tool's live metadata changed since the model saw it is refused and asks the model to describe the capability and retry.

Clio connects to each server by first sending `server/discover`. A server that lists MCP `2026-07-28` is spoken to in that revision, with the protocol version, client identity and capabilities in every request's `_meta`. A server that answers that it does not support MCP `2026-07-28` is refused, and the error names the versions it supports. Any other answer falls back to the `initialize` handshake at `2025-06-18`, which serves such servers as before. A server still silent after one second is also sent the handshake, and whichever request it answers first decides. On a `2026-07-28` server, `tools/call` and the `tasks/*` requests declare the MCP Tasks extension (`io.modelcontextprotocol/tasks`), so a server may answer a call with a task instead of a result. Clio then polls `tasks/get` at the server's `pollIntervalMs` (1 second when the server names none, and never faster than every 10 ms) until the task completes, fails or is cancelled, and returns the final result as that one call's result. Polling shares the call's timeout and the turn's interruption. A timeout, an interruption, a task that outlives its `ttlMs`, or a task that asks for input (elicitation or sampling, which Clio does not provide) sends `tasks/cancel`. Clio does not subscribe to task status notifications.

Interrupting an MCP call sends `notifications/cancelled` with its request id, or `tasks/cancel` for a task. Clio checks responsiveness with a bounded `ping` (`server/discover` on a `2026-07-28` server, which has no `ping`) or the `tasks/cancel` acknowledgement, retains responsive connections, and tears down unresponsive connections. The next gateway call lazily reconnects the same trusted declaration after cleanup. Clio never automatically replays the cancelled call. Read-only, idempotent tools may repeat identical polling arguments within the turn's tool-call budget.

The `2026-07-28` client is new in 0.7.0. Its timeout path has been run against a live clio-kit web server: on a fetch held open past the call's timeout, the server acknowledged `tasks/cancel`, reported the task `cancelled` and closed its upstream connection, and the model received the timeout error. The interruption, `ttlMs` and input-request paths are exercised against a fake test server only.

Trust and declaration loading are implemented in [`src/domains/gateway/mcp/trust.ts`](../../src/domains/gateway/mcp/trust.ts). The model-facing discovery and call contract is in [gateway tool usage](tool-usage.md).

## Let Clio Coder propose settings changes

Ask Clio to set itself up: add a target, change the chat model, route workers, or adjust the display. Clio reads its live settings, targets and `clio-coder doctor`, discovers `configure_clio` through the gateway and previews one saved change as an exact diff. Eligible paths are the chat route, model picker and request knobs, `fleet.default.*`, fleet profiles, agent bindings, rosters, concurrency, limits and retry, the memory route, the `interface` display settings, and `targets.<id>` with its runtime, URL, models, gateway flag, capabilities and the *name* of the API-key environment variable. Safety, permissions, autonomy, trust, integrations, telemetry, keybindings and credentials are never eligible, and any other path is refused and points at `/settings` or `configure`. The full contract is in [configure_clio](tool-usage.md#configureclio-propose-clio-settings-and-targets-with-an-approved-diff).

In an attended `default` session, applying shows you the exact diff on an approval card that only you answer; nothing is saved until you approve. The save goes through the settings writer and is logged to `<state>/settings-changes.jsonl`. In a headless `clio-coder run`, a `--read-only` run, or at `yolo`, Clio only proposes: it shows the diff and the steps you run (`/settings`, `clio-coder configure --edit`, or the `clio-coder configure --id ...` command for a target). Clio never stores an API key; you store it with `clio-coder auth login`, and a model shell call that runs Clio's own settings, credential or trust commands is blocked at every autonomy level. A persistent fleet routing proposal names the alternative for a one-off run: pin the dispatch call's `target` and `model` instead of saving routing. Applying checks that the saved value still matches the preview; a proposal expires after 10 minutes, and expired or stale proposals need a fresh preview. The running session keeps its current routing, so run `/restart` (it saves and restarts into this session and workspace) or start a new Clio Coder session to use a newly saved route. `/reload [settings|library|extensions|all]` re-reads those resources and reports what changed and what still needs a new session. Other settings take effect as the save result says: live settings pick up automatically, next-turn settings apply to the next request or dispatch, and restart-required settings need a new session.

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
| `--yes`, `-y` | For `context reset`, answer the confirmations without prompting; without a terminal the reset needs it. |
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
| `context.scope` | policy | workspace, settings, skills, recall, budget, or semantic. `budget` inspects the live request budget and accepts no other argument. `semantic` requires `query` and configured semantic search; see [semantic context](semantic-context.md). |
| `context.offset` | policy | Zero-based settings, recall discovery or skills offset; follow nextOffset. |
