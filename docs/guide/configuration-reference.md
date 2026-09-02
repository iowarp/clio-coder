# Configuration reference

> **Visual blueprint:** The source checkout includes the complete
> [Configuration reference visual reference](https://github.com/iowarp/clio-coder/blob/main/docs/html/configuration_reference_blueprint.html).

Every switch that changes what Clio Coder does, in one place: settings keys, environment variables, CLI flags, project files under `.clio-coder/`, recipe and prompt-fragment frontmatter, tool arguments the model can send, and model knowledge-base tags. The source of truth is `src/`; this page is the audited inventory of what the code read at the 0.4.2 cut and is maintained by hand with each release. The narrative guide is [configuration-and-targets.md](configuration-and-targets.md); operator prose for each environment variable is in [environment-variables.md](environment-variables.md).

Precedence, where several surfaces set the same value: a one-run CLI flag beats a session override (`/settings`, `/model`, `/thinking`), which beats `.clio-coder/settings.local.yaml`, which beats `.clio-coder/settings.yaml`, which beats the user `settings.yaml`, which beats the compiled default. Entries whose order differs say so in their precedence column.


## Settings keys

`settings.yaml` (user, project, and project-local) and the `/settings` overlay. Defaults come from `src/core/defaults.ts`.


| Name | Default | Controls | Precedence |
|---|---|---|---|
| `chat.maxOutputTokens` | `0` | Global output-token budget requested on every chat turn (integer >= 0, `0` means per-model caps only); clamped to the model's max-output cap and remaining context window, with the product's 32,768-token ceiling used when the model cap is unknown; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.model` | `null` | Saved default chat model id (string or null); null with a target set rebases to that target's `defaultModel` at validation; applies next session. | `run --model` > session routing (`/model`, `/thinking`, Alt+J/K, `/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.modelPicker.cycleSet` | `[]` | Exact `target` or `target/model` refs Alt+J/Alt+K cycle through (refs with an empty target part are dropped); session-owned routing state, immediate this session, saved default next session. | session routing (Alt+J/K, `/settings`) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.modelPicker.favorites` | `[]` | Exact `target/model` refs pinned in the focused model picker; refs naming an unconfigured target are dropped at validation; applies immediately. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.modelPicker.recentLimit` | `12` | How many recently selected `target/model` refs `recent-models.json` keeps (integer >= 1); applies immediately. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.prewarm` | `true` | Whether the known prompt prefix is sent to a `local-native` server at session start, after resume, and after compaction to fill its prefix cache (boolean; no effect on other tiers, workers, headless); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.retry.baseDelayMs` | `2000` | First backoff delay in ms for chat-loop retries, doubled per attempt up to `maxDelayMs` (integer >= 0); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.retry.enabled` | `true` | Master switch for transient-provider retries in the interactive chat loop (boolean); dispatched workers use `fleet.retry.maxRetries` instead; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.retry.maxDelayMs` | `60000` | Ceiling in ms on the exponential backoff between chat-loop retries (integer >= 0); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.retry.maxRetries` | `3` | Maximum retry attempts for one transient provider failure in the chat loop (integer >= 0); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.retry.streamStallMs` | `180000` | Silence on an in-flight stream longer than this many ms is treated as a wedged backend and the turn is aborted and retried (integer >= 0, `0` disables the stall timer); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.target` | `null` | Saved default chat target id (configured id or null); a dangling id normalizes to null and clears `chat.model`; seeds session routing at launch, so applies next session. | `run --target` > session routing (`/model`, `/thinking`, Alt+J/K, `/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `chat.thinkingLevel` | `low` | Saved default reasoning effort for the chat model: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, clamped to what the model supports at request time; applies next session. | `run --thinking` > session routing (`/model`, `/thinking`, Alt+J/K, `/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.compaction.auto` | `true` | Master switch for the pre-request compaction trigger when context pressure crosses `threshold` (boolean); manual `/context compact` still works when off; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.compaction.model` |  | Optional `provider/model` pattern resolved for the summary model when compaction runs; absent means the chat target summarizes; applies next turn. |  |
| `context.compaction.systemPrompt` |  | Optional path to a prompt-override file read at compaction time to replace the built-in summary prompt; applies next turn. |  |
| `context.compaction.threshold` | `0.8` | Context pressure (estimated tokens over the context window, 0 through 1) at which eviction and then LLM summary compaction run; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.toolResultMaxBytes` | `65536` | Maximum bytes returned from one tool result before the complete text spills to the session scratch file (integer >= 4096); applies to the next tool result. The unchanged `safety.limits.observationBytesPerTurn` default is 196608 bytes, so three full-size results consume the shared pool and a fourth finds it filled. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.cadenceToolCalls` | `10` | Tool calls between proactive memory interventions inside a turn (integer >= 2); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.enabled` | `true` | Master switch for proactive memory intervention during a turn (boolean); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.maxOutputTokens` | `2000` | Output-token cap for one memory model call (integer >= 1); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.model` | `null` | Model id for the background memory model (string or null); null rebases to the target's `defaultModel`; session routing state, applies next turn. | session routing (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.target` | `null` | Target id for the background memory model (configured id or null); null means deterministic rules-only memory; session routing state, applies next turn. | session routing (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.timeoutMs` | `60000` | Timeout in ms for one memory model call (integer >= 1); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.memory.trajectorySteps` | `8` | Recent trajectory steps handed to the memory model per intervention (integer >= 1); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.workingSet.enabled` | `true` | Master switch for working-set eviction of stale tool results and thinking before summary compaction (boolean); off goes straight to summary compaction; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.workingSet.minEvictableTokens` | `200` | Tool results estimated below this many tokens are never evicted because the marker would cost more than it saves (integer >= 0); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.workingSet.policy` | `structural-v1` | Eviction candidate rule set: `structural-v1` or `age-horizon`; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.workingSet.protectLastTurns` | `6` | Most recent user turns whose observations are never evicted (integer >= 1); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `context.workingSet.target` | `0.6` | Used/window ratio an applied eviction batch reduces context to (number > 0 and < 1); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.adaptiveRouting.agentRoles` | `[]` | Exact `{agentId, executionRole}` pairs for which an `agent: auto` request may swap agents (no cross-product, `auto` reserved, duplicate pairs rejected); applies next dispatch. |  |
| `fleet.adaptiveRouting.agentRoles[].agentId` |  | Native agent id the pair authorizes for automatic agent selection; required, `auto` is reserved. |  |
| `fleet.adaptiveRouting.agentRoles[].executionRole` |  | Execution role of the pair: `builder`, `researcher`, `verifier`, `reviewer`, `judge`; required. |  |
| `fleet.adaptiveRouting.postures` | `[]` | Requested postures (`quality`, `balanced`, `latency`, `economy`) for which joint routing is active; both the role and the posture must be listed; applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.adaptiveRouting.roles` | `[]` | Execution roles (`researcher`, `verifier`, `reviewer`, `judge`) for which measured joint routing may change execution; unlisted roles only record a shadow recommendation; applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.agentProfiles` | `{}` | Map of native agent id to a `fleet.profiles` name so that agent's dispatches use that route (`auto` is reserved; ACP agents cannot be bound); applies next dispatch. | `run --target` > `run --agent-profile` > session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.agentProfiles.<key>` |  | One binding: the key is the native agent id, the value the `fleet.profiles` name used when that agent is dispatched without an explicit profile; applies next dispatch. |  |
| `fleet.concurrency` | `auto` | Maximum concurrently running local workers: `auto` currently resolves to the compiled default of 4, or set an integer >= 1; applies at restart. |  |
| `fleet.default.model` | `null` | Saved default model id for workers (string or null; null rebases to the target's `defaultModel`); applies next session. | `run --model` > selected `fleet.profiles` route model > session routing (`/settings`) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.default.target` | `null` | Saved default target id for dispatched workers and `/run` (configured id or null; dangling ids become null); seeds session routing, so applies next session. | `run --target` > `run --agent-profile`/`--agent-runtime` > `fleet.agentProfiles` binding to a `fleet.profiles` route > session routing (`/settings`) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.default.thinkingLevel` | `off` | Saved default thinking level for workers (`off` through `max`); applies next session. | `run --thinking` > selected `fleet.profiles` route thinkingLevel > session routing (`/settings`) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.history.journal` | `true` | Whether each dispatched run writes an `events.ndjson` journal under the state `runs/` directory (boolean); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.history.maxRuns` | `1000` | Retention cap on the durable dispatch run ledger (integer >= 1); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.limits.internalRunTimeoutMs` | `900000` | Wall-clock cap in ms for one internal generator dispatch such as the wiki documenter or the bootstrap scout (integer >= 1); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.limits.toolCallsPerRun` | `150` | Lifetime cap on admitted tool calls for one dispatched worker (integer >= 1); a recipe budget can only narrow it; read from effective settings at dispatch, so applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.nodes` | `[]` | SSH-reachable worker nodes (the implicit `local` node is never listed); a node becomes dispatch-eligible only after the doctor fleet preflight passes; applies next dispatch. |  |
| `fleet.nodes[].clioCoderEntry` | `clio-coder worker` | Remote worker-entry invocation run after `cd <projectRoot>`; also version-probed by the fleet preflight; defaults to `clio-coder worker` on the remote PATH. |  |
| `fleet.nodes[].host` |  | SSH destination host (name or address); required. |  |
| `fleet.nodes[].id` |  | Stable node id used in placement, receipts, and operator surfaces; required, `local` is reserved, duplicates are rejected. |  |
| `fleet.nodes[].identityFile` |  | Private key path passed as `ssh -i`; absent defers to the SSH config. |  |
| `fleet.nodes[].labels` |  | Advisory routing labels (e.g. `gpu`, `high-memory`) exported to the worker as `CLIO_CODER_WORKER_LABELS` and shown in fleet status; no scheduler constraint. |  |
| `fleet.nodes[].maxWorkers` | `2` | Per-node cap on concurrent workers (integer >= 1); defaults to 2 when absent. |  |
| `fleet.nodes[].port` |  | SSH port passed as `ssh -p` (integer >= 1); absent omits the flag and defers to the SSH config. |  |
| `fleet.nodes[].residency` | `observe` | Residency posture projected into the remote worker target lifecycle: `observe` (default) sets `user-managed`; `manage` sets `clio-coder-managed` unless the target already says `user-managed`. |  |
| `fleet.nodes[].user` |  | SSH login user passed as `ssh -l`; absent defers to the SSH config. |  |
| `fleet.permissions.escalation.fallback` | `deny` | Posture applied when an escalated call times out or no operator channel exists: `deny` or `fail`; applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.permissions.escalation.timeoutMs` | `120000` | Wall-clock ms a parked `escalate` call waits for an operator decision before the fallback applies (integer >= 1); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.permissions.mode` | `deny` | What a noninteractive worker does with a tool call that asks for permission: `deny` returns a structured denial, `fail` ends the run (exit 3), `escalate` parks it for the operator; applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.profiles` | `{}` | Named worker routes (`target`, `model`, `thinkingLevel`, `node` pin) picked by `run --agent-profile`, `fleet.agentProfiles`, or dispatch `workerProfile`; a null or unknown target drops the profile; applies next dispatch. | `run --target` (profile ignored) > `run --agent-profile`/`--agent-runtime` > `fleet.agentProfiles` binding > session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.profiles.<key>.model` |  | Model id for the profile (string or null); null rebases to the target's `defaultModel` at validation; applies next dispatch. |  |
| `fleet.profiles.<key>.node` |  | Optional fleet node pin (`local` or a `fleet.nodes[].id`; unknown ids are dropped): workers routed through this profile are placed on that node unless a failover excluded it; applies next dispatch. |  |
| `fleet.profiles.<key>.target` |  | Configured target id the profile routes workers to; effectively required, because a profile whose target is null or unknown is dropped at validation; applies next dispatch. |  |
| `fleet.profiles.<key>.thinkingLevel` | `off` | Thinking level for workers routed through this profile (`off` through `max`); `off` when absent; applies next dispatch. |  |
| `fleet.retry.maxRetries` | `2` | Automated retries for retryable fleet run failures (integer >= 0, `0` disables retries); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.retry.routeCooldownMs` | `15000` | Cooldown in ms before a failed route is eligible again for retry placement (integer >= 0); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `fleet.rosters` | `{}` | Named councils for `/council` and roster dispatch: map of roster name to `members` (2 to 5 entries with unique labels and configured targets); a roster with any invalid member is dropped; applies next dispatch. |  |
| `fleet.rosters.<key>.members[].color` |  | Optional display color for the member: a theme color name (`accent`, `success`, `warning`, `error`, ...) or a 6-digit hex `#rrggbb`; absent takes the accent color. |  |
| `fleet.rosters.<key>.members[].label` |  | Council member label shown in council output, matching `[a-z][a-z0-9_-]{0,31}` and unique within the roster; required. |  |
| `fleet.rosters.<key>.members[].model` |  | Optional model id for this member; absent means the target's default model. |  |
| `fleet.rosters.<key>.members[].target` |  | Configured target id the council member runs on; required, and an unknown id is a validation error. |  |
| `fleet.rosters.<key>.members[].thinkingLevel` |  | Optional thinking level for this member (`off` through `max`); absent means the dispatch default. |  |
| `integrations.externalAgents.defaults.connectTimeoutMs` | `30000` | Default ms an ACP agent has to answer `initialize` (integer >= 1, at most the max timer delay); never zero-disabled; applies next dispatch. |  |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | `120000` | Default ms an ACP permission request may wait for an operator (integer >= 1); applies next dispatch. |  |
| `integrations.externalAgents.defaults.toolGovernance` | `clio-coder-policy` | Default governance for ACP agents without their own: `clio-coder-policy`, `agent-managed`, `deny-all` (legacy `clio-policy` is normalized with a warning); applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.externalAgents.defaults.turnTimeoutMs` | `300000` | Default ms one ACP turn may take before it is cancelled (integer >= 1); applies next dispatch. |  |
| `integrations.externalAgents.entries` | `[]` | ACP delegation agents for `/delegate` and dispatch: list of stdio agent definitions with unique ids (`auto` reserved), each inheriting `defaults.*` where unset; applies next dispatch. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.externalAgents.entries[].args` | `[]` | Argument list for the ACP stdio command (list of strings, duplicates dropped); empty when absent. |  |
| `integrations.externalAgents.entries[].command` |  | ACP stdio command spawned for the agent (newline-delimited JSON-RPC per ACP v1); required. |  |
| `integrations.externalAgents.entries[].connectTimeoutMs` |  | Per-agent ms allowed for ACP `initialize` (integer 1 through the max timer delay); absent inherits `defaults.connectTimeoutMs`. |  |
| `integrations.externalAgents.entries[].cwd` |  | Working directory the ACP agent process starts in; absent uses the dispatch working directory. |  |
| `integrations.externalAgents.entries[].env.<key>` |  | Extra environment variable passed to the ACP agent process (string values only); absent inherits the dispatch environment. |  |
| `integrations.externalAgents.entries[].id` |  | Stable id used by `/delegate`, `fleet` routing checks, and dispatch receipts; required, unique, `auto` is reserved. |  |
| `integrations.externalAgents.entries[].labels.<key>` |  | Free-form string label shown on the agent's row in `/agents`; no routing effect. |  |
| `integrations.externalAgents.entries[].permissionTimeoutMs` |  | Per-agent ms an ACP permission request may wait for an operator (integer >= 1); absent inherits `defaults.permissionTimeoutMs`. |  |
| `integrations.externalAgents.entries[].projectContext` | `none` | Project context sent to this agent as a dynamic message: `none` (default; repo conventions never leave the machine) or `bounded` (the bounded projection). |  |
| `integrations.externalAgents.entries[].stallTimeoutMs` | `300000` | Event-inactivity stall window in ms: when no `session/update` arrives for this long the reconciler cancels the turn and finalizes the run as stalled; `<= 0` disables; 300000 when absent. |  |
| `integrations.externalAgents.entries[].toolGovernance` |  | Who governs the agent's tool calls: `clio-coder-policy` (Clio's autonomy matrix), `agent-managed`, `deny-all`; absent inherits `defaults.toolGovernance`; `agent-managed` refuses `run --autonomy`. |  |
| `integrations.externalAgents.entries[].turnTimeoutMs` |  | Per-agent ms one ACP turn may take before cancellation (integer >= 1); absent inherits `defaults.turnTimeoutMs`. |  |
| `integrations.git.commitAttribution` | `true` | Evidence-aware role trailers on commits created through Clio (boolean); applies immediately for subsequent commits. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.library.catalog` | `null` | Path of the private resource-library catalog (string or null); null means `<configDir>/library.yaml`; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.library.confirmedRemote` | `null` | Remote URL written by `clio-coder library remote confirm <url>`; must equal `remote` before sync or push may run (string or null); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.library.remote` | `null` | Git remote URL of the library repository (string or null); the catalog repository must name that remote `library`; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.library.sync` | `false` | Whether `library sync` and `library push` may spawn Git at all (boolean); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.projectResources.trustProjectImports` | `false` | Whether project-scope skills and prompts from other agents' compat roots become model-visible (boolean); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `integrations.runtimePlugins` | `[]` | npm package names loaded as provider runtime plugins at boot (list of strings); applies at restart. |  |
| `interface.desktopNotifications` | `false` | Content-free desktop notifications on turn end, detached batch settlement, and a parked approval, interactive TTY runs only (boolean); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.fullscreenScrollbar` | `auto` | Fullscreen transcript scrollbar visibility: `hidden`, `auto`, `always`; applies at restart. |  |
| `interface.keybindings` | `{}` | Map of binding id (`clio-coder.*`; legacy `clio.*` ids are renamed) to a key string or list of key strings; invalid bindings are reported at boot; applies immediately. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.keybindings.<key>` |  | One rebinding: the key is a binding id such as `clio-coder.notifications.dismiss`, the value a key string or a list of alternatives; applies immediately. |  |
| `interface.mode` | `regular` | Renderer: `regular` keeps scrollback, `fullscreen` uses the alternate screen with a sticky layout; applies at restart. |  |
| `interface.outputDetail` | `default` | Transcript detail level: `minimal`, `default`, `verbose`; applies next turn. | session override (`/output`, `/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.enabled` | `off` | Pane-host rung: `auto` detects a guest pane host, `embedded` asks Clio to own a session (behaves as `auto` until implemented), `off` skips detection; applies at restart. | `--no-panes` / `--with-panes` (`--with-panes` keeps a saved `embedded`, otherwise `auto`) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.files.enabled` | `false` | Whether the files pane (yazi) may open (boolean); applies on the next files-pane open. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.files.followCwd` | `true` | Whether the files pane follows the conversation's working directory (boolean); applies on the next files-pane open. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.files.mode` | `companion` | Files pane mode: `companion` (picks flow back to the prompt) or `chooser`; applies on the next files-pane open. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.files.profile` | `managed` | Yazi configuration profile for the files pane: `managed` (Clio-owned) or `user`; applies on the next files-pane open. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.files.ratio` | `0.3` | Share of terminal height the files dock takes (number 0.05 through 0.5); applies at restart. |  |
| `interface.panes.layout` | `off` | Docks composed at interactive boot in guest mode: `off` opens nothing, `workers` opens the workers dock, `cockpit` opens workers and files; applies at restart. |  |
| `interface.panes.notifications` | `failures` | Which terminal run states raise a pane-host toast: `failures`, `all`, `off`; applies immediately. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.panes.workers.ratio` | `0.34` | Share of terminal width the workers dock takes (number 0.05 through 0.5); applies at restart. |  |
| `interface.smoothStreaming` | `off` | Presentation-only pacing of streamed assistant text and thinking: `off`, `auto` (TTY heuristics), `on`; applies immediately. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `interface.terminalProgress` | `false` | Whether terminal progress (OSC progress) is emitted while a turn runs (boolean); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.autonomy` | `auto-edit` | Baseline autonomy for tool admission: `read-only`, `suggest`, `auto-edit`, `full-auto`; applies immediately (an ACP session's own autonomy wins inside that session). | `run --autonomy` (stored as the session override `safety.autonomy`) > session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.limits.chatToolCallsPerTurn` | `60` | Soft per-turn tool-call budget for the chat agent (integer >= 1); crossing it blocks further calls with a stop-and-summarize directive, the hard ceiling sits 15 above; applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.limits.observationBytesPerTurn` | `196608` | Shared per-turn byte pool across all observation-producing tools (integer >= 1); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.limits.readBytesPerCall` | `51200` | Per-call byte cap for the read tool (integer >= 1; the tool clamps to a 1024-byte floor); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.limits.sessionCostUsd` | `5` | Session spend ceiling in USD enforced by the scheduling budget (number >= 0); applies next turn. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.review.cadenceToolCalls` |  | Also fire the watchdog review every this many tool calls inside a turn (integer of at least 2); absent means turn end only; applies next turn. |  |
| `safety.review.enabled` | `false` | Opt-in turn-end review watchdog that dispatches a worker run after each mutating turn (boolean); applies immediately. | session override (`/settings` apply-this-session) > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user settings.yaml > default |
| `safety.review.target` |  | Target id the turn-end watchdog review run is dispatched to when `safety.review.enabled` is true; absent means the session's active target; applies next dispatch. |  |
| `targets` | `[]` | Configured inference endpoints: a list of target descriptors with unique ids and registered runtime ids; a higher layer's list replaces the whole list; catalog applies next turn, saved routing next session. |  |
| `targets[].auth.apiKeyEnvVar` |  | Environment variable read at call time for the API key (set by `--api-key-env`); the whole `auth` block is stripped from project layers. |  |
| `targets[].auth.apiKeyRef` |  | Name of a stored credential in `credentials.yaml` that supplies the API key. |  |
| `targets[].auth.headers.<key>` |  | Extra HTTP header sent on every request to this target (string map); stripped from project layers as a credential. |  |
| `targets[].auth.oauthProfile` |  | OAuth profile name in `credentials.yaml` used for token minting and refresh on OAuth runtimes. |  |
| `targets[].capabilities.audio` |  | Capability override: audio input support (boolean); shown in target details and badges only. |  |
| `targets[].capabilities.chat` |  | Capability override: whether the model serves chat completions (boolean); overrides probe and catalog values. |  |
| `targets[].capabilities.contextWindow` |  | Capability override for the context window in tokens (integer >= 0), reported with provenance `configured`; set with `configure --context-window`. |  |
| `targets[].capabilities.embeddings` |  | Capability override: embeddings endpoint support (boolean); shown as the `E` badge. |  |
| `targets[].capabilities.fim` |  | Capability override: fill-in-the-middle completion support (boolean); shown as the `F` badge. |  |
| `targets[].capabilities.maxTokens` |  | Capability override for the model's max output tokens (integer >= 0); `chat.maxOutputTokens` is clamped to it; set with `configure --max-tokens`. |  |
| `targets[].capabilities.reasoning` |  | Capability override: whether the model supports thinking (boolean); false pins the available thinking levels to `off`. |  |
| `targets[].capabilities.rerank` |  | Capability override: rerank endpoint support (boolean); shown as the `K` badge. |  |
| `targets[].capabilities.structuredOutputs` |  | Capability override for structured output mode: `json-schema`, `gbnf`, `xgrammar`, `none`; read by the worker runtime for schema-locked outputs. |  |
| `targets[].capabilities.thinkingFormat` |  | Capability override for how thinking is requested: `qwen-chat-template`, `openrouter`, `zai`, `anthropic-extended`, `deepseek-r1`, `openai-codex`, `harmony`; also narrows the offered thinking levels. |  |
| `targets[].capabilities.toolCallFormat` |  | Capability override for the tool-call wire format: `openai`, `anthropic`, `hermes`, `llama3-json`, `mistral`, `qwen`, `xml`; carried into the worker spec model capabilities. |  |
| `targets[].capabilities.tools` |  | Capability override: whether the model supports tool calling (boolean); false excludes it from tool-requiring dispatch. |  |
| `targets[].capabilities.vision` |  | Capability override: image input support (boolean); drives the catalog input modalities and picker badges. |  |
| `targets[].defaultModel` |  | Default wire model id for the target; absent takes the first `wireModels` entry; routing keys with a null model rebase onto it; must be an id the server advertises unless `--force`. |  |
| `targets[].gateway` |  | Marks the target as a gateway (boolean, set by `configure --gateway`); carried into runtime metadata and shown as a `gateway` badge by `clio-coder targets`; no runtime behavior keys on it. |  |
| `targets[].id` |  | Stable user-facing target id referenced by routing keys, profiles, rosters, and CLI commands; required and unique. |  |
| `targets[].lifecycle` |  | Residency policy: `user-managed` makes Clio observe-only on this target (never load or unload models), `clio-coder-managed` (legacy `clio-managed`) opts in; absent means managed. | .clio-coder/settings.local.yaml > .clio-coder/settings.yaml > user settings.yaml > default (managed); SSH node `residency: observe` narrows the remote WorkerSpec to `user-managed`, while an explicit target `user-managed` also wins over node `manage` |
| `targets[].lmstudio.load.contextLength` |  | LM Studio `context_length` sent on `POST /api/v1/models/load` when the model is not resident (integer >= 1); leave `lmstudio.load` absent to keep just-in-time loading. |  |
| `targets[].lmstudio.load.evalBatchSize` |  | LM Studio `eval_batch_size` load field (integer >= 1); sent only when set. |  |
| `targets[].lmstudio.load.flashAttention` |  | LM Studio `flash_attention` load field (boolean); sent only when set. |  |
| `targets[].lmstudio.load.numExperts` |  | LM Studio `num_experts` load field for MoE models (integer >= 1); sent only when set. |  |
| `targets[].lmstudio.load.offloadKvCacheToGpu` |  | LM Studio `offload_kv_cache_to_gpu` load field (boolean); sent only when set. |  |
| `targets[].lmstudio.request.draftModel` |  | Sends `draft_model` on OpenAI-compatible chat requests for speculative decoding (model id string). |  |
| `targets[].lmstudio.request.reasoning` |  | How `reasoning_effort` is sent: `auto` maps the active thinking level, `off` sends `none`, `on` sends `low`, `low`/`medium`/`high` are literal but clamped to the efforts the model advertises. |  |
| `targets[].lmstudio.request.ttlSeconds` |  | Sends `ttl` on chat requests so LM Studio auto-evicts the model after this idle time in seconds (integer >= 1). |  |
| `targets[].maxConcurrentRequests` |  | Explicit request-slot limit for this inference endpoint (integer >= 1); overrides live slot discovery and is shared by every target on the same normalized URL; applies next turn. |  |
| `targets[].pricing.cacheRead` | `0` | USD rate for cache-read tokens (number >= 0); 0 when absent. |  |
| `targets[].pricing.cacheWrite` | `0` | USD rate for cache-write tokens (number >= 0); 0 when absent. |  |
| `targets[].pricing.input` |  | USD rate per input token unit used for cost accounting when set, taking precedence over catalog pricing (number >= 0); required together with `output`. |  |
| `targets[].pricing.output` |  | USD rate per output token unit for cost accounting (number >= 0); required together with `input`. |  |
| `targets[].runtime` |  | Runtime descriptor id such as `lmstudio`, `llamacpp`, `openai-compat`, `anthropic`, `claude-sdk` (aliases like `lmstudio-native` are accepted); required. |  |
| `targets[].url` |  | Base URL for HTTP runtimes, the server root or its `/v1` mount; absent uses the runtime's default URL. |  |
| `targets[].wireModels` |  | Wire model ids the target advertises for routing and the picker (list of strings, deduplicated); merged with probe and catalog discovery. |  |
| `version` | `2` | Schema version of the settings document; must be the integer `2` (a version-1 document is refused with a `clio-coder upgrade` hint); applies at restart. |  |

## Environment variables

Read from the process environment at boot unless the row says otherwise.


| Name | Default | Controls | Precedence |
|---|---|---|---|
| `AI_AGENT` | `unset` | Clio exports `clio-coder` into every child it spawns (bash tool, workers, code steps, hooks) so child tooling can identify the launching agent; Clio itself only checks it inside the managed git hook. |  |
| `APPDATA` | `~\AppData\Roaming` | Windows-only base directory for the config and data roots (`%APPDATA%\clio-coder\config`, `%APPDATA%\clio-coder\data`); ignored on other platforms. |  |
| `CI` | `unset` | Any non-empty value marks a CI run and makes smooth-streaming `auto` fall back to the immediate coalescer instead of paced animation; explicit `on` is unaffected. |  |
| `CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS` | `unset (disabled)` | Exactly `1` lets a `full-auto` dispatch to the claude-code or antigravity-code subprocess runtime pass their dangerous skip-permissions flag; any other value keeps the bypass closed. |  |
| `CLIO_CODER_BIN_DIR` | `~/.local/bin` | Directory holding the `clio-coder` launcher symlink that uninstall removes and the install script creates; a path, defaulting to `~/.local/bin`. |  |
| `CLIO_CODER_BUS_TRACE` | `unset (disabled)` | Exactly `1` subscribes a tracer to the shutdown, session-end, and domain lifecycle bus channels and writes one `[clio-coder:bus]` line per event to stderr. |  |
| `CLIO_CODER_CACHE_DIR` | `platform default (`$XDG_CACHE_HOME/clio-coder`, else `~/.cache/clio-coder`)` | Absolute path for the cache root; beats `CLIO_CODER_HOME/cache` and the platform default, and the fleet-view pane child re-pins it from argv. | env > `CLIO_CODER_HOME/cache` > `XDG_CACHE_HOME` or platform default |
| `CLIO_CODER_COMMIT_ASSISTED` | `unset` | Set by Clio to `1`/`0` per spawn from the run's attribution evidence; the managed `prepare-commit-msg` hook reads it to append the assisted trailer, and nested seams strip it. |  |
| `CLIO_CODER_COMMIT_AUTHORED` | `unset` | Set by Clio to `1`/`0` per spawn from the run's attribution evidence; the managed `prepare-commit-msg` hook reads `1` to add the co-authored trailer, and nested seams strip it. |  |
| `CLIO_CODER_CONFIG_DIR` | `platform default (`$XDG_CONFIG_HOME/clio-coder`, else `~/.config/clio-coder`)` | Absolute path for the config root; beats `CLIO_CODER_HOME/config` and the platform default, and the fleet-view pane child re-pins it from argv. | env > `CLIO_CODER_HOME/config` > `XDG_CONFIG_HOME` or platform default |
| `CLIO_CODER_DATA_DIR` | `platform default (`$XDG_DATA_HOME/clio-coder`, else `~/.local/share/clio-coder`)` | Absolute path for the data root; beats `CLIO_CODER_HOME/data` and the platform default, and the fleet-view pane child re-pins it from argv. | env > `CLIO_CODER_HOME/data` > `XDG_DATA_HOME` or platform default |
| `CLIO_CODER_DEBUG_SHUTDOWN` | `unset (disabled)` | Exactly `1` prints timed `[clio-coder:shutdown]` phase lines and full stack traces of failing domain `stop()` hooks to stderr during shutdown. |  |
| `CLIO_CODER_ENDPOINT_SLOTS_TTL_MS` | `86400000` | Positive integer milliseconds a persisted endpoint slot count stays valid for an endpoint this process has not probed; older records are ignored and pruned. | env > built-in default (no settings key) |
| `CLIO_CODER_EVAL_RUNNER_STDOUT_FILE` | `unset` | Set by the eval suite runner to the path of the captured runner stdout JSONL for a task's measure step; read only by external graders (evals/behavioral-corpus-grader.mjs), never by src. |  |
| `CLIO_CODER_FORCE_COMPACT` | `unset (disabled)` | Exactly `1` on the interactive process forces the pre-submit compaction to run on every turn while set, regardless of the context threshold. |  |
| `CLIO_CODER_GIT_COMMITS_ENABLED` | `unset (in-process reads treat it as enabled; the hook requires exactly `1`)` | Set by Clio to `1`/`0` from `integrations.git.commitAttribution` for itself and child seams; the managed hook exits unless it is exactly `1`, while absent counts as enabled in process. | `integrations.git.commitAttribution` writes it; env is the transport, not an operator override |
| `CLIO_CODER_GIT_CONFIG_BASE_COUNT` | `unset` | Set by Clio to the `GIT_CONFIG_COUNT` value before it appended its `core.hooksPath` pair; the hook wrapper and nested seams use it to strip only that pair. |  |
| `CLIO_CODER_GIT_DEFAULT_HOOKS_EQUIVALENT` | `unset` | Set by Clio to the repository's explicitly configured `core.hooksPath` when it equals the default hooks directory, so the hook wrapper can chain the repo's own hook. |  |
| `CLIO_CODER_HOME` | `unset` | Single-tree install root; each role resolves to `<home>/<config\|data\|state\|cache>` unless its per-role `CLIO_CODER_*_DIR` variable is set. | `CLIO_CODER_<ROLE>_DIR` > `CLIO_CODER_HOME/<role>` > XDG or platform default |
| `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` | `per-phase built-ins (before_tool 25, after_tool 25, turn_start 50, turn_end 75, on_compaction 150 ms)` | Positive milliseconds budget for one middleware phase (`BEFORE_TOOL`, `AFTER_TOOL`, `TURN_START`, `TURN_END`, `ON_COMPACTION`); beats the global variable for that phase. | `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` > `CLIO_CODER_HOOK_BUDGET_MS` > built-in per-phase default |
| `CLIO_CODER_HOOK_BUDGET_DEBUG` | `unset (disabled)` | Exactly `1` prints every post-warmup hook-budget overrun to stderr instead of only steady-state slowness. |  |
| `CLIO_CODER_HOOK_BUDGET_MS` | `per-phase built-ins (before_tool 25, after_tool 25, turn_start 50, turn_end 75, on_compaction 150 ms)` | Positive milliseconds applied to every middleware phase that has no per-phase override; invalid or non-positive values are ignored. | `CLIO_CODER_HOOK_BUDGET_<PHASE>_MS` > `CLIO_CODER_HOOK_BUDGET_MS` > built-in per-phase default |
| `CLIO_CODER_HOOK_BUDGET_THRESHOLD` | `3` | Positive integer count of overruns within the rolling window that triggers a steady-state slow-hook warning. |  |
| `CLIO_CODER_HOOK_BUDGET_WARMUP_CALLS` | `1` | Non-negative integer number of initial calls per registration and phase that are exempt from budget accounting. |  |
| `CLIO_CODER_HOOK_BUDGET_WINDOW` | `5` | Positive integer size of the rolling post-warmup call window examined for steady-state hook slowness. |  |
| `CLIO_CODER_INJECTED_COMPILE_CACHE` | `unset` | Set by the native worker spawn beside an injected `NODE_COMPILE_CACHE`; the worker entry deletes both when they match, and the `worker` subcommand strips a foreign marker. |  |
| `CLIO_CODER_INSTANT_SHELL` | `unset (enabled)` | Exactly `0` disables the Stage 0 instant interactive shell mounted before service hydration; any other value or unset keeps it on. |  |
| `CLIO_CODER_INTERACTIVE` | `unset (Clio sets `1` itself when stdin is a TTY)` | Exactly `1` marks and forces the interactive TUI; Clio sets it when stdin is a TTY, any other value suppresses the TUI, and bash-tool children never inherit it. |  |
| `CLIO_CODER_LEGACY_MASK` | `unset (disabled)` | Exactly `1` re-enables the destructive stale-observation mask stage before summary compaction; a one-release compatibility escape hatch. |  |
| `CLIO_CODER_LMSTUDIO_CORESIDENT_CONTEXT` | `131072` | Positive integer ceiling on the context length requested when loading an LM Studio model next to another resident model; `off`, `0`, or `false` disables the clamp. |  |
| `CLIO_CODER_MEMORY_TRACE` | `unset (disabled)` | File path for a JSONL trace of proactive task-memory step envelopes including up to 8000 chars of model text per step; off when unset or empty. |  |
| `CLIO_CODER_MODEL_CATALOG_DIRS` | `unset` | PATH-delimited list of extra model-catalog overlay directories, applied after the user and project overlays with the highest precedence. |  |
| `CLIO_CODER_NO_NETWORK_TOOLS` | `unset (disabled)` | Exactly `1` removes the network (RETRIEVE) tools from every registry built in the process; `clio-coder skills-eval` sets it for hermetic arms and `--allow-network` deletes it. | `skills-eval --allow-network` clears it for child arms; otherwise env only |
| `CLIO_CODER_PACKAGE_ROOT` | `auto-detected` | Path used as the package root for bundled assets and docs instead of walking up to package.json; the docs engine re-reads it live, other callers cache the first answer. |  |
| `CLIO_CODER_REDUCE_MOTION` | `unset (disabled)` | Exactly `1` makes smooth-streaming `auto` use the immediate coalescer; explicit `on` is unaffected. |  |
| `CLIO_CODER_RENDER_TRACE` | `unset (disabled)` | File path for the versioned JSONL render-pipeline trace (timing only, no conversation text), truncated on open; off when unset or empty. |  |
| `CLIO_CODER_REQUIRE_HOME_PREFIX` | `unset (disabled)` | Exactly `1` aborts startup when any resolved Clio directory lies outside `CLIO_CODER_HOME`; a test-harness guardrail that does nothing when `CLIO_CODER_HOME` is unset. |  |
| `CLIO_CODER_RIGOR` | `repo-derived` | `high` or `normal` (case-insensitive) overrides the finish-contract evidence bar for the orchestrator and dispatched workers; any other value means no override. | env > workspace validation contract file (`.clio-coder/validation.yaml`, `validation.yaml`, `VALIDATION.md` raise it to `high`) > `normal`; no settings key |
| `CLIO_CODER_RUN_OVERRIDES` | `unset` | JSON object (`maxContextTokens`, `kvCacheMode`, `sampling`) that `clio-coder run` and print modes write via `withRunOverrides` for the run's scope; workers inherit it and malformed input is dropped. |  |
| `CLIO_CODER_SCREEN_READER` | `unset (disabled)` | Exactly `1` makes smooth-streaming `auto` use the immediate coalescer so a screen reader gets the low-motion update behavior; explicit `on` is unaffected. |  |
| `CLIO_CODER_SHUTDOWN_HOOK_MS` | `500` | Positive integer milliseconds each shutdown and domain `stop()` hook may run before the coordinator moves on; non-positive or unparsable values use the default. |  |
| `CLIO_CODER_SKILL_CATALOG_DIR` | `unset` | Path to a local skill catalog used by the marketplace and the provenance pin manifest; beats `<cwd>/skills` and the packaged catalog but not an explicit catalogDir option. | explicit catalogDir option > env > `<cwd>/skills` > packaged catalog |
| `CLIO_CODER_SKILL_MARKETPLACE_INDEX` | `unset` | Path to a skill-marketplace index file consulted after the catalog; an explicit indexPath option beats it and the built-in index path is the fallback. | explicit indexPath option > env > default index path |
| `CLIO_CODER_STATE_DIR` | `platform default (`$XDG_STATE_HOME/clio-coder`, else `~/.local/state/clio-coder`)` | Absolute path for the state root; beats `CLIO_CODER_HOME/state` and the platform default, and the fleet-view pane child re-pins it from argv. | env > `CLIO_CODER_HOME/state` > `XDG_STATE_HOME` or platform default |
| `CLIO_CODER_STATUS_STUCK_MS` | `180000` | Positive number of milliseconds of elapsed turn time after which the status watchdog reports the turn as stuck (tier 4). |  |
| `CLIO_CODER_TEST_STAGE1_DELAY_MS` | `0` | Under `NODE_ENV=test` only, integer milliseconds (clamped to 0..5000) to sleep between the Stage 0 shell mount and Stage 1 hydration for PTY tests. |  |
| `CLIO_CODER_TEST_STAGE1_FAIL` | `unset (disabled)` | Under `NODE_ENV=test` only, exactly `1` throws an injected Stage 1 hydration failure after the instant shell mounts. |  |
| `CLIO_CODER_TEST_UPGRADE_NO_NETWORK` | `unset (disabled)` | Any non-empty value makes `clio-coder upgrade` skip the npm install step so upgrade tests run offline. |  |
| `CLIO_CODER_TIMING` | `unset (disabled)` | Exactly `1` prints the startup timer report after the banner, but only on the bannered non-interactive boot (not the TUI, headless, or ACP paths). |  |
| `CLIO_CODER_TRACE_BOOT` | `unset (disabled)` | Exactly `1` writes a `[clio-coder:boot] +<ms> <phase>` line to stderr for every boot phase marker, including startup-timer marks. |  |
| `CLIO_CODER_TRACE_MAX_BYTES` | `134217728` | Integer of at least 1048576 bytes the SQLite trace mirror may occupy before the oldest terminal runs are pruned; smaller or invalid values fall back. | env > built-in default (no settings key) |
| `CLIO_CODER_TRACE_RETENTION_DAYS` | `30` | Integer of at least 1 giving the maximum age in days of terminal rows kept in the SQLite trace mirror; invalid values fall back. | env > built-in default (no settings key) |
| `CLIO_CODER_WORKER_FAUX` | `unset (disabled)` | Exactly `1` registers the pi-ai faux provider and queues one deterministic assistant reply so a worker subprocess runs end to end without credentials (tests only). |  |
| `CLIO_CODER_WORKER_FAUX_ERROR_MESSAGE` | `unset` | Optional assistant `errorMessage` attached to the faux worker reply when `CLIO_CODER_WORKER_FAUX=1`; empty means no error. |  |
| `CLIO_CODER_WORKER_FAUX_MODEL` | `faux-model` | Model id registered under the faux provider when `CLIO_CODER_WORKER_FAUX=1`. |  |
| `CLIO_CODER_WORKER_FAUX_STOP_REASON` | `stop` | Assistant `stopReason` of the faux reply when `CLIO_CODER_WORKER_FAUX=1`, cast unchecked to the engine stop-reason type. |  |
| `CLIO_CODER_WORKER_FAUX_TEXT` | `ok` | Assistant response text of the faux reply when `CLIO_CODER_WORKER_FAUX=1`. |  |
| `CLIO_CODER_WORKER_LABELS` | `unset (no labels)` | Set by the SSH transport from the node's configured `labels`; the worker entry splits the comma-separated list and attests it on the control lane. |  |
| `CLIO_CODER_WORKER_PGID` | `worker's own pid (null on Windows)` | Set by the SSH transport to the login shell's pid (`$$`); the worker entry announces it as the process group an abort must signal, else its own pid. |  |
| `CLIO_CODER_WORKER_RUN` | `unset` | Set to `1` by the worker entry on itself so every child sees it; `installSkillFromSource` stamps `installed-by: worker` when it is exactly `1`. |  |
| `CLIO_CODER_YAZI_PICK_TOKEN` | `unset` | Set by the Yazi companion session to a random UUID (both spellings) in Yazi's env; the generated keymap expands `$CLIO_CODER_YAZI_PICK_TOKEN` into the pick event Clio matches. |  |
| `COLORTERM` | `unset` | A value containing `truecolor` or `24bit` switches the theme to 24-bit SGR colors; otherwise 256-color codes are used unless `TERM` says truecolor. |  |
| `COLUMNS` | `80` | When stdout is not a TTY, a positive number sets the table width for CLI listings (minimum 20); the TTY width wins when present and 80 is the fallback. |  |
| `EDITOR` | `first of `nano`, `vi` on PATH` | External editor command for the TUI editor handoff, used when `VISUAL` is unset; falls back to the first of `nano` or `vi` found on PATH. | `VISUAL` > `EDITOR` > `nano` > `vi` |
| `GIT_CONFIG_COUNT` | `unset (treated as 0)` | Git's config-entry count; Clio appends its `core.hooksPath` pair at that index (skipping attribution when invalid or above 1024) and nested seams restore it. |  |
| `HERDR_ENV` | `unset` | Must be exactly `1` for Clio to treat itself as running inside a herdr pane host; otherwise pane detection reports none. | `interface.panes.enabled` gates the probe first; then env |
| `HERDR_SESSION` | `unset` | Names the herdr session whose socket (`<herdr config>/sessions/<id>/herdr.sock`) is tried after `HERDR_SOCKET_PATH` and before the global socket. |  |
| `HERDR_SOCKET_PATH` | `unset` | Explicit herdr socket path tried first when connecting to the pane host. |  |
| `HOME` | `unset (os.homedir() where a fallback exists)` | Home directory used to strip the home prefix from eval artifacts, to collapse displayed paths to `~`, and as the herdr config base when `XDG_CONFIG_HOME` is unset. |  |
| `LOCALAPPDATA` | `~\AppData\Local` | Windows-only base directory for the state and cache roots (`%LOCALAPPDATA%\clio-coder\state`, `%LOCALAPPDATA%\clio-coder\cache`); ignored on other platforms. |  |
| `LOGNAME` | `unknown` | Fallback user name for run identity when `os.userInfo()` throws and `USER` is empty; otherwise `unknown`. |  |
| `LSB_JOBID` | `unset` | Non-empty value records an LSF job in the run identity (`scheduler: lsf`), checked after the SLURM and PBS job ids. |  |
| `LSB_JOBNAME` | `unset` | Job name recorded beside `LSB_JOBID` in the LSF run identity; ignored without it. |  |
| `LSF_CLUSTER_NAME` | `unset` | Cluster name recorded beside `LSB_JOBID` in the LSF run identity; ignored without it. |  |
| `NO_COLOR` | `unset` | Any non-empty value drops every foreground and background SGR color from the theme; bold, dim, italic, and underline stay. |  |
| `NODE_COMPILE_CACHE` | `unset (Clio uses `<cache>/v8-compile-cache` once the cache root exists)` | Presence (even empty) means the operator owns the V8 compile cache: Clio calls `enableCompileCache()` with no directory and never injects its own cache into workers. |  |
| `NODE_DISABLE_COMPILE_CACHE` | `unset` | Presence disables Clio's compile cache for this process and stops the worker spawn from injecting one. |  |
| `NODE_ENV` | `unset` | Exactly `test` unlocks the Stage 1 interleaving seams (`CLIO_CODER_TEST_STAGE1_DELAY_MS`, `CLIO_CODER_TEST_STAGE1_FAIL`); no other value matters. |  |
| `NODE_OPTIONS` | `unset` | Scanned for `--trace-warnings`; when present, the trace store stops suppressing Node's `node:sqlite` ExperimentalWarning. |  |
| `OLLAMA_NUM_PARALLEL` | `1` | Positive integer parallel slot count assumed for a local Ollama server during discovery; anything else counts as 1. |  |
| `PATH` | `unset` | Searched for executables by interop CLI detection, toolchain resolution, the uninstall shadow check, and editor probing; the bash tool's login-env capture is discarded without it. |  |
| `PBS_JOBID` | `unset` | Non-empty value records a PBS job in the run identity (`scheduler: pbs`), checked after the SLURM id and before LSF. |  |
| `PBS_JOBNAME` | `unset` | Job name recorded beside `PBS_JOBID` in the PBS run identity; ignored without it. |  |
| `PBS_O_HOST` | `unset` | Submission host recorded as the cluster beside `PBS_JOBID` in the PBS run identity; ignored without it. |  |
| `SHELL` | `/bin/sh` | Shell run with `-lc` for the external editor command and for shell-expanded config values on POSIX; defaults to `/bin/sh` (Windows uses `ComSpec`). |  |
| `SLURM_CLUSTER_NAME` | `unset` | Cluster name recorded beside `SLURM_JOB_ID` in the SLURM run identity; ignored without it. |  |
| `SLURM_JOB_ID` | `unset` | Non-empty value records a SLURM job in the run identity (`scheduler: slurm`); it takes priority over the PBS and LSF ids. |  |
| `SLURM_JOB_NAME` | `unset` | Job name recorded beside `SLURM_JOB_ID` in the SLURM run identity; ignored without it. |  |
| `SSH_CONNECTION` | `unset` | Any non-empty value marks a remote session and makes smooth-streaming `auto` use the immediate coalescer. |  |
| `SSH_TTY` | `unset` | Any non-empty value marks a remote TTY and makes smooth-streaming `auto` use the immediate coalescer. |  |
| `STY` | `unset` | Any non-empty value (GNU screen) makes smooth-streaming `auto` use the immediate coalescer. |  |
| `TERM` | `unset` | Empty, `dumb`, or `unknown` disables smooth-streaming `auto`; a value containing `truecolor` or `24bit` enables 24-bit theme colors. |  |
| `TERM_PROGRAM` | `unset` | Terminal program name; `WezTerm`, `iTerm.app`, and Windows Terminal (with `WT_SESSION`) route desktop notifications through OSC 9 (src/interactive/footer/notifications.ts). |  |
| `TMUX` | `unset` | Any non-empty value (inside tmux) makes smooth-streaming `auto` use the immediate coalescer. |  |
| `TZ` | `unset (system zone)` | Time zone used to name the local-date audit log file; the formatter is rebuilt whenever the value changes mid-process. |  |
| `USER` | `unknown` | Fallback user name for run identity when `os.userInfo()` throws, checked before `LOGNAME`; otherwise `unknown`. |  |
| `VISUAL` | `unset` | Preferred external editor command for the TUI editor handoff, checked before `EDITOR`. | `VISUAL` > `EDITOR` > `nano` > `vi` |
| `WT_SESSION` | `unset` | Any non-empty value (Windows Terminal) routes desktop notifications to OSC 9 instead of OSC 777. |  |
| `XDG_CACHE_HOME` | `~/.cache` | Linux base for the default cache root (`$XDG_CACHE_HOME/clio-coder`) when neither `CLIO_CODER_CACHE_DIR` nor `CLIO_CODER_HOME` is set. |  |
| `XDG_CONFIG_HOME` | `~/.config` | Linux base for the default config root, the herdr config directory, and (when absolute) the user's own Yazi config directory. |  |
| `XDG_DATA_HOME` | `~/.local/share` | Linux base for the default data root (`$XDG_DATA_HOME/clio-coder`) when neither `CLIO_CODER_DATA_DIR` nor `CLIO_CODER_HOME` is set. |  |
| `XDG_STATE_HOME` | `~/.local/state` | Linux base for the default state root (`$XDG_STATE_HOME/clio-coder`) when neither `CLIO_CODER_STATE_DIR` nor `CLIO_CODER_HOME` is set. |  |

## CLI flags

Grouped by command. Global flags appear under `global`.


### `acp`

| Flag | Controls |
|---|---|
| `--acp` | Tolerated as a leading no-op so another dispatcher can hand the `acp` command the flag spelling; Clio's own argv parser already rewrites a global `--acp` into the command. |
| `--cwd` | Workspace root the ACP server boots in and opens sessions at; resolved and canonicalized through realpath at boot. |
| `--help` | Print the command's usage and exit. |
| `--permission-timeout` | Milliseconds a mediated permission request may wait for the ACP client before it expires; whole number from 1 to the timer maximum. |
| `-h` | Short form of --help. |

### `agents`

| Flag | Controls |
|---|---|
| `--all` | Include shadow and internal agent specs reserved for Clio orchestration in the `agents` listing. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON instead of the human-readable rendering. |
| `-h` | Short form of --help. |

### `auth`

| Flag | Controls |
|---|---|
| `--api-key` | For `auth login`, store this literal API key for the named target or runtime instead of running the interactive credential flow. |
| `--help` | Print the auth usage and exit; accepted by `auth list`, `status`, `login`, and `logout`. |
| `-h` | Short form of --help. |

### `components`

| Flag | Controls |
|---|---|
| `--from` | For `dev components diff`, path of the baseline snapshot JSON. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for `dev components list` and `dev components diff` instead of the text rendering. |
| `--out` | For `dev components snapshot`, path where the component snapshot JSON is written (required). |
| `--to` | For `dev components diff`, path of the candidate snapshot JSON. |
| `-h` | Short form of --help. |

### `config`

| Flag | Controls |
|---|---|
| `--help` | Print the command's usage and exit. |
| `--json` | For `config inspect`, emit the customization graph as JSON. |
| `-h` | Short form of --help. |

### `configure`

| Flag | Controls |
|---|---|
| `--agent-profile` | Save the target as a named `fleet.profiles` entry under this name (non-interactive; mutually exclusive with `--fleet-model`); `targets add` forwards the same flags. |
| `--agent-profile-model` | Model id stored on the fleet profile created by `--agent-profile`. |
| `--all` | With `--list`, list every registered runtime including aliases instead of only the user-facing ones. |
| `--api-key` | Store this literal API key in credentials.yaml for the target being registered. |
| `--api-key-env` | Name of the environment variable read for the target's API key at call time, instead of storing a literal. |
| `--background-model` | Model id to use when this target is set as the proactive task-memory (background) target. |
| `--context-window` | Capability override: positive integer context window in tokens recorded on the target instead of the probed or catalog value. |
| `--fleet-model` | Model id stored as the fleet default model when this target becomes the fleet default target (mutually exclusive with `--agent-profile`). |
| `--force` | Save a model outside the runtime catalog, or one the target does not advertise, without refusing. |
| `--gateway` | Mark the registered target as a gateway. |
| `--help` | Print the command's usage and exit. |
| `--id` | Target id to register non-interactively (required with `--runtime`); `targets add` forwards the same flags. |
| `--interop` | Review coding agents detected on this machine and connect one as a delegation peer; without a TTY it prints the proposals and writes nothing. |
| `--lifecycle` | Resident-model lifecycle policy stored on the target: `user-managed` or `clio-coder-managed`. |
| `--list` | List target runtimes (user-facing only unless `--all`) and exit without configuring anything. |
| `--max-tokens` | Capability override: positive integer output-token limit recorded on the target. |
| `--model` | Default wire model id stored on the target being registered. |
| `--orchestrator-model` | Model id to use when this target is set as the chat (orchestrator) target. |
| `--reasoning` | Capability override: `true` or `false` for whether the target's model supports reasoning. |
| `--remove` | Remove the target with this id from settings.yaml and exit; `targets remove <id>` is the documented form. |
| `--rename` | Takes two values, old id and new id, and renames that target in settings.yaml; `targets rename <old> <new>` is the documented form. |
| `--runtime` | Runtime id for the target registered non-interactively with `--id`. |
| `--set-background` | Make the registered target the proactive task-memory (background) target. |
| `--set-fleet-default` | Make the registered target the fleet default dispatch target. |
| `--set-orchestrator` | Make the registered target the chat (orchestrator) target. |
| `--url` | Target base URL (http(s):// or ws://) for the runtime being registered. |
| `-h` | Short form of --help. |

### `context`

| Flag | Controls |
|---|---|
| `--all` | For `context reset`, also remove the local CLIO-CODER.md after a second confirmation; override files stay human-owned. |
| `--budgets` | For `context replay`, comma-separated positive-integer token budgets each policy is replayed against. |
| `--depth` | For `context wiki`, generation depth: `auto`, `simple`, `medium`, or `detailed`. |
| `--help` | Print the command's usage and exit. |
| `--json` | For `context index`, emit JSON; for `context replay`, `--json <path>` writes the stable JSON report to that path instead. |
| `--md` | For `context replay`, path to write the Markdown report to instead of printing it. |
| `--min-evictable-tokens` | For `context replay`, non-negative integer tool-result size in tokens below which results are never evicted. |
| `--model` | For `context wiki`, wire model id for the documenter model instead of the configured one; pair with `--target`. |
| `--no-filter` | For `context replay`, include every readable transcript instead of only the filtered active-path sessions. |
| `--policies` | For `context replay`, comma-separated policy ids from none, random, age-horizon, structural-v1, oracle. |
| `--protect-last-turns` | For `context replay`, integer (at least 1) count of recent user turns whose observations are never evicted. |
| `--seed` | For `context replay`, integer seed for the deterministic random policy. |
| `--session` | For `context working-set`, the session id or path whose working-set fold and path index are printed (required). |
| `--sessions` | For `context replay`, one or more session directories, sessions roots, or ledger JSONL files; consumes values until the next `--` flag. |
| `--status` | For `context wiki`, print the wiki's presence, page count, git head, and staleness instead of generating. |
| `--synthetic` | For `context replay`, comma-separated procedural corpus ids to replay instead of, or alongside, `--sessions`. |
| `--target` | For `context replay`, post-eviction pressure ratio (above 0, below 1 and below `--threshold`); for `context wiki`, the target id for the documenter model. |
| `--thinking` | For `context wiki`, documenter thinking level: `off`, `low`, `medium`, or `high`; pair with `--target`. |
| `--threshold` | For `context replay`, pressure ratio (above 0, at most 1) at which eviction triggers. |
| `--update` | For `context wiki`, force an update pass over the existing wiki instead of the default generate-or-noop. |
| `--wiki` | For `context refresh`, also update the existing Markdown wiki after re-indexing the codewiki. |
| `--yes` | For `context reset`, answer every confirmation yes; required when stdin is not a terminal. |
| `-h` | Short form of --help. |
| `-y` | Short form of --yes for `context reset`. |

### `docs`

| Flag | Controls |
|---|---|
| `--help` | Print the command's usage and exit. |
| `--no-open` | Do not launch a browser; print the local documentation URL only. |
| `-h` | Short form of --help. |

### `doctor`

| Flag | Controls |
|---|---|
| `--fix` | Repair structure (missing directories and template files, credential file permissions) instead of the read-only diagnosis. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON instead of the human-readable rendering. |
| `-h` | Short form of --help. |

### `eval`

| Flag | Controls |
|---|---|
| `--allow-config-drift` | For `eval compare`, proceed when the two artifacts' configs differ and label the comparison as config drift allowed. |
| `--baseline` | For `eval gate`, the baseline eval id the candidate is gated against (required). |
| `--clio-coder-entry` | For `eval run`, path to the clio-coder CLI entry the runner executes; a relative path is pinned to the invoking directory. |
| `--format` | For `eval report`: `text`, `json`, `md`, `swe-jsonl`, or `junit`; for `eval compare`: `text`, `json`, `md`, or `junit`. |
| `--help` | Print the command's usage and exit. |
| `--json` | For `eval inventory`, the only accepted argument; emits the bounded machine-readable inventory. |
| `--metric` | For `eval compare`, the behavioral metric or metric family the comparison is scored on. |
| `--model` | For `eval run`, wire model id that overrides the suite's model. |
| `--out` | For `eval run`, path where the eval artifact is written. |
| `--repeat` | For `eval run --task-file`, positive integer repetitions per v1 task. |
| `--suite` | For `eval validate` and `eval run`, path to the Suite v2 YAML; run takes exactly one of `--suite` or `--task-file`. |
| `--target` | For `eval run`, target id that overrides the suite's target. |
| `--task-file` | For `eval run`, path to a compatibility v1 task file loaded as a suite. |
| `--thresholds` | For `eval gate`, path to a thresholds file replacing the built-in gate thresholds. |
| `--trials` | For `eval run`, positive integer overriding the suite's `matrix.repeats` and requesting a fresh workspace per matrix item. |
| `-h` | Short form of --help. |

### `evidence`

| Flag | Controls |
|---|---|
| `--eval` | For `evidence build`, the eval id to build evidence from. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for `evidence inspect`; for `evidence inventory` it is the only accepted argument. |
| `--run` | For `evidence build`, the run id to build evidence from. |
| `--session` | For `evidence build`, the session id to build evidence from. |
| `-h` | Short form of --help. |

### `evolve`

| Flag | Controls |
|---|---|
| `--help` | Print the `dev evolve manifest` usage and exit. |
| `-h` | Short form of --help for `dev evolve`. |

### `extensions`

| Flag | Controls |
|---|---|
| `--all` | For `extensions list`, include every installed record instead of only effective ones plus invalid or incompatible ones. |
| `--force` | For `extensions install`, overwrite an already installed extension with the same id. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON instead of the human-readable rendering. |
| `--project` | Scope list, install, enable, disable, or remove to the project extension store; mutually exclusive with `--user`. |
| `--user` | Scope list, install, enable, disable, or remove to the user extension store; mutually exclusive with `--project`. |
| `-f` | Short form of --force for `extensions install`. |
| `-h` | Short form of --help. |

### `fleet`

| Flag | Controls |
|---|---|
| `--cache-dir` | For `fleet view`, absolute cache directory pinned for this self-invocation; sets CLIO_CODER_CACHE_DIR before any read (internal pane-shell flag). |
| `--config-dir` | For `fleet view`, absolute config directory pinned for this self-invocation; sets CLIO_CODER_CONFIG_DIR before any read (internal pane-shell flag). |
| `--data-dir` | For `fleet view`, absolute data directory pinned for this self-invocation; sets CLIO_CODER_DATA_DIR before any read (internal pane-shell flag). |
| `--follow` | For `fleet view <runId>`, keep tailing the run journal until its terminal line, then stay open until q. |
| `--from` | For `fleet new <name>`, the shipped builtin contract to copy: `build-review`, `build-test`, or `sdlc` (required). |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for `fleet validate`, `graph`, `run` (step receipts), `status`, `drain`, and `resume`; the only accepted argument for `inspect` and `decisions`. |
| `--resume` | For `fleet run`, run id of a prior run of the same plan whose completed prefix is replayed before the rest executes. |
| `--state-dir` | For `fleet view`, absolute state directory pinned for this self-invocation; sets CLIO_CODER_STATE_DIR before any read (internal pane-shell flag). |
| `--var` | For `fleet run`, one `key=value` template variable for the contract; repeatable. |
| `--watch` | For `fleet view`, path of a one-line selection file naming the run id to follow, retargeting live as it changes; takes no run id and excludes `--follow`. |
| `-f` | Short form of --follow for `fleet view`. |
| `-h` | Short form of --help. |

### `global`

| Flag | Controls |
|---|---|
| `--acp` | Startup alias for the `acp` subcommand: rewrites the rest of the line onto `clio-coder acp`, so every trailing option is parsed by the ACP parser. |
| `--all` | With `--help`, appends the `clio-coder dev` command list (components, evolve, share) to the top-level help; no effect otherwise. |
| `--api-key` | Startup flag taking a literal key that overrides the stored credential for the target this invocation resolves; must precede the subcommand. |
| `--continue` | Refused before the subcommand: exits 2 with the hint that sessions are resumed from inside the app by typing /resume; nothing is parsed from it. `run --continue` is a separate flag. |
| `--help` | Print the top-level command list and exit 0 when given before any subcommand. |
| `--no-context-files` | Startup flag that skips CLIO-CODER.md project-context injection for this invocation; must precede the subcommand (run rejects it with a position hint). |
| `--no-panes` | Startup flag that disables guest pane integration for this invocation; must precede the subcommand. |
| `--no-skills` | Startup flag that disables skill discovery for this invocation while still honoring explicit `--skill` paths; also accepted after `run`. |
| `--resume` | Refused before the subcommand: exits 2 with the hint that sessions are resumed from inside the app by typing /resume; nothing is parsed from it. |
| `--skill` | Startup flag taking one skill file or directory to load for this invocation; repeatable, also accepted after `run`, and the value may not be a subcommand name. |
| `--version` | Print the installed version and exit; `clio-coder version` is the subcommand form. |
| `--with-panes` | Startup flag that activates guest pane integration for this invocation when a reachable herdr session exists; must precede the subcommand. |
| `-c` | Short form of --continue, refused with the same /resume hint. |
| `-h` | Short form of --help. |
| `-nc` | Short form of --no-context-files. |
| `-r` | Short form of --resume, refused with the same /resume hint. |
| `-v` | Short form of --version. |

### `init`

| Flag | Controls |
|---|---|
| `--help` | Print the `context init` usage and exit. |
| `--json` | For `context init`, emit one machine-readable result object on stdout and suppress the progress text. |
| `--model` | For `context init`, Scout wire model id override; requires `--target`. |
| `--target` | For `context init`, target id for the Scout exploration model instead of the configured one. |
| `--thinking` | For `context init`, Scout thinking level: off, minimal, low, medium, high, xhigh, or max; requires `--target`. |
| `--yes` | For `context init`, update .gitignore for Clio context artifacts without prompting. |
| `-h` | Short form of --help for `context init`. |
| `-y` | Short form of --yes for `context init`. |

### `interop`

| Flag | Controls |
|---|---|
| `--help` | Print the interop usage and exit. |
| `--json` | For `interop inspect`, the only accepted argument; emits the detected agent inventory with no native paths. |
| `-h` | Short form of --help. |

### `library`

| Flag | Controls |
|---|---|
| `--from` | For `library add`, a catalog directory or path to install from; the literal `catalog` selects the default catalog. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for `library list`, `search`, and `add`. |
| `--kind` | For `library list` and `library search`, restrict to one entry kind: `skill`, `agent`, `prompt`, or `fleet`. |
| `--with-requirements` | For `library add`, also install the entry's unsatisfied requirements instead of refusing. |
| `--yes` | For `library add`, confirm the install writes; without it the plan is printed and nothing is written. |
| `-h` | Short form of --help. |

### `memory`

| Flag | Controls |
|---|---|
| `--acknowledge-global` | For `memory propose`/`promote` with `--scope global`, the explicit acknowledgement required to create a global-scope record. |
| `--agent` | For `memory propose`/`promote` with `--scope agent`, the source agent id. |
| `--entry` | For `memory promote`, one handoff entry id to promote; repeatable, every entry when omitted. |
| `--from-evidence` | For `memory propose`, the evidence id the proposal is derived from (required). |
| `--from-handoff` | For `memory promote`, path of the reviewed task-memory handoff snapshot (required). |
| `--help` | Print the memory usage and exit. |
| `--repository` | For `memory propose`/`promote` with `--scope repo`, the canonical absolute repository path. |
| `--runtime` | For `memory propose`/`promote` with `--scope runtime`, the source runtime id. |
| `--scope` | For `memory propose`/`promote`, record scope: `repo`, `global`, `runtime`, or `agent` (required for promote). |
| `--stale` | For `memory prune`, the required switch that removes records past their retention window. |
| `-h` | Short form of --help. |

### `models`

| Flag | Controls |
|---|---|
| `--help` | Print the models usage and exit. |
| `--json` | Emit JSON instead of the human-readable rendering. |
| `--offline` | Use cached, configured, and catalog model hints without probing targets live. |
| `--target` | Restrict the model listing to one configured target id. |
| `-h` | Short form of --help. |

### `panes`

| Flag | Controls |
|---|---|
| `--help` | Print the command's usage and exit. |
| `-h` | Short form of --help. |

### `paths`

| Flag | Controls |
|---|---|
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON instead of the human-readable rendering. |
| `-h` | Short form of --help. |

### `reset`

| Flag | Controls |
|---|---|
| `--all` | Reset all four roots (config, data, state, cache); cannot be combined with an individual level flag. |
| `--auth` | Reset credentials.yaml only; combinable with the other level flags. |
| `--cache` | Reset the cache root only; combinable with the other level flags. |
| `--config` | Reset settings.yaml only; combinable with the other level flags. |
| `--data` | Reset the data root only (memory, evidence, evals, vendored tools); combinable with the other level flags. |
| `--dry-run` | Print the listing of what each selected root holds and change nothing. |
| `--force` | Required for destructive execution; without it the command lists and refuses. |
| `--help` | Print the command's usage and exit. |
| `--state` | Reset the state root only (every session transcript and its audit trail); the default level when no level flag is given. |
| `-f` | Short form of --force. |
| `-h` | Short form of --help. |

### `run`

| Flag | Controls |
|---|---|
| `--agent` | Dispatch a fleet agent instead of the main agent. Unknown ids fail fast. |
| `--agent-profile` | Named `fleet.profiles` entry to dispatch through; requires `--agent`; ignored with a warning when `--target` is also given. |
| `--agent-runtime` | Runtime id whose first matching fleet profile is used for dispatch; requires `--agent`; ignored with a warning when `--target` is also given. |
| `--autonomy` | One-run autonomy override: `read-only`, `suggest`, `auto-edit`, or `full-auto`; it does not change saved settings. |
| `--continue` | Append this turn to the most recent session for the current working directory. |
| `--frequency-penalty` | One-run frequency-penalty override (number) when the selected runtime supports it. |
| `--help` | Print the command's usage and exit. |
| `--json` | Stream JSONL events for the main-agent turn (dispatch streams events plus the receipt JSON) instead of text output. |
| `--json-events` | Main-agent JSON stream mode: `full` or `terminal`; implies `--json`. |
| `--kv-cache-mode` | One-run KV-cache override for supported local runtimes: `f16`, `f32`, `none`, `false`, `q8_0`, `q4_0`, `q4_1`, `iq4_nl`, `q5_0`, or `q5_1`. |
| `--max-context-tokens` | One-run context-window override (positive integer tokens) for supported local runtimes. |
| `--min-p` | One-run min-p override (0 to 1) when the selected runtime supports it. |
| `--model` | Wire model id for this run's main agent or dispatched worker instead of the target's default. |
| `--no-skills` | Disable skill discovery for this run while still honoring explicit `--skill` paths. |
| `--presence-penalty` | One-run presence-penalty override (number) when the selected runtime supports it. |
| `--repeat-penalty` | One-run repeat-penalty override (number) when the selected runtime supports it. |
| `--require` | Require a target capability for dispatch. Repeatable. |
| `--session` | Append this turn to an existing session identified by `<id>`. |
| `--skill` | Load one explicit skill file or skill directory for this run. Repeatable. |
| `--steer-channel` | Read live steering lines from a FIFO or an appended regular file to steer the active run. |
| `--target` | Target id for this run's main agent or dispatched worker; an id missing from `settings.targets` exits 2 before the turn starts. |
| `--temperature` | One-run sampling temperature (number, at least 0) when the selected runtime supports it. |
| `--thinking` | Thinking level for this run: off, minimal, low, medium, high, xhigh, or max. |
| `--tool-profile` | Restrict dispatched-agent tools: `minimal-local`, `science-local`, or `full-agent`. |
| `--top-k` | One-run top-k override (integer, at least 0) when the selected runtime supports it. |
| `--top-p` | One-run nucleus-sampling override (0 to 1) when the selected runtime supports it. |
| `-h` | Short form of --help. |

### `share`

| Flag | Controls |
|---|---|
| `--agents` | For `dev share export`, include agent definitions in the archive. |
| `--all` | For `dev share export`, include every resource type (context, prompts, skills, agents, fleets, settings, extensions). |
| `--both` | For `dev share export`, export both the project and user scopes; mutually exclusive with `--project`/`--user`. |
| `--context` | For `dev share export`, include project context files in the archive. |
| `--dry-run` | For `dev share import`, plan the import and report conflicts without writing. |
| `--extensions` | For `dev share export`, include extension bundles in the archive. |
| `--fleets` | For `dev share export`, include fleet contracts in the archive. |
| `--force` | For `dev share import`, overwrite existing files the archive conflicts with. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for `dev share export`, `import`, and `inspect`. |
| `--out` | For `dev share export`, path of the archive to write (required). |
| `--project` | Limit `dev share export`/`import` to the project scope; mutually exclusive with `--user` and `--both`. |
| `--prompts` | For `dev share export`, include prompts in the archive. |
| `--settings` | For `dev share export`, include settings fragments in the archive. |
| `--skills` | For `dev share export`, include skills in the archive. |
| `--user` | Limit `dev share export`/`import` to the user scope; mutually exclusive with `--project` and `--both`. |
| `-f` | Short form of --force for `dev share import`. |
| `-h` | Short form of --help. |

### `skills`

| Flag | Controls |
|---|---|
| `--all` | For `skills list`, include skills the model cannot load; for `skills update`, update every installed skill. |
| `--allow-network` | For `skills eval`, keep the network tool plane available to the child runs instead of stripping it. |
| `--category` | For `skills install`, install every marketplace skill in this catalog category instead of naming sources. |
| `--force` | For `skills install`, `update`, and `sync`, overwrite an existing installed skill. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for `skills list`, `search`, `inspect`, `validate`, and `eval` (JSONL rows); the only accepted argument for `skills inventory`. |
| `--name` | For `skills install`, install the single source under this skill name. |
| `--project` | For `skills install`, choose the project skill root; mutually exclusive with `--user`. |
| `--scenario` | For `skills eval`, the evals.md scenario id (or bare number) to run instead of every scenario. |
| `--target` | For `skills eval`, target id used by the baseline, treatment, and judge runs instead of the default target. |
| `--timeout` | For `skills eval`, positive integer seconds allowed per child run. |
| `--trust-fixtures` | For `skills eval`, allow the fixture shell commands declared in evals.md to execute in the seed workspace. |
| `--user` | For `skills install`, choose the user skill root; mutually exclusive with `--project`. |
| `--workspace` | For `skills eval`, existing checkout copied into the throwaway seed workspace; the source is never mutated. |
| `-h` | Short form of --help. |

### `targets`

| Flag | Controls |
|---|---|
| `--background-model` | For `targets use`, model id recorded for the proactive task-memory (background) role on the target. |
| `--fleet-model` | For `targets use`, model id recorded as the fleet default model. |
| `--fleet-target` | For `targets use`, target id to use for fleet dispatch when it differs from the chat target. |
| `--force` | For `targets profile remove`, remove the profile even when agents are still bound to it. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON for the `targets` listing, `targets fleet`, and `targets profile bindings`. |
| `--model` | For `targets use`, the chat model id; for `targets profile set`, the profile's model id. |
| `--orchestrator-model` | For `targets use`, model id recorded for the chat (orchestrator) role. |
| `--probe` | For the `targets` listing, probe every target live before rendering health and capabilities. |
| `--runtime` | For `targets convert <id>`, the runtime id the target is converted to (required). |
| `--target` | For the `targets` listing, show only this target id; an unknown id exits 2. |
| `--thinking` | For `targets profile set`, the profile's thinking level: off, minimal, low, medium, high, xhigh, or max. |
| `-h` | Short form of --help. |

### `tools`

| Flag | Controls |
|---|---|
| `--all` | For `tools remove`, remove every vendored tool in the pinned table; rejected on other subcommands. |
| `--force` | For `tools install`, force the download and vendoring even when the tool already resolves. |
| `--help` | Print the command's usage and exit. |
| `--json` | Emit JSON instead of the human-readable rendering. |
| `--reset-profile` | For `tools status <id>`, reset yazi's generated profile; rejected on other subcommands. |
| `-f` | Short form of --force for `tools install`. |
| `-h` | Short form of --help. |

### `trace`

| Flag | Controls |
|---|---|
| `--db` | Path of the trace SQLite database to read (also `--db=PATH`); every trace subcommand accepts it. |
| `--follow` | For `trace tail`, keep streaming events as they land instead of exiting after the current rows. |
| `--help` | Print the command's usage and exit. |
| `--json` | For `trace runs` and `trace prune`, emit JSON. |
| `--limit` | For `trace runs`, integer 1 to 500 number of runs to list (also `--limit=N`). |
| `--max-age-days` | For `trace prune`, integer 1 to 36500 retention age in days for this prune only (also `--max-age-days=N`). |
| `--max-bytes` | For `trace prune`, integer size ceiling in bytes, at least 1048576, for this prune only (also `--max-bytes=N`). |
| `--port` | For `trace ui`, TCP port for the localhost viewer, 0 to 65535 (also `--port=N`); 0 picks an ephemeral port. |
| `-h` | Short form of --help. |

### `uninstall`

| Flag | Controls |
|---|---|
| `--dry-run` | Print what would be removed, including the per-project directories, and change nothing. |
| `--force` | Required for destructive execution; without it the command lists and refuses. |
| `--help` | Print the command's usage and exit. |
| `--remove-binary` | Also remove the launcher symlink when it points at this installation; a real file or a link elsewhere is kept and reported. |
| `-f` | Short form of --force. |
| `-h` | Short form of --help. |

### `upgrade`

| Flag | Controls |
|---|---|
| `--channel` | npm dist-tag to install: `latest`, `beta`, or `dev`; only the `--channel=<chan>` form is parsed; npm installs only. |
| `--dry-run` | Print the planned npm install, migrations, and state refresh and change nothing. |
| `--help` | Print the command's usage and exit. |
| `--post-install` | Internal marker the upgrade passes to its re-exec of the newly installed binary: skip the npm install and run migrations and doctor checks. |
| `--skip-migrations` | Skip the data-dir migrations after the install step. |
| `-h` | Short form of --help. |

### `usage`

| Flag | Controls |
|---|---|
| `--days` | For `usage report`, positive integer report window in days. |
| `--help` | Print the command's usage and exit. |
| `--json` | For `usage report`, emit one JSONL row per fact and per opportunity (schema experimental). |
| `--repo` | For `usage report`, restrict sessions and runs to this repository path. |
| `-h` | Short form of --help. |

### `verifiers`

| Flag | Controls |
|---|---|
| `--command` | For `verifiers add` (required) and `edit`, the check's argv as a JSON string array. |
| `--cwd` | For `verifiers add`/`edit`, repository-relative working directory of the check. |
| `--description` | For `verifiers add` (required) and `edit`, the check's description text. |
| `--dry-run` | For `verifiers author`, a check id executed through the production verify path after the catalog is written; repeatable. |
| `--exclude` | For `verifiers author`, a discovered check id to drop from the draft; repeatable. |
| `--help` | Print the verifiers usage and exit. |
| `--id` | For `verifiers add`, the new check's id (required). |
| `--json` | For `verifiers inspect`, the only accepted argument; emits the fixed machine-readable catalog projection. |
| `--rename` | For `verifiers author`, an `<old>=<new>` rename of a discovered check id; repeatable. |
| `--tags` | For `verifiers add`/`edit`, comma-separated catalog tags. |
| `--timeout-ms` | For `verifiers add`/`edit`, positive integer timeout in milliseconds. |
| `--yes` | For mutating verifiers commands, confirm the write after the preview prints; without it nothing changes. |
| `-h` | Short form of --help. |

## Project files

Keys read from files under `.clio-coder/` in the repository.


### `.clio-coder/agents`

| Key | Controls | Precedence |
|---|---|---|
| `(recipe files)` | Project agent recipes (`<id>.md` with the recipe frontmatter schema); a project recipe must declare `audience: custom` and cannot override a shipped builtin. | For non-builtin ids: project `.clio-coder/agents/` > user agents > enabled-extension agents. Builtins remain protected; user recipes alone may customize a shipped base agent, never a shadow or internal agent. |

### `.clio-coder/fleets`

| Key | Controls | Precedence |
|---|---|---|
| `steps[]` | Ordered fleet steps, each with `id`, `kind`, `agent` or `roster`, `run` or `command` or `check`, `dependencies`, `scope`, `writes`, `maxAttempts`, `maxTasks`, `repair`, `commitFrom`, `proposals`, and `path`. |  |
| `version` | Fleet contract schema version in a `<name>.md` frontmatter; the loader refuses another version. |  |

### `.clio-coder/hooks.local.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `(same keys as hooks.yaml)` | Uncommitted per-developer hooks with the same schema as `hooks.yaml`, layered above it by `id`. |  |

### `.clio-coder/hooks.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `hooks[]` | User hook declarations, either a bare list or `{hooks: [...]}`; a project hook with the same `id` as a user or extension hook replaces it, and `hooks.local.yaml` replaces both. | `hooks.local.yaml` > `hooks.yaml` > user hooks > extension hooks, by `id` |
| `hooks[].argv` | Argv list a `command` hook executes without a shell. |  |
| `hooks[].as` | Where a `command` hook's output lands: `annotate` on the tool result or `reminder` as an injected reminder. |  |
| `hooks[].cwd` | Working directory for a `command` hook, defaulting to the session cwd. |  |
| `hooks[].effect` | The middleware effect object an `effect` hook emits, validated like a built-in middleware effect. |  |
| `hooks[].enabled` | `false` keeps the declaration but never fires it, which is how a lower layer's hook is switched off. |  |
| `hooks[].id` | Stable id used for overrides across layers; derived from the source and a content hash when absent. |  |
| `hooks[].kind` | `command` runs an argv and injects its output, `prompt` injects a fixed reminder, `effect` emits one declared middleware effect. |  |
| `hooks[].message` | Reminder text a `prompt` hook injects, truncated to 2000 characters. |  |
| `hooks[].on` | Middleware phase the hook fires on (a `MiddlewareHook` name such as `turn_end` or `tool_result`). |  |
| `hooks[].severity` | Reminder severity for a `prompt` hook (`info`, `warning`, ...), which decides how the reminder is rendered. |  |
| `hooks[].timeoutMs` | Wall-clock cap for a `command` hook, clamped to 100 to 5000 ms. |  |
| `hooks[].tools` | Tool names a tool-scoped hook applies to; absent means every tool. |  |

### `.clio-coder/profile.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `commitMessageStyle` | Commit message style Clio writes in, `conventional`, `descriptive`, or `terse`. | project `.clio-coder/profile.yaml` > user `<configDir>/profile.yaml`, field by field |
| `localOnlyPaths` | Paths the operator marks as never to leave the machine, at most 8 rendered into the prompt. | project `.clio-coder/profile.yaml` > user `<configDir>/profile.yaml`, field by field |
| `responsePosture` | Operator response posture rendered into the prompt, `concise`, `balanced`, or `thorough`. | project `.clio-coder/profile.yaml` > user `<configDir>/profile.yaml`, field by field |
| `validationPreference` | How the operator wants changes validated, `tests-first`, `manual`, or `trust`. | project `.clio-coder/profile.yaml` > user `<configDir>/profile.yaml`, field by field |

### `.clio-coder/prompts`

| Key | Controls | Precedence |
|---|---|---|
| `(prompt templates)` | Markdown prompt templates (`<name>.md`) that become slash commands named after the file, beside the user `prompts/` directory in the config dir. | project `.clio-coder/prompts/` > user `<configDir>/prompts/`, by name |

### `.clio-coder/rules`

| Key | Controls | Precedence |
|---|---|---|
| `description` | One-line summary shown by `clio-coder config inspect`. |  |
| `enabled` | `false` keeps the rule file but never loads it. |  |
| `excludes` | Globs a rule contributes to the project context-exclude set. |  |
| `paths` | Activation globs in a rule's frontmatter; present means the rule loads only while a matching file is in working context, absent means it always loads with project context. |  |

### `.clio-coder/safety.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `commands[]` | Project-declared commands the bash tool may run under a declared action class; each entry is an id plus command line and its own bounds. |  |
| `commands[].actionClass` | Action class (`read`, `edit`, `execute`, ...) the command is admitted as, which decides which autonomy level may run it without approval. |  |
| `commands[].command` | The exact command line the entry admits; a bash call matches it verbatim. |  |
| `commands[].comment` | Free-text note on the entry, informational. |  |
| `commands[].cwd` | Working directory, relative to the workspace root, the command must run in. |  |
| `commands[].env` | Environment policy for the command, `mode` (`none` or `allowlist`) plus `allow`, the variable names passed through. |  |
| `commands[].env.allow` | Environment variable names passed through to the command when `mode` is `allowlist`. |  |
| `commands[].env.mode` | `none` runs the command with the scrubbed base environment; `allowlist` adds the variables named in `allow`. |  |
| `commands[].id` | Stable id the policy engine and receipts name the command by. |  |
| `commands[].maxOutputBytes` | Output byte cap for the command before truncation. |  |
| `commands[].owner` | Free-text owner of the entry, informational. |  |
| `commands[].rationale` | Free-text reason shown beside the command in approvals and receipts. |  |
| `commands[].requireConfirmation` | `true` parks the command for operator approval even at an autonomy level that would otherwise run it. |  |
| `commands[].shellOperators` | `allow` admits pipes, redirects, and chaining in the command line; `deny` refuses them. |  |
| `commands[].timeoutMs` | Wall-clock cap for the command; overrides the bash call's own `timeout_ms`. |  |
| `disableDefaultPathPolicy` | `true` drops the built-in path policy (protected dotfiles, secrets, build outputs) so only the file's own path lists apply. |  |
| `noDeletePaths` | Globs tools may read and write but never delete. |  |
| `noWritePaths` | Globs tools may read and delete but never write. |  |
| `readOnlyPaths` | Globs tools may read but never write or delete. |  |
| `tasks` | Accepted root key reserved for task policy; nothing in the loader reads its value beyond accepting it. |  |
| `version` | Policy file schema version; must be 1. |  |
| `zeroAccessPaths` | Globs no tool may read, write, or list. |  |

### `.clio-coder/settings.local.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `(layered subset of settings.yaml)` | Per-developer, uncommitted settings layered over the project file; credential-bearing keys (`auth`, `apiKey`, `token`, `secret`, `password`) are stripped with a diagnostic. | CLI flags > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user `settings.yaml` > built-in default |

### `.clio-coder/settings.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `(layered subset of settings.yaml)` | Committed team settings; any settings-v2 key except credentials, deep-merged over the user file with arrays replaced wholesale. | CLI flags > `.clio-coder/settings.local.yaml` > `.clio-coder/settings.yaml` > user `settings.yaml` > built-in default |

### `.clio-coder/skills`

| Key | Controls | Precedence |
|---|---|---|
| `(skill directories)` | Project skills (`<name>/SKILL.md`); third-party imports are inert until `integrations.projectResources.trustProjectImports` trusts them. | explicit `--skill` paths > project skills > user skills > catalog skills, by name |

### `.clio-coder/validation.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `(presence)` | The file's presence (also `validation.yml`, root `validation.yaml`, or `VALIDATION.md`) raises the repo-derived rigor default from `normal` to `high`; its content is not read. | `CLIO_CODER_RIGOR` > presence of a validation contract > `normal` |

### `.clio-coder/verifiers.yaml`

| Key | Controls | Precedence |
|---|---|---|
| `checks[]` | Declared verification checks the `verify` tool and `dispatch` intent may name by id, at most 128. |  |
| `checks[].command` | Argv list (no shell) the check runs, at most 64 entries of 4096 bytes. |  |
| `checks[].cwd` | Working directory relative to the workspace root, resolved and bounded to the workspace. |  |
| `checks[].description` | One-line description shown in the `verify` listing, at most 512 bytes. |  |
| `checks[].id` | Check id, at most 64 bytes; `frontend` is reserved for the built-in artifact check. |  |
| `checks[].tags` | Free-form labels, at most 16 of 32 bytes, shown in the listing. |  |
| `checks[].timeoutMs` | Required wall-clock cap for the check in ms, a positive integer at most 900000; a `verify` call may shorten it with `timeout_ms` but not exceed it. |  |
| `version` | Catalog schema version; must equal the version this build speaks. |  |

## Agent recipe frontmatter

Keys the recipe loader reads from `.clio-coder/agents/<id>.md` and the builtin recipes.


| Name | Default | Controls |
|---|---|---|
| `audience` |  | Provenance enum `base \| shadow \| custom \| internal`: builtin recipes name any but `custom`, discovered ones must say `custom`, and it decides catalog visibility and user-origin dispatch reachability. |
| `budget` |  | Required strict worker-loop phase policy object with `toolCalls`, `readReserve`, `synthesis` and optional `maximum`; admission builds the WorkerSpec budget from it under the operator cap. |
| `budget.maximum` |  | Optional `{toolCalls, readReserve}` ceiling at or above the default phase; when present a dispatch may request any phase within it, when absent the recipe pins the default exactly. |
| `budget.maximum.readReserve` |  | Largest read reserve a dispatch or `retryRevision` may request; it must be at least `budget.readReserve` and below `maximum.toolCalls`. |
| `budget.maximum.toolCalls` |  | Largest tool-call phase a dispatch or `retryRevision` may request; it must be at least `budget.toolCalls` and is still clamped by the operator cap. |
| `budget.readReserve` |  | Tail of the admitted phase reserved for canonical `read` plus delivery tools; the loop guard blocks other tools once `toolCalls` minus `readReserve` calls are admitted, and it is zero without `read`. |
| `budget.synthesis` |  | Boolean where `true` locks tools at the boundary and grants a text-only synthesis round, and `false` fails the run with `worker agent budget reached` at the boundary. |
| `budget.toolCalls` |  | Admitted tool calls before the final-response phase (must be > 0); the loop guard uses it as the worker's soft limit and derives the loop-block budget from it. |
| `capabilityClass` |  | Enum `read-only \| artifact-write \| workspace-edit \| verification \| orchestration \| internal`; it is the authority a dispatch requests and approves and derives the default project-context tier. |
| `category` |  | Enum `explore \| plan \| research \| implement \| quality \| science \| evolution \| operations \| internal` used to sort and label the catalog. |
| `description` |  | Required non-empty string shown in the catalog and used to derive the fleet prompt purpose line. |
| `latencyClass` |  | Enum `fast \| balanced \| deep` that sets the route prior when candidate agents are ranked for a dispatch. |
| `name` |  | Required non-empty display name rendered in catalog and agent listings. |
| `product` |  | Optional enum (only `orientation`) naming what the run delivers, which adds `code_nav` to the delivery tools admitted inside the read reserve; a misspelling is a parse error. |
| `projectContextTier` |  | Enum `none \| bounded`; `bounded` injects the capped project name/conventions/invariants projection as a dynamic message and `none` skips the CLIO-CODER.md read. |
| `resultContract` |  | Required object naming the typed result shape the worker must return; the terminal output is validated and repaired against it. |
| `resultContract.kind` |  | One of twelve recipe-declarable report kinds (`scout-report`, `mutation-report`, `delegation-plan`, ...) or `architect-plan`; `council-ballot` may only arrive as a coordinator override. |
| `resultContract.path` |  | Workspace-relative plan file path required only by `architect-plan` and refused for any other kind; absolute or `..` paths are rejected. |
| `skills` |  | Array of unique skill names bound to files at registry load; they inject knowledge into the prompt, require the `context` tool, and never widen tool authority. |
| `tags` |  | Array of unique lowercase routing hints shown in the catalog and matched against task signals when ranking candidate agents. |
| `tools` |  | Object `{required, optional}` of unique tool names, where a required entry may be `{anyOf: [...]}`; a required tool that does not admit on the target makes the recipe unusable there. |
| `version` |  | Recipe schema version; only the integer 1 is accepted. |

## Prompt fragment frontmatter

Keys the fragment loader reads.


| Name | Default | Controls |
|---|---|---|
| `description` |  | Required non-empty string describing the fragment; the loader rejects a missing one and nothing downstream reads it. |
| `dynamic` |  | Optional boolean marking a fragment as dynamic (rendered as a per-session message rather than part of the stable system prompt); it must be a boolean when present. |
| `id` |  | Required dot-separated namespace id (`identity.clio`) the compiler looks fragments up by; a duplicate or non-matching id fails loading. |
| `version` |  | Fragment schema version; the loader accepts only the integer 1. |

## Tool arguments

Arguments the model can send on `dispatch`, `bash`, `context`, and `verify`, grouped by tool. The `class` column is the admission class the argument belongs to.


### `bash`

| Argument | Class | Controls |
|---|---|---|
| `bash.command` | task | Bash command to execute. |
| `bash.cwd` | task | Omit unless the command must run in a subdirectory of the workspace root, given as a relative path; outside the root is blocked. |
| `bash.output_policy` | policy | Model-context disposition. Omit for bounded tail output. Use summary for noisy runs, metadata-only when only status and retrieval matter, and full only for known-small output. |
| `bash.timeout_ms` | policy | Timeout in milliseconds. |

### `context`

| Argument | Class | Controls |
|---|---|---|
| `context.include_tree` | policy | scope=skills: list files under the skill base_dir. |
| `context.limit` | policy | scope=docs: max sections (default 5, max 12). |
| `context.name` | task | scope=skills: skill name to load; omit to list. |
| `context.query` | task | scope=docs: question or terms; omit to list the corpus. |
| `context.ref` | task | scope=recall: ref of the evicted item, as named in its marker. |
| `context.scope` | policy | Context source. |

### `dispatch`

| Argument | Class | Controls |
|---|---|---|
| `dispatch.$defs.budget` | policy | Reusable tool-call budget object referenced from the top level and from every task; a budget outside the recipe's declared range is refused at admission. |
| `dispatch.$defs.budget.readReserve` | policy | Tail of the budget kept for verification reads and synthesis; non-read calls inside the reserve are blocked. |
| `dispatch.$defs.budget.retryRevision` | policy | Preauthorized budget for one retry or revision phase (a review `revise` re-run), so the re-run needs no second approval. |
| `dispatch.$defs.budget.retryRevision.readReserve` | policy | Read reserve for the retry or revision phase. |
| `dispatch.$defs.budget.retryRevision.toolCalls` | policy | Tool-call ceiling for the retry or revision phase. |
| `dispatch.$defs.budget.toolCalls` | policy | Tool calls the worker may spend before the synthesis reserve window opens; must sit within the recipe's `budget.toolCalls` to `budget.maximum.toolCalls` range. |
| `dispatch.$defs.intent` | policy | Repository-relative paths and outputs. Declare it on every dispatch: it selects the project rules that apply and pins worker context, where omitting it falls back to path tokens scraped from the task text. verification entries are declared check ids from package scripts or .clio-coder/verifiers.yaml. Per-task intent must fit inside the top-level intent. |
| `dispatch.$defs.intent.expected_outputs` | task | Paths the worker is expected to produce, so a missing output is reported instead of guessed. |
| `dispatch.$defs.intent.read_roots` | task | Repository-relative roots the worker may read; `.` means the repository root; at most 32 entries of 512 bytes. |
| `dispatch.$defs.intent.relevant_paths` | task | Paths the parent already knows matter; they pin worker context and select the project rules that apply. |
| `dispatch.$defs.intent.verification` | policy | Declared check ids to run after the receipt, at most 8, never shell commands; `[{check: "none"}]` normalizes to no checks. |
| `dispatch.$defs.intent.verification[].check` | task | Declared check id, never a shell command. |
| `dispatch.$defs.intent.verification[].timeout_ms` | policy | Within the check's declared bounds. |
| `dispatch.$defs.intent.write_roots` | task | Repository-relative roots the worker may write; the receipt's write set is held against them. |
| `dispatch.agent` | policy | Default recipe id for string tasks, or auto (default coder; researcher for council). |
| `dispatch.apply` | policy | merge (default) or preserve the worktree branch. |
| `dispatch.apply_winner` | policy | Merge a preserved compete winner and clean up its group; supervised autonomy parks this for operator confirmation. |
| `dispatch.apply_winner.branch` | task | Preserved winner branch: clio-coder/compete/<group>/<n>. |
| `dispatch.apply_winner.cwd` | task | Repository root (default: current directory). |
| `dispatch.briefing` | task | Parent context for task, or the shared default for tasks; never instructions. Max 12000 UTF-8 bytes. |
| `dispatch.budget` | policy | Default tool-call budget for the call (`$defs.budget`); a task's own `budget` overrides it. |
| `dispatch.candidates` | policy | Compete candidates, 2 to 4 (default 2). |
| `dispatch.cwd` | policy | Default worker working directory. |
| `dispatch.detach` | policy | Return run ids immediately and collect with monitor before final synthesis. Parallel mode only. |
| `dispatch.from_scout` | task | Compile a Scout split result into one approval-gated dependency plan; use with no other argument. |
| `dispatch.from_scout.receipt_digest` | task | Its sha256 receipt digest. |
| `dispatch.from_scout.run_id` | task | Terminal Scout run id. |
| `dispatch.gate` | policy | One declared check id, shorthand for intent.verification. |
| `dispatch.intent` | policy | Batch-level intent (`$defs.intent`); every per-task intent must fit inside it, and omitting it falls back to path tokens scraped from the task text. |
| `dispatch.judge` | policy | Read-only judge that ranks compete candidates. |
| `dispatch.judge.agent` | policy | Judge recipe id (default: the builder's agent). |
| `dispatch.judge.model` | policy | Model for the compete judge; defaults to the builder's model. |
| `dispatch.judge.node` | policy | Fleet node pin for the judge. |
| `dispatch.judge.target` | policy | Target id for the compete judge; defaults to the builder's target. |
| `dispatch.list` | policy | List the agent roster instead of dispatching. |
| `dispatch.max_output_bytes` | policy | Max summary bytes returned. |
| `dispatch.members` | policy | Explicit council members, 2 to 5. |
| `dispatch.members[].label` | task | Council member label, unique within the call, matching `^[a-z][a-z0-9_-]{0,31}$`. |
| `dispatch.members[].model` | policy | Model this council member answers with. |
| `dispatch.members[].target` | policy | Target id this council member runs on. |
| `dispatch.members[].thinking` | policy | Thinking level for this council member: off, minimal, low, medium, high, xhigh, or max. |
| `dispatch.mode` | policy | parallel (default); sequential; pipeline, where each task receives the previous output; compete, where candidates build the same task in scratch worktrees and a judge picks; council, where roster members answer the same question. |
| `dispatch.model` | policy | Default model override. |
| `dispatch.node` | policy | Default fleet node pin (omit for automatic placement). |
| `dispatch.persona` | task | Default persona for the batch, max 8000 chars. |
| `dispatch.review` | policy | Reviewer gate for one task: a read-only reviewer verdicts pass, revise, or fail, and revise re-runs the builder with the findings. |
| `dispatch.review.max_cycles` | policy | Review/revise cycles before an operator decision (default 2, max 4). |
| `dispatch.review.model` | policy | Model for the reviewer. |
| `dispatch.review.node` | policy | Fleet node pin for the reviewer. |
| `dispatch.review.reviewer` | policy | Reviewer recipe id (default: the builder's agent, read-only). |
| `dispatch.review.target` | policy | Target for the reviewer. |
| `dispatch.roster` | policy | Configured `fleet.rosters` name (council). |
| `dispatch.rounds` | policy | Council rounds. |
| `dispatch.routing` | policy | Advisory posture and hard routing bounds; exact target, model, and node pins stay manual. |
| `dispatch.routing.deadlineMs` | policy | Hard latency bound in ms the planner must meet; routes predicted slower are excluded. |
| `dispatch.routing.failover` | policy | `approved` lets a failed route fail over to the next admitted one; `none` fails the run. |
| `dispatch.routing.locality` | policy | Whether the run may leave local endpoints: `local-only`, `prefer-local`, or `any`. |
| `dispatch.routing.maxCostUsd` | policy | Hard USD bound per run for adaptive routing; a route whose estimate exceeds it is not admitted. |
| `dispatch.routing.minimumQuality` | policy | Minimum quality score, 0 to 1, a candidate route must carry to be admitted. |
| `dispatch.routing.posture` | policy | Advisory posture the joint route planner optimizes for; `manual` keeps exact pins, the adaptive postures apply only to roles enabled in `fleet.adaptiveRouting`. |
| `dispatch.routing.requiredCapabilities` | policy | Capability ids (`tools`, `vision`, ...) a route's model must advertise. |
| `dispatch.synthesis` | policy | Council synthesis. |
| `dispatch.target` | policy | Default target id (omit for the fleet default). |
| `dispatch.task` | task | One worker assignment. Use tasks for a batch. |
| `dispatch.tasks` | task | Batch of assignments; one string or object is wrapped. |
| `dispatch.tasks[].agent` | policy | Recipe id (default coder). |
| `dispatch.tasks[].briefing` | task | Per-task parent context, max 12000 UTF-8 bytes. |
| `dispatch.tasks[].budget` | policy | Per-task budget override (`$defs.budget`). |
| `dispatch.tasks[].gate` | policy | One declared check id, shorthand for intent.verification. |
| `dispatch.tasks[].intent` | policy | Per-task intent (`$defs.intent`); it must fit inside the batch `intent`. |
| `dispatch.tasks[].model` | policy | Per-task model override. |
| `dispatch.tasks[].node` | policy | Fleet node pin: local or a fleet.nodes id. |
| `dispatch.tasks[].target` | policy | Per-task target id override. |
| `dispatch.tasks[].task` | task | The assignment, with expected output and constraints. |
| `dispatch.tasks[].worktree` | policy | Run this writer in an isolated git worktree. |
| `dispatch.thinking_level` | policy | Thinking level for every worker in the call: off, minimal, low, medium, high, xhigh, or max. |
| `dispatch.timeout_ms` | policy | Abort the dispatch after this many ms. |
| `dispatch.tool_profile` | policy | Default worker tool profile. |
| `dispatch.worktree` | policy | Run a singular writer task in an isolated git worktree. |
| `dispatch.writers` | policy | Serialize writer admission in task order while readers run concurrently. |

### `verify`

| Argument | Class | Controls |
|---|---|---|
| `verify.args` | task | Package scripts only: arguments after --. |
| `verify.browser` | policy | frontend: headless browser mode (default auto). |
| `verify.check` | policy | Check id, package script (test*/lint*/build*/typecheck*/check*/format*/ci*), or "frontend"; omit to list. |
| `verify.cwd` | task | Package scripts only: working directory. |
| `verify.max_output_bytes` | policy | Output cap in bytes (default 600000). |
| `verify.path` | task | frontend: artifact file under the workspace root. |
| `verify.timeout_ms` | policy | Package and frontend checks only: timeout in ms. |

## Model knowledge-base tags

Keys of the local-model knowledge base in `src/domains/providers/models/local-models/`.


| Name | Default | Controls |
|---|---|---|
| `capabilities` |  | Object of `CapabilityFlags` a knowledge-base entry contributes; it is merged over runtime defaults and under target overrides to build the synthesized model. |
| `capabilities.audio` |  | Boolean audio-input flag carried into CapabilityFlags for badges and dashboards; no request builder reads it. |
| `capabilities.chat` |  | Boolean saying the model serves chat; feeds runtime resolution and the `C` badge in `targets` and `models` output. |
| `capabilities.contextWindow` |  | Token context window of the synthesized model unless a probe or configured target value overrides it; drives compaction pressure and context-floor warnings. |
| `capabilities.embeddings` |  | Boolean embeddings flag carried into CapabilityFlags for the `E` badge and dashboards; no request builder reads it. |
| `capabilities.fim` |  | Boolean fill-in-the-middle flag for the `F` badge and dashboards; no request builder reads it. |
| `capabilities.maxTokens` |  | Default max output tokens of the synthesized model unless a probe or target override supplies one; bounds per-turn output and Anthropic-style thinking budgets. |
| `capabilities.reasoning` |  | Boolean that marks the synthesized model as reasoning-capable and, with `quirks.thinking.mechanism`, decides whether thinking fields are sent at all. |
| `capabilities.rerank` |  | Boolean rerank flag for the `K` badge and dashboards; no request builder reads it. |
| `capabilities.structuredOutputs` |  | Structured-output mode (`json-schema`, `gbnf`, `xgrammar`, `none`); only `json-schema` lets a dispatch `responseSchema` be enforced on the worker request. |
| `capabilities.thinkingFormat` |  | Thinking wire format (`qwen-chat-template`, `harmony`, `deepseek-r1`, ...) copied into the OpenAI compat block and used to infer the thinking mechanism when quirks omit one. |
| `capabilities.toolCallFormat` |  | Declared tool-call dialect (`openai`, `qwen`, `hermes`, ...) validated on targets and worker specs; no request builder currently branches on it. |
| `capabilities.tools` |  | Boolean tool-calling flag; `supportsTools` gates tool attachment and the `T` badge. |
| `capabilities.vision` |  | Boolean that sets the synthesized model's `input` to text plus image so image blocks are accepted. |
| `family` |  | Canonical family id; a pattern equal to it counts as a `family` match, and the id lands on `model.clioCoder.family`, where `openai-gpt-oss` selects Harmony handling. |
| `matchPatterns` |  | Lowercase substrings matched against the wire model id; the longest matching pattern across the whole knowledge base selects the entry. |
| `quirks` |  | Free-form object per entry; `extractLocalModelQuirks` narrows `sampling`, `thinking`, and accepted chat-template kwargs into `model.clioCoder.quirks`, while unrecognized keys remain provenance. |
| `quirks.chatTemplate` |  | Names the chat-template dialect (`gemma-channel`) a family uses; provenance only; nothing in src reads it. |
| `quirks.gpuTiers` |  | Map of GPU memory tier (`32gb`) to a free-text serving recommendation; provenance only; nothing in src reads it. |
| `quirks.gpuTiers.<gpuTiers>` |  | One tier's recommendation text keyed by memory class; provenance only; nothing in src reads it. |
| `quirks.leakageNote` |  | Free-text explanation of how a template leaks chain-of-thought markers into visible text; provenance only; nothing in src reads it. |
| `quirks.llamaCpp` |  | Recommended llama.cpp server-start profile for the family; provenance only; nothing in src reads it (the probe reads the running server's argv instead). |
| `quirks.llamaCpp.batchSize` |  | Recommended `--batch-size` for starting the server; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.cacheTypeK` |  | Recommended `--cache-type-k` for starting the server; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.cacheTypeV` |  | Recommended `--cache-type-v` for starting the server; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.chatTemplateKwargs` |  | Recommended `--chat-template-kwargs` map for the server start (for example `enable_thinking: false`); provenance only; nothing in src reads it. |
| `quirks.llamaCpp.chatTemplateKwargs.<chatTemplateKwargs>` |  | One template kwarg name and its value; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.ctxSize` |  | Recommended `--ctx-size`; provenance only; nothing in src reads it (the live window comes from the probe or `capabilities.contextWindow`). |
| `quirks.llamaCpp.flashAttn` |  | Recommended `--flash-attn`; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.mmproj` |  | Says the server should load the multimodal projector (`--mmproj`); provenance only; nothing in src reads it (the probe infers vision from the running argv). |
| `quirks.llamaCpp.nGpuLayers` |  | Recommended `--n-gpu-layers`; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.parallel` |  | Recommended `--parallel` slot count for starting the server; provenance only; nothing in src reads it, and admission uses the server's reported `total_slots` instead. |
| `quirks.llamaCpp.parallelSlots` |  | Free-text note on what `--parallel` means for admission and `--kv-unified`; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.reasoning` |  | Recommended `--reasoning` server default (`on`); provenance only; nothing in src reads it. |
| `quirks.llamaCpp.reasoningEffort` |  | Recommended `--reasoning-effort` server default; provenance only; nothing in src reads it, and per-request effort comes from `quirks.thinking.effortByLevel`. |
| `quirks.llamaCpp.specDraftNMax` |  | Recommended `--spec-draft-n-max` for speculative decoding; provenance only; nothing in src reads it. |
| `quirks.llamaCpp.specType` |  | Recommended speculative decoding type (`draft-mtp`); provenance only; nothing in src reads it. |
| `quirks.llamaCpp.ubatchSize` |  | Recommended `--ubatch-size`; provenance only; nothing in src reads it. |
| `quirks.measuredUnder` |  | Provenance block naming the hardware, runtime, build and flags a family's quirks were measured under; nothing in src reads it, as the file header states. |
| `quirks.measuredUnder.alsoMeasuredOn` |  | Second host or runtime the same figures were confirmed on; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.build` |  | Runtime build string of the measurement, or `unknown`; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.date` |  | Date of the measurement, or `unknown`; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.hardware` |  | GPU class the measurement ran on; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.llamaCpp` |  | The llama.cpp argv or flag summary the measurement ran under; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.model` |  | Exact quantized model file and architecture measured; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.note` |  | Free-text caveats about which figures in the entry are actually measured; provenance only; nothing in src reads it. |
| `quirks.measuredUnder.runtime` |  | Runtime id the measurement used (`llamacpp`); provenance only; nothing in src reads it. |
| `quirks.measuredUnder.source` |  | Release note or report the figures were taken from, or `unknown`; provenance only; nothing in src reads it. |
| `quirks.runtimePreference` |  | Map of runtime id to a free-text recommendation on how to serve the family there; provenance only; nothing in src reads it. |
| `quirks.runtimePreference.<runtimePreference>` |  | One runtime's (`llamaCpp`, `openaiCompat`, `lmstudioOpenaiCompat`, ...) recommendation text; provenance only; nothing in src reads it. |
| `quirks.sampling` |  | Per-mode sampler profiles extracted into `model.clioCoder.quirks.sampling`; the OpenAI-completions and Ollama builders pick `thinking` when thinking is active, else `instruct`. |
| `quirks.sampling.instruct` |  | Sampler profile applied when the thinking level is `off`, and the fallback when no `thinking` profile exists. |
| `quirks.sampling.instruct.minP` |  | Sent as `min_p` in `samplingParams` on OpenAI-compatible requests when thinking is off; Ollama native ignores it. |
| `quirks.sampling.instruct.presencePenalty` |  | Sent as `presence_penalty` on OpenAI-compatible and Ollama requests when thinking is off, unless a run override sets it. |
| `quirks.sampling.instruct.repeatPenalty` |  | Sent as `repeat_penalty` on OpenAI-compatible and Ollama requests when thinking is off; preferred over `repetitionPenalty` when both are present. |
| `quirks.sampling.instruct.repetitionPenalty` |  | HF model-card spelling of `repeatPenalty`, accepted as an alias and sent as `repeat_penalty` when thinking is off. |
| `quirks.sampling.instruct.temperature` |  | Request `temperature` when thinking is off, applied only if the caller set none. |
| `quirks.sampling.instruct.topK` |  | Sent as `top_k` when thinking is off on OpenAI-compatible and Ollama requests. |
| `quirks.sampling.instruct.topP` |  | Sent as `top_p` when thinking is off on OpenAI-compatible and Ollama requests. |
| `quirks.sampling.thinking` |  | Sampler profile applied when the thinking level is not `off`. |
| `quirks.sampling.thinking.minP` |  | Sent as `min_p` in `samplingParams` on OpenAI-compatible requests while thinking is active; Ollama native ignores it. |
| `quirks.sampling.thinking.presencePenalty` |  | Sent as `presence_penalty` while thinking is active on OpenAI-compatible and Ollama requests. |
| `quirks.sampling.thinking.reasoningBudget` |  | Documented per-request reasoning budget; not a `SamplingProfile` field, so the extractor drops it and budgets come from `quirks.thinking.budgetByLevel` instead. |
| `quirks.sampling.thinking.repeatPenalty` |  | Sent as `repeat_penalty` on OpenAI-compatible and Ollama requests while thinking is active; preferred over `repetitionPenalty` when both are present. |
| `quirks.sampling.thinking.repetitionPenalty` |  | HF spelling of `repeatPenalty` for thinking mode, sent as `repeat_penalty`. |
| `quirks.sampling.thinking.temperature` |  | Request `temperature` while thinking is active, applied only if the caller set none. |
| `quirks.sampling.thinking.topK` |  | Sent as `top_k` while thinking is active on OpenAI-compatible and Ollama requests. |
| `quirks.sampling.thinking.topP` |  | Sent as `top_p` while thinking is active on OpenAI-compatible and Ollama requests. |
| `quirks.serving` |  | One-line free-text summary of the recommended serving profile; provenance only; nothing in src reads it. |
| `quirks.thinking` |  | Typed thinking-control block extracted into `model.clioCoder.quirks.thinking`; it decides which thinking fields a request carries and how the TUI labels levels. |
| `quirks.thinking.budgetByLevel` |  | Map of Clio thinking level to a token budget for the `budget-tokens` mechanism; it feeds `thinking_token_budget` on vLLM and Pi `thinkingBudgets`, and limits the selectable levels. |
| `quirks.thinking.budgetByLevel.<budgetByLevel>` |  | Integer budget for one of `minimal`, `low`, `medium`, `high`, `xhigh`; levels without an entry are not offered. |
| `quirks.thinking.chatTemplateKwargs` |  | Family-specific static and thinking-level template kwargs extracted into the request capability. Supported OpenAI-compatible adapters emit them as `chat_template_kwargs`; native LM Studio ignores that field, so the resolver names the keys as undeliverable and resolution prints one warning per target and model instead of sending them. Mechanism-owned thinking controls win key collisions. |
| `quirks.thinking.chatTemplateKwargs.byLevel` |  | Declares one template kwarg whose value is selected from the effective thinking level, falling back to the configured level when needed. |
| `quirks.thinking.chatTemplateKwargs.byLevel.key` |  | Non-empty wire key for the level-selected kwarg, such as `reasoning_strength`. |
| `quirks.thinking.chatTemplateKwargs.byLevel.lmstudio` |  | `unsupported` records that the family documents LM Studio as unable to carry the level-keyed kwarg, and the undeliverable-kwargs warning says so; any other text is retained as provenance. Native LM Studio never receives `chat_template_kwargs` either way. |
| `quirks.thinking.chatTemplateKwargs.byLevel.values` |  | Map from accepted Clio thinking levels to non-empty strings or finite numbers; for an `effort-levels` family, its keys also constrain the levels offered. |
| `quirks.thinking.chatTemplateKwargs.byLevel.values.<thinkingLevel>` |  | Wire value for one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; unsupported keys and invalid values are dropped. |
| `quirks.thinking.chatTemplateKwargs.lmstudio` |  | `unsupported` records that the family documents LM Studio as unable to carry its kwargs, and the undeliverable-kwargs warning says so; any other string or string map is retained as provenance. Native LM Studio omits the template-kwargs map either way. |
| `quirks.thinking.chatTemplateKwargs.static` |  | Literal template kwargs merged into every request for the family before mechanism-owned thinking controls. Values may be booleans, non-empty strings, or finite numbers. |
| `quirks.thinking.chatTemplateKwargs.static.<chatTemplateKwargs>` |  | One literal wire key and value, such as `force_nonempty_content: true` or numeric `reasoning_budget: 16384`. |
| `quirks.thinking.effortByLevel` |  | Map of Clio thinking level to the vendor `reasoning_effort` string for the `effort-levels` mechanism; it sets `request.reasoningEffort` and limits the selectable levels. |
| `quirks.thinking.effortByLevel.<effortByLevel>` |  | Effort string sent for one of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; levels without an entry are not offered. |
| `quirks.thinking.guidance` |  | Two to five lines of model-stable thinking guidance rendered into the compiled system prompt's Runtime block through `thinkingGuidance`. |
| `quirks.thinking.mechanism` |  | One of `effort-levels`, `budget-tokens`, `on-off`, `always-on`, `none`; it picks the thinking payload shape, reasoning class and level labels, overriding inference from `thinkingFormat`. |
| `quirks.thinkingControl` |  | Free-text note on how a family's template gates thinking (for example a `<\|think\|>` system token); provenance only; nothing in src reads it. |

## Bounding constants

Compiled-in limits (context budgets, retry counts, cache sizes, timeouts) are code-owned invariants, not configuration. They live beside the code that enforces them and change only through a source change with a changelog line.
