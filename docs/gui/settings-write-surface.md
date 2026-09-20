# GUI settings write surface

## 0. The correction that makes this artifact necessary

The source table in `apps/workbench/HARNESS_COVERAGE.md` has **27 rows, not 29**. More importantly, **every group name in it is a retired v1 key.** `src/core/defaults.ts:490` pins `version: 2`, and `src/core/config.ts` holds `V1_ONLY_ROOTS`, the set of roots that exist only to be migrated away from:

```
identity, autonomy, runtimePlugins, orchestrator, background, memory, watchdog,
workers, routing, scope, modelSelector, budget, defaults, theme, terminal,
skills, library, attribution, delegation, keybindings, compaction, prewarm,
panes, retry, guardrails
```

That is 22 of the 27 audited group names. A settings form built from the extracted table would bind to keys the validator rejects.

**Settings v2 has exactly eight roots:** `version`, `targets`, `chat`, `fleet`, `context`, `safety`, `interface`, `integrations`.

Four v1 paths were **retired outright**, not moved (`SETTINGS_V1_RETIRED_PATHS`). Never resurrect them:

| Retired path | Reason (verbatim) |
| --- | --- |
| `identity` | it was accepted and ignored; no behavior is lost |
| `background.thinkingLevel` | proactive memory always resolves thinking off |
| `theme` | the only registered theme was not read by runtime rendering |
| `compaction.excludeLastTurns` | only the temporary legacy mask used it; `context.workingSet.protectLastTurns` remains |

## 1. Do not hand-maintain the allowlist — derive it

`src/core/settings-controls.ts` already exports a machine-generated registry over every v2 leaf:

```ts
export interface SettingControl {
	path: string;
	label: string;
	description: string;
	help?: string | undefined;
	choices?: readonly string[] | undefined;
	kind: "boolean" | "number" | "string" | "list" | "json";
	optional: boolean;
	readOnly: boolean;
}
export const SETTING_CONTROLS: readonly SettingControl[];
export function settingControl(path: string): SettingControl | undefined;
export function applyControlValue(settings: ClioSettings, path: string, text: string): void;
export function controlInstructions(control: SettingControl): string;
```

It walks `DEFAULT_SETTINGS` recursively (`collectControlPaths`), treats a set of `STRUCTURED` paths as opaque JSON leaves, excludes `version` and `targets`, and attaches label/description/help from three parallel maps. `applyControlValue` runs the **cross-field** validation the GUI must not reimplement:

- a `*.target` must name an existing `targets[].id`;
- `chat.target` and `context.memory.target` additionally require an orchestrator-eligible runtime ("Chat and memory need an HTTP/native connection; this connection is for workers only.");
- changing a `*.target` **nulls the matching `*.model`**;
- a `*.model` without a `*.target` is rejected;
- `fleet.default.node` must be `local`, a configured node id, or cleared;
- every `fleet.profiles` entry must name an existing connection, and every `fleet.agentProfiles` value must name an existing profile;
- `chat.modelPicker.favorites` must survive `validateSettings` unchanged or it is rejected.

**Build the GUI form from `SETTING_CONTROLS` plus a policy overlay (this document's verdict column). Do not transcribe paths into TypeBox by hand.** A leaf added to `DEFAULT_SETTINGS` then appears in the GUI automatically, and one removed disappears, which is the drift this table exists to prevent.

## 2. Apply timing is already classified — surface it, do not guess it

`src/domains/config/classify.ts` is the authority. `settingsChangeKind(path)` returns `hotReload | nextTurn | restartRequired`, prefix-matched, **defaulting to `restartRequired` for anything unrecognized**. Every control in the GUI must render its timing. The exact sets:

**hotReload** (a running session applies it immediately): `interface.keybindings`, `safety.autonomy`, `chat.modelPicker`, `interface.outputDetail`, `interface.demo`, `interface.smoothStreaming`, `interface.panes.notifications`, `integrations.git.commitAttribution`, `interface.panes.files`, `safety.review`.

**nextTurn** (used by the next relevant request, dispatch, or explicit open): `targets`, `chat`, `fleet.default`, `fleet.profiles`, `fleet.rosters`, `fleet.agentProfiles`, `fleet.adaptiveRouting`, `fleet.nodes`, `fleet.permissions`, `fleet.retry`, `fleet.worktrees`, `fleet.limits`, `fleet.history`, `context`, `safety.limits`, `interface.terminalProgress`, `interface.desktopNotifications`, `integrations.projectResources`, `integrations.externalAgents`, `integrations.library`.

**restartRequired** (takes effect in the next session): `fleet.concurrency`, `interface.mode`, `interface.fullscreenScrollbar`, `interface.panes.enabled`, `integrations.runtimePlugins`.

The operator-facing sentences the TUI uses, from `controlInstructions`, verbatim: `"A running session can apply this immediately."` / `"Used by the next relevant request, dispatch, or explicit open."` / `"Takes effect in the next session."`

## 3. Section and group taxonomy — reuse it, do not invent one

`src/core/settings-navigation.ts` defines the eight sections the TUI and `configure` share. The GUI should use the same labels so the docs, the TUI and the GUI say the same words.

| id | Label | Description | Aliases |
| --- | --- | --- | --- |
| `targets` | Connections | Providers, endpoints, credentials, and available models. | connections, connection, auth, target, providers |
| `chat` | Chat | Chat model, thinking, model favorites, response length, and retries. | orchestrator, models, model, thinking, retry |
| `fleet` | Fleet | Worker models, profiles, routing, concurrency, retries, and run limits. | workers |
| `context` | Context & Memory | Context size, compaction, working set, and proactive memory. | compaction, memory |
| `safety` | Permissions & Limits | Autonomy, approval rules, spending limits, and safety review. | permissions, autonomy, budget, watchdog |
| `interface` | Appearance | Display, streaming, notifications, panes, and keyboard shortcuts. | appearance, terminal, panes, pane, layout |
| `integrations` | Integrations | Project skills, external agents, plugins, library, and Git attribution. | skills, skill, extensions, interop |
| `advanced` | Advanced | Diagnostics, configuration files, and the full settings editor. | all, settings, diagnostics, doctor, diag |

`settingsSectionForPath` routes by root with three deliberate exceptions that put policy together: `safetyNet`, `fleet.permissions.*`, and `integrations.externalAgents.defaults.toolGovernance` all route to **safety**, not to their own root. `settingsGroupForPath` supplies the sub-headings (Model picker, Recovery, Model & responses, Proactive memory, Compaction, Working set, Context limits, Worker approvals, Default model, Profiles, Agent routes, Automatic routing, Placement & capacity, Run history, Execution limits & recovery, Safety review, Spending & tool limits, External agent permissions, Autonomy, Files pane, Panes & layout, Display & keyboard, Resource library, External agents, Skills, plugins & Git).

## 4. What is writable over ACP *today*

`src/engine/acp/server.ts:1297`:

```ts
const ACP_SAFE_SETTINGS_KEYS = ["chat.target", "chat.model", "chat.thinkingLevel", "safety.autonomy"] as const;
```

served by `clio-coder/settings/get_safe` and `clio-coder/settings/patch_safe`, and mirrored exactly in `apps/clio-coder-gui/contracts/settings-safe.ts` as `SAFE_SETTINGS_KEYS`. **Anything wider than these four must be written by the GUI's own Hono server through the settings file, not through ACP** — which is legitimate, because the new app's server is a local process with file access, unlike the workbench's browser. That architectural difference is what unlocks the table below.

## 5. THE COVERAGE TABLE — v2 paths, with an explicit GUI verdict

Verdicts: **WRITABLE** (expose an editing control), **READ-ONLY-WITH-PROVENANCE** (show the effective value and where it came from; no control), **HIDDEN** (do not render at all).

### Root: `version` · `targets`

| v2 path | v1 row it replaces | Contains | Verdict | Reason |
| --- | --- | --- | --- | --- |
| `version` | `version` — "Hidden. Schema metadata, diagnostics only." | Literal `2`. | **HIDDEN** | Schema metadata. `SETTING_CONTROLS` already filters it out. Surface it only in a diagnostics panel. |
| `targets[]` | `targets` — "**Partial**. Read/probe/select plus offline model capabilities exist. URLs, secrets, authoring, conversion, and removal need typed host operations." | Array of target descriptors: id, runtime, baseUrl, models, `ollama.numCtx`, `maxConcurrentRequests`, credentials. | **READ-ONLY-WITH-PROVENANCE** for the list; **WRITABLE via dedicated flows only** for lifecycle. | Also excluded from `SETTING_CONTROLS` on purpose: a target is a record with a lifecycle, not a leaf. Drive it through `targets add/use/remove/rename/probe` equivalents (the new app already has `/use`, `/remove`, `/probe`). **Never render a credential field.** |

### Root: `chat` (replaces v1 `orchestrator`, `scope`, `modelSelector`, `defaults.maxTokens`, `prewarm`, `retry`)

| v2 path | Kind / choices | Default | Timing | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `chat.target` | string, optional | `null` | nextTurn | **WRITABLE** | Already in `ACP_SAFE_SETTINGS_KEYS`. Must be a select over `targets[].id` — free text will be rejected by `applyControlValue`. Changing it nulls `chat.model`; the UI must show that. |
| `chat.model` | string, optional | `null` | nextTurn | **WRITABLE** | Safe key. Requires `chat.target` first. |
| `chat.thinkingLevel` | enum `off\|minimal\|low\|medium\|high\|xhigh\|max` | `low` | nextTurn | **WRITABLE** | Safe key. The v1 row said "Target/model/thinking with next-turn timing" — still exactly right. |
| `chat.modelPicker.cycleSet` | list | `[]` | hotReload | **WRITABLE** | v1 `scope` — "Model-cycle scope; typed setting and model catalog required." The catalog now exists (offline model inventory), so this is buildable: a multi-select over target/model refs. |
| `chat.modelPicker.favorites` | list | `[]` | hotReload | **WRITABLE** | v1 `modelSelector` — "useful in the graphical picker after safe settings expand." Validated: entries must be `target-id/model-id` from an existing connection. |
| `chat.modelPicker.recentLimit` | number | `12` | hotReload | **WRITABLE** | Harmless bound. |
| `chat.maxOutputTokens` | number | `0` | nextTurn | **WRITABLE** | v1 `defaults.maxTokens` — "explain model/context clamps rather than promising the requested number." Keep that instruction: the help text says it is clamped down to each model's max-output cap and remaining window, and `0` means per-model caps only. |
| `chat.prewarm` | boolean | `false` | nextTurn | **WRITABLE** | v1 `prewarm.enabled` was "None — needs safe setting and reported prewarm/cache outcome." The control is safe on its own; ship it with the honest caveat from the help text (local-native targets and interactive sessions only) and **never infer a cache hit from latency** — that rule from the v1 row still stands. |
| `chat.retry.enabled` | boolean | `true` | nextTurn | **WRITABLE** | v1 `retry` — "needs retry status events and next-turn setting." The setting half is real today; ship the control, leave the status display blocked on the event work. |
| `chat.retry.maxRetries` | number | `3` | nextTurn | **WRITABLE** | |
| `chat.retry.baseDelayMs` | number | `2000` | nextTurn | **WRITABLE** | |
| `chat.retry.maxDelayMs` | number | `60000` | nextTurn | **WRITABLE** | |
| `chat.retry.streamStallMs` | number | `180000` | nextTurn | **WRITABLE** | Measured from the last token, not the request, so a slow-but-alive stream is never aborted. Say so in the control. |
| `chat.retry.firstTokenStallMs` | number | `600000` | nextTurn | **WRITABLE** | Not in `DEFAULT_SETTINGS`' walk path by accident — it is, via `SETTINGS_CENTER_V2_PATH_OVERRIDES`. `0` never aborts a call that has not started streaming. |

### Root: `fleet` (replaces v1 `workers`, `fleet.nodes`, `routing`, `budget.concurrency`, parts of `guardrails`)

| v2 path | Kind / choices | Default | Timing | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `fleet.default.target` | string, optional | `null` | nextTurn | **WRITABLE** | v1 `workers` — "Defaults, roster, editing, retries, permission escalation, and resilience need safe settings plus typed events." The defaults half is a plain select now. |
| `fleet.default.model` | string, optional | `null` | nextTurn | **WRITABLE** | |
| `fleet.default.thinkingLevel` | enum THINKING_LEVELS | `off` | nextTurn | **WRITABLE** | |
| `fleet.default.node` | string, optional | unset | nextTurn | **WRITABLE** | Must be `local`, a configured node id, or cleared. Render as a select built from `fleet.nodes`. |
| `fleet.profiles` | json | `{}` | nextTurn | **WRITABLE via a guided editor**, not raw JSON | Each profile must name an existing connection. A GUI has no excuse for a JSON textarea here: build the row editor the TUI's "profile actions" describe. |
| `fleet.rosters` | json | `{}` | nextTurn | **WRITABLE via a guided editor** | Named teams of worker profiles for council/fleet runs. Same reasoning. |
| `fleet.agentProfiles` | json | `{}` | nextTurn | **WRITABLE via a guided editor** | Maps native agent names to profile names; a dangling reference is rejected with "Agent X names missing profile Y". A two-column select grid. |
| `fleet.nodes` | json | `[]` | nextTurn | **WRITABLE with a preflight gate** | v1 `fleet.nodes` — "SSH node identity, capacity, labels, residency; secret/path handling and preflight required." **That caveat stands.** Do not accept a node without running the preflight; do not render any credential field. |
| `fleet.adaptiveRouting.roles` | list, values `researcher\|verifier\|reviewer\|judge` | `[]` | nextTurn | **WRITABLE** | v1 `routing` — "show shadow vs active decisions only when typed events exist." The activation list is a closed vocabulary and is safe to edit; the *live decision display* stays blocked. Keep the two apart. |
| `fleet.adaptiveRouting.postures` | list, values `quality\|balanced\|latency\|economy` | `[]` | nextTurn | **WRITABLE** | `manual` is deliberately not an activatable posture. |
| `fleet.adaptiveRouting.agentRoles` | json (pairs of `{agentId, executionRole}`) | `[]` | nextTurn | **WRITABLE via a pair editor** | Deliberately exact pairs, "because independent agent and role lists would authorize their whole cross-product." Do not render two independent multi-selects. The agentId `auto` is reserved. |
| `fleet.permissions.mode` | enum `deny\|escalate\|fail` | `deny` | nextTurn | **WRITABLE** | Routes to the **safety** section, not fleet. Each value has operator help text already written. |
| `fleet.permissions.escalation.timeoutMs` | number | `120000` | nextTurn | **WRITABLE** | Only the `escalate` posture reads it. |
| `fleet.permissions.escalation.fallback` | enum `deny\|fail` | `deny` | nextTurn | **WRITABLE** | |
| `fleet.concurrency` | `auto` or positive int | `auto` | **restartRequired** | **WRITABLE** | v1 `budget` concurrency half. Must show "Takes effect in the next session." |
| `fleet.worktrees.root` | string | `disk` | nextTurn | **WRITABLE** | `disk`, `tmpfs`, `auto`, or an absolute directory. |
| `fleet.retry.maxRetries` | number | `2` | nextTurn | **WRITABLE** | |
| `fleet.retry.routeCooldownMs` | number | `15000` | nextTurn | **WRITABLE** | `0` disables the cooldown. |
| `fleet.retry.breakerThreshold` | number | `1` | nextTurn | **WRITABLE** | Consecutive route failures before work stops going to that route. |
| `fleet.limits.toolCallsPerRun` | number | `GUARDRAIL_DEFAULTS.workerToolCallCap` (150) | nextTurn | **WRITABLE** | v1 `guardrails` — "Numeric behavioral backstops; safety surface with exact effective source and restart/turn timing." Bounds *admitted* calls, not attempts. |
| `fleet.limits.internalRunTimeoutMs` | number | `900000` | nextTurn | **WRITABLE** | 15 minutes; covers the wiki documenter and bootstrap scout. |
| `fleet.history.maxRuns` | number | `1000` | nextTurn | **WRITABLE — with a destructive warning** | Runs leaving the ring also lose their event journal directory. Lowering this deletes journals the GUI is rendering. Confirm it. |
| `fleet.history.journal` | boolean | `true` | nextTurn | **WRITABLE** | Whether every dispatched run's event tail is written to disk. Turning it off blinds the GUI's own run-journal surface; say so. |

### Root: `context` (replaces v1 `compaction`, `context.workingSet`, `background`, `memory.intervention`)

| v2 path | Kind / choices | Default | Timing | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `context.toolResultMaxBytes` | number | `65536` | nextTurn | **WRITABLE** | Min 4096. The 192KB per-turn observation pool remains authoritative; three full 64KB results consume it. Show that arithmetic. |
| `context.workingSet.enabled` | boolean | `true` | nextTurn | **WRITABLE** | v1 `context.workingSet` — "pair controls with prune/recall ledger facts." The control is safe alone; the ledger display is blocked on `context.pruned`/`context.recalled` events. |
| `context.workingSet.policy` | enum `structural-v1\|age-horizon` | `structural-v1` | nextTurn | **WRITABLE** | |
| `context.workingSet.target` | number (0..1 exclusive) | `0.6` | nextTurn | **WRITABLE** | Must sit below `context.compaction.threshold`; the GUI should warn if it does not. |
| `context.workingSet.protectLastTurns` | number ≥ 1 | `6` | nextTurn | **WRITABLE** | |
| `context.workingSet.minEvictableTokens` | number ≥ 0 | `200` | nextTurn | **WRITABLE** | Break-even is near 50 tokens; 200 is the churn guard. |
| `context.compaction.auto` | boolean | `true` | nextTurn | **WRITABLE** | v1 `compaction` — "needs pressure and compaction events before a calibrated control." The switch itself is not calibration; ship it, and gate only the *pressure meter* on the events. |
| `context.compaction.threshold` | number (0..1) | `0.8` | nextTurn | **WRITABLE** | `pressure = estimated tokens ÷ context window`. |
| `context.compaction.model` | string, optional | unset | nextTurn | **WRITABLE** | Blank uses the orchestrator. |
| `context.compaction.systemPrompt` | string (path), optional | unset | nextTurn | **READ-ONLY-WITH-PROVENANCE** | It is a filesystem path to a prompt override. A browser form that writes an arbitrary path into the config is the one control in this root worth withholding until there is a file picker bounded to the workspace. |
| `context.memory.enabled` | boolean | `true` | nextTurn | **WRITABLE** | v1 `memory.intervention` — "pair with observed memory steps, not controls alone." Keep that as a *presentation* requirement (show `memory.stepCompleted` activity next to it), not a reason to withhold. |
| `context.memory.target` | string, optional | `null` | nextTurn | **WRITABLE** | v1 `background` — "needs safe ACP settings and cost explanation." Requires an orchestrator-eligible runtime. Show the cost note. |
| `context.memory.model` | string, optional | `null` | nextTurn | **WRITABLE** | Small non-reasoning model, task memory steps only. |
| `context.memory.cadenceToolCalls` | number | `10` | nextTurn | **WRITABLE** | |
| `context.memory.trajectorySteps` | number | `8` | nextTurn | **WRITABLE** | |
| `context.memory.maxOutputTokens` | number | `2000` | nextTurn | **WRITABLE** | |
| `context.memory.timeoutMs` | number | `60000` | nextTurn | **WRITABLE** | |

### Root: `safety` (replaces v1 `autonomy`, `budget.sessionCeilingUsd`, `watchdog`, parts of `guardrails`)

| v2 path | Kind / choices | Default | Timing | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `safety.autonomy` | enum `read-only\|suggest\|auto-edit\|full-auto` | `auto-edit` | **hotReload** | **WRITABLE** | Already an ACP safe key. v1 row: "Plain-language default for the next session; bound-session autonomy stays separate." **That separation is mandatory** — the session's bound autonomy and the settings default are two different facts and the GUI must label which it is showing. Per-value help text already exists for all four levels; render it. |
| `safety.limits.sessionCostUsd` | number | `5` | nextTurn | **WRITABLE** | v1 `budget` — "Needs live cost provenance and restart timing before controls." Restart timing is resolved (nextTurn). Live cost provenance is still missing, so ship the control and say the alert is informational: `budget.alert` never rejects an enqueue in v0.x. |
| `safety.limits.chatToolCallsPerTurn` | number ≥ 1 | 60 | nextTurn | **WRITABLE** | A backstop against a model spraying calls, not a routine ceiling; a repo-wide audit legitimately runs dozens. The hard interrupt ceiling sits a fixed margin above. |
| `safety.limits.readBytesPerCall` | number ≥ 1 | 51200 | nextTurn | **WRITABLE** | Clamped up to a 1KB floor at use. |
| `safety.limits.observationBytesPerTurn` | number ≥ 1 | 196608 | nextTurn | **WRITABLE** | One pool shared by every observation-producing tool in a turn. |
| `safety.review.enabled` | boolean | `false` | **hotReload** | **WRITABLE** | v1 `watchdog` said: "Harness documentation says ACP runs do not fire it, so a GUI switch would currently be dead." **That verdict is now a live design question, not a fact to inherit.** The registration reads its settings live on every trigger, so it is hot-reloadable — but `src/core/settings-controls.ts` still states "Headless and ACP runs never fire it." **If the new GUI drives turns over ACP, this control IS still dead and must be rendered disabled with that exact explanation, not hidden.** A hidden dead switch is how the operator learns the GUI lies. |
| `safety.review.target` | string, optional | unset | hotReload | **WRITABLE (disabled with the same ACP caveat)** | Blank reuses the session's active target. |
| `safety.review.cadenceToolCalls` | number, optional | unset | hotReload | **WRITABLE (same caveat)** | Blank fires at turn end only. |
| `safetyNet` (virtual row) | — | — | — | **READ-ONLY-WITH-PROVENANCE** | Not a settings key: it is the always-on rails tuned in `.clio-coder/safety.yaml`. `settingsSectionForPath` routes it to safety. Show it as a provenance card pointing at the file; do not offer to edit YAML through a form. |

### Root: `interface` (replaces v1 `terminal`, `theme`, `keybindings`, `panes`)

The v1 table's blanket verdict was **not applicable**: "Progress, transcript verbosity, TUI mode, scrollbar, and stream pacing are terminal presentation. Never mirror dead TUI switches." **That reasoning is sound and mostly still applies, but it is not uniform.** Split it:

| v2 path | Kind / choices | Default | Timing | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `interface.demo` | boolean | `true` | hotReload | **WRITABLE** | Not terminal presentation. It governs capability suggestions and contextual guidance, which a GUI also wants. |
| `interface.outputDetail` | enum `compact\|standard\|detailed` | `standard` | hotReload | **WRITABLE** | The v1 table called this dead TUI presentation and the parity matrix retired `/output` for the same reason. **Both are wrong now**: it governs how much reasoning, tool input, and live tool output the transcript shows, which is exactly the GUI's agent-viewport density control. Bind the GUI's own density toggle to it so the TUI and GUI agree. |
| `interface.smoothStreaming` | enum `off\|auto\|on` | `auto` | hotReload | **HIDDEN** | Grapheme-safe pacing against a TTY with stdout backpressure. Meaningless in a browser. The GUI should own its own render pacing (see the 120Hz goal) and never write this key. |
| `interface.mode` | enum `regular\|fullscreen` | `regular` | restartRequired | **HIDDEN** | Terminal scrollback vs alternate screen. Genuinely not applicable. |
| `interface.fullscreenScrollbar` | enum `hidden\|auto\|always` | `auto` | restartRequired | **HIDDEN** | Same. |
| `interface.terminalProgress` | boolean | `false` | nextTurn | **HIDDEN** | OSC 9;4 taskbar badges. |
| `interface.desktopNotifications` | boolean | `false` | nextTurn | **READ-ONLY-WITH-PROVENANCE** | The v1 row said "Desktop notifications are GUI-local only." The key controls the *TUI's* OSC 777/OSC 9 notifications on an interactive TTY; the GUI should own its own Notification API preference separately and show this one as the terminal's setting so the two are not confused. |
| `interface.panes.enabled` | enum `off\|auto` | `off` | restartRequired | **READ-ONLY-WITH-PROVENANCE** | The `embedded` rung is declared and refuses. `blocked-on-phase4` covers the runtime status, not the config — but a GUI offering to change a mux host's activation it cannot observe is worse than showing the value. |
| `interface.panes.notifications` | enum `failures\|all\|off` | `failures` | hotReload | **READ-ONLY-WITH-PROVENANCE** | Same. |
| `interface.panes.layout` | enum `off\|workers\|cockpit` | `off` | restartRequired | **READ-ONLY-WITH-PROVENANCE** | Same. |
| `interface.panes.workers.ratio` | number | `0.34` | restartRequired | **HIDDEN** | Terminal geometry. |
| `interface.panes.files.enabled` | boolean | `false` | hotReload | **READ-ONLY-WITH-PROVENANCE** | Yazi bridge; `blocked-on-phase4`. |
| `interface.panes.files.mode` | enum `companion\|chooser` | `companion` | hotReload | **READ-ONLY-WITH-PROVENANCE** | |
| `interface.panes.files.profile` | enum `managed\|user` | `managed` | hotReload | **READ-ONLY-WITH-PROVENANCE** | |
| `interface.panes.files.followCwd` | boolean | `true` | hotReload | **READ-ONLY-WITH-PROVENANCE** | |
| `interface.panes.files.ratio` | number | `0.3` | hotReload | **HIDDEN** | Terminal geometry. |
| `interface.keybindings` | json (map) | `{}` | hotReload | **HIDDEN for the TUI map; the GUI owns its own registry** | v1 verdict, still exactly right: "Clio Coder TUI bindings are **not applicable**; GUI shortcuts need their own accessible registry." Keep the GUI's shortcuts in GUI-local storage with a visible, searchable, accessible registry. Do not write TUI keys. |

### Root: `integrations` (replaces v1 `skills.trustProjectCompatRoots`, `library`, `attribution.gitCommits`, `delegation`, `runtimePlugins`)

| v2 path | Kind / choices | Default | Timing | Verdict | Reason |
| --- | --- | --- | --- | --- | --- |
| `integrations.projectResources.trustProjectImports` | boolean | `false` | nextTurn | **WRITABLE — with an explicit trust warning** | v1 `skills.trustProjectCompatRoots` — "Trust boundary. Needs clear project/user provenance and next-turn timing." Both are now available. Enabling exposes `.claude/skills`, `.codex/skills`, `.github/…` to the model. The control must name the roots it is about to trust and must be per-project-visible, not a silent global. |
| `integrations.externalAgents.entries` | json (array) | `[]` | nextTurn | **WRITABLE via a guided editor only** | v1 `delegation` — "External ACP agents, timeouts, tool governance, bounded context, labels; security-sensitive Agent setup." Each entry carries `command`, `args[]`, `cwd`, `env.*` — **this is arbitrary process execution defined through a web form.** Never a raw JSON textarea in a browser. Use the guided "External agents" flow for known integrations; for a custom entry, require an explicit confirmation naming the exact argv that will run. |
| `integrations.externalAgents.defaults.connectTimeoutMs` | number | `DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS` | nextTurn | **WRITABLE** | |
| `integrations.externalAgents.defaults.turnTimeoutMs` | number | `DEFAULT_DELEGATION_TURN_TIMEOUT_MS` | nextTurn | **WRITABLE** | |
| `integrations.externalAgents.defaults.permissionTimeoutMs` | number | `DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS` | nextTurn | **WRITABLE** | |
| `integrations.externalAgents.defaults.toolGovernance` | enum `clio-coder-policy\|agent-managed\|deny-all` | `clio-coder-policy` | nextTurn | **WRITABLE** | Routes to **safety**. Per-value help already written for all three. |
| `integrations.runtimePlugins` | list | `[]` | **restartRequired** | **WRITABLE — with a supply-chain warning** | v1 `runtimePlugins` — "Extensions/runtime setup; restart-required and supply-chain sensitive." Package names loaded at startup. Same class of risk as external agents: name what will load and require confirmation. |
| `integrations.library.catalog` | string (path), optional | `null` | nextTurn | **READ-ONLY-WITH-PROVENANCE** | An absolute path written through a web form. Blank uses the config-directory catalog, which is the right default. Withhold until there is a bounded picker. |
| `integrations.library.remote` | string (URL), optional | `null` | nextTurn | **WRITABLE** | v1 `library` — "Catalog/remote/confirmation/sync in the Resource library." Setting it is not enough to sync; the remote must also be confirmed. |
| `integrations.library.confirmedRemote` | string, optional | `null` | nextTurn | **READ-ONLY — hard** | `SETTING_CONTROLS` marks this the **only** `readOnly: true` control, and `parseControlValue` throws on any attempt: *"This value is recorded by its dedicated confirmation flow; it cannot be edited here."* Confirming a remote by typing it here would be the record confirming itself. Render it as a status line plus a **Confirm remote** action that runs `library remote confirm <url>`. |
| `integrations.library.sync` | boolean | `false` | nextTurn | **WRITABLE** | Off means `library sync` and `push` refuse before touching the network, whatever the remote says. This is the network kill switch; render it as one. |
| `integrations.git.commitAttribution` | boolean | `true` | **hotReload** | **WRITABLE** | v1 `attribution.gitCommits` — "Commit evidence policy; safe setting plus commit-provenance output." Role trailers are added only where Clio has trusted evidence; disabling leaves subsequent commit messages byte-for-byte unchanged. |

## 6. Summary of the allowlist this table authorizes

- **WRITABLE:** all of `chat.*` (14), most of `fleet.*` (23, four of them through guided editors and one behind preflight), all of `context.*` except `compaction.systemPrompt` (16), all of `safety.*` (8, three rendered disabled-with-reason if turns run over ACP), two of `interface.*` (`demo`, `outputDetail`), seven of `integrations.*`. **≈70 controls.**
- **READ-ONLY-WITH-PROVENANCE:** `targets[]` list, `context.compaction.systemPrompt`, `safetyNet`, `interface.desktopNotifications`, the six `interface.panes.*` capability rungs, `integrations.library.catalog`, `integrations.library.confirmedRemote`.
- **HIDDEN:** `version`, `interface.smoothStreaming`, `interface.mode`, `interface.fullscreenScrollbar`, `interface.terminalProgress`, `interface.panes.*.ratio`, `interface.keybindings`.

Every WRITABLE control goes through `applyControlValue`, which validates the whole proposed configuration, not the single field. Surface `SettingsValidationError.issues` as field-level errors.

## 7. What the app ships (v0.5.0)

`GET /api/workspaces/:id/settings/controls` returns one row per `SETTING_CONTROLS` entry minus the hidden set, each with its section and group from `settings-navigation.ts`, its timing from `settingsChangeKind`, its per-value help, its effective value in the text form `applyControlValue` parses, and the layer that set it. `PATCH` on the same path takes `{path, value, confirmed?}` and runs `updateLayeredSettings(cwd, (s) => applyControlValue(s, path, value))` in the ops lane, so every write is serial, lands in the user layer, and passes the engine's cross-field validation. The response lists every control whose value changed, which is how the page says that changing a connection also cleared its model. The adapter is `apps/clio-coder-gui/server/clio/adapters/settings-controls.ts`; its policy overlay names only the hidden, read-only, noted and confirmed paths. A test asserts the surface equals the registry minus the hidden set.

Four departures from the table above, each deliberate:

1. **Structured collections are read-only for now.** `fleet.profiles`, `fleet.rosters`, `fleet.agentProfiles`, `fleet.nodes`, `fleet.adaptiveRouting.agentRoles` and `integrations.externalAgents.entries` cross as an entry count with the reason that a guided editor does not exist yet. No JSON textarea ships. The guided editors remain open work.
2. **`safety.review.*` is writable with a caveat, not disabled.** The switch is dead for conversations in this app and live for terminal sessions that share the same file. The row says exactly that. A disabled control would have stopped an operator from configuring the terminal from here for no safety gain.
3. **A value set by a project, local project or command-line layer is read-only.** The write lands in the user layer, which those layers outrank, and `updateLayeredSettings` refuses such a write anyway. The row names the layer instead of offering an editor that answers 409.
4. **Origin is the exact leaf's source.** `settingsSourceFor` walks up to parent objects, and a parent recorded as a project source does not set its absent children. Using it marked all of `chat.*` project-owned when one project file set `chat.model`.

Confirmation is enforced by the server, not the page: `fleet.history.maxRuns`, `integrations.projectResources.trustProjectImports` and `integrations.runtimePlugins` answer 422 without `confirmed: true`, and the page shows the named consequence beside the checkbox.

The earlier effective-values list moved to `/settings/effective`. Provider onboarding, the `Confirm remote` action and the GUI-local notification and shortcut preferences are not part of this change.
