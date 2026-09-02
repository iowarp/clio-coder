import {
	bindAgentProfileInSettings,
	type ClioSettings,
	removeFleetProfileFromSettings,
	removeTargetFromSettings,
	SETTINGS_V1_PATH_MOVES,
	setFleetProfileInSettings,
	useTargetInSettings,
} from "../../core/config.js";
import {
	ACTIVE_ROUTING_POSTURES,
	ACTIVE_ROUTING_ROLES,
	type ActiveRoutingPosture,
	type ActiveRoutingRole,
	DEFAULT_SETTINGS,
	THINKING_LEVELS,
	type WorkerEscalationSettings,
} from "../../core/defaults.js";
import { getAtPath, isRoutingPath } from "../../core/session-routing.js";
import { MAX_TIMER_DELAY_MS } from "../../core/timers.js";
import { capacityLeaseUsage } from "../../domains/dispatch/capacity-lease.js";
import {
	delegationEntryForKind,
	type InteropAgentId,
	type InteropProposal,
	interopAgentKind,
} from "../../domains/interop/index.js";
import {
	type CapabilityFlags,
	endpointCapacitiesForStatuses,
	endpointCapacityForStatus,
	isDispatchEligibleRuntime,
	isOrchestratorEligibleRuntime,
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	type TargetHealth,
	type TargetStatus,
	thinkingLevelChoiceLabel,
	thinkingLevelFromChoiceLabel,
} from "../../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../../domains/scheduling/cluster.js";
import {
	type Component,
	getKeybindings,
	Input,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	SelectList,
	type SettingItem,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { clockLocal } from "../format-time.js";
import { buildHint, DEFAULT_SELECT_THEME, showClioOverlayFrame } from "../overlay-frame.js";
import { barSep, clioTheme, GLYPH, padAnsi, rule, screenTitle } from "../theme/index.js";
import { modelsForTarget } from "./model-selector.js";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./settings-sections.js";

export const SETTINGS_OVERLAY_WIDTH = "100%";
export const SETTINGS_OVERLAY_MAX_HEIGHT = "100%";
export const SETTINGS_OVERLAY_MARGIN = {
	top: 1,
	right: 0,
	bottom: 1,
	left: 0,
} as const;

const SECTION_LANE_WIDTH = 24;
/**
 * The width at which the live description earns its own column instead of a
 * footer strip. Same arithmetic as WIDE_LAYOUT_MIN_WIDTH below: two nested
 * frames sit above this body, each costing a border and a pad, so the body is
 * the terminal width less eight. A 120-column terminal renders at 112 and a
 * 119-column one at 111, so 112 is the floor that makes three columns start at
 * a real 120-column terminal.
 */
const ULTRAWIDE_LAYOUT_MIN_WIDTH = 112;
/**
 * The design's degradation matrix wants the two-column layout at an 80-column
 * terminal. Two nested frames sit above this body (the application frame and
 * the overlay's own), each costing a border and a pad, so the body is the
 * terminal width less eight: 72 at an 80-column terminal, 68 at a 76-column
 * one. 72 therefore keeps an 80-column terminal two-column (left lane 24 +
 * divider + rows ~47, with the key-path column dropped below
 * DROP_PATH_COLUMN_WIDTH) while anything narrower, where the value column
 * would collapse into the labels, stays stacked.
 */
const WIDE_LAYOUT_MIN_WIDTH = 72;
const DROP_PATH_COLUMN_WIDTH = 52;
/** Shown when no runtime is resolvable, so it offers the full vocabulary. */
const FALLBACK_THINKING_VALUES: ReadonlyArray<string> = THINKING_LEVELS;
const ROW_GAP = "  ";
/**
 * `workers.escalation` and `workers.resilienceCooldownMs` are optional keys, so
 * the row that shows them and the mutation that writes them both need a
 * definite shipped value to fall back to.
 */
const SHIPPED_ESCALATION: WorkerEscalationSettings = DEFAULT_SETTINGS.fleet.permissions.escalation ?? {
	timeoutMs: 120_000,
	fallback: "deny",
};
const SHIPPED_RESILIENCE_COOLDOWN_MS = DEFAULT_SETTINGS.fleet.retry.routeCooldownMs ?? 15_000;
/**
 * The product's cut marker, as the help center and every list overlay use it.
 *
 * A setting key is an identifier the operator types into settings.yaml, and the
 * panel rendered `delegation.defaults.toolGovernanc` for
 * `delegation.defaults.toolGovernance` with nothing to say it was short. An
 * unmarked cut presents a fragment as the whole value, so every cell, row, and
 * explanation line in this overlay carries the marker.
 */
const ELLIPSIS = "…";
const SELECT_UP = "\u001b[A";
const SELECT_DOWN = "\u001b[B";

/** Settings pickers accept the same j/k navigation as the rows that open them. */
class SettingsSelectList extends SelectList {
	override handleInput(data: string): void {
		super.handleInput(data === "j" ? SELECT_DOWN : data === "k" ? SELECT_UP : data);
	}
}

/**
 * Scope tells the operator where an edit lands. Derived from the config-change
 * classification (src/domains/config/classify.ts): hotReload/nextTurn knobs can
 * apply to the live session immediately, so they offer "this session only" vs
 * "save as the global default". restartRequired knobs cannot apply live, so the
 * overlay only offers a global save that a restart picks up.
 */
type SettingScope = "live" | "restart";
const RESTART_REQUIRED_IDS = new Set<string>([
	"budget.concurrency",
	"runtimePlugins",
	"terminal.tuiMode",
	"terminal.fullscreenScrollbar",
	// The mux domain runs its detection ladder once, at boot, from the value this
	// key held then. Changing the rung mid-session would leave the contract on
	// the rung it resolved to, so the row says restart rather than lying.
	"panes.enabled",
]);

export { SETTINGS_SECTIONS, type SettingsSectionId };

const SETTINGS_SECTION_DESCRIPTIONS = {
	safety: "How freely Clio acts, how a worker's approval ask resolves, and how delegated agents' tools are governed.",
	orchestrator: "Interactive chat routing, prompt pre-warm, and the optional proactive-memory model plane.",
	fleet: "Defaults, profiles, agent bindings, and route activation for dispatched workers, and where they run.",
	targets: "Configured inference targets: which one chat and the fleet use, and whether each answers.",
	models: "The /model picker, favorites, and Alt+J / Alt+K cycling.",
	budget: "Cost ceiling, per-turn output budget, worker concurrency, and the guardrail backstops.",
	compaction: "When and how the context window is evicted and summarized under pressure.",
	retry: "Automatic recovery from transient provider, network, and stalled-stream errors.",
	terminal: "Terminal integration and the Clio color palette.",
	watchdog: "The opt-in turn-end verifier run, where it is routed, and whether it also fires mid-turn.",
	advanced:
		"Commit provenance, runtime plugins, delegation timeouts, the resource library, and links to other surfaces.",
} as const satisfies Record<SettingsSectionId, string>;

export const SETTINGS_LABELS_BY_ID = {
	autonomy: "Autonomy level",
	// Labels follow the CLI's post-rename vocabulary: the config surface is the
	// fleet, and `worker` is the runtime entity the descriptions still name. A
	// section headed Fleet whose rows read "Worker profiles" and "Worker
	// retries" made one setting look like two subsystems.
	"workers.onPermission": "Fleet approvals routing",
	"workers.escalation.timeoutMs": "Escalation timeout (ms)",
	"workers.escalation.fallback": "Escalation fallback",
	"delegation.defaults.toolGovernance": "Delegation governance",
	"skills.trustProjectCompatRoots": "Trust project skill roots",
	"attribution.gitCommits": "Clio commit provenance",
	safetyNet: "Safety net",
	"orchestrator.thinkingLevel": "Thinking level",
	"orchestrator.target": "Target",
	"orchestrator.model": "Model",
	"background.target": "Memory target",
	"background.model": "Memory model",
	"memory.intervention.enabled": "Proactive memory",
	"memory.intervention.everyNTools": "Memory cadence (tools)",
	"memory.intervention.windowSteps": "Memory trajectory steps",
	"memory.intervention.maxTokens": "Memory reminder tokens",
	"memory.intervention.timeoutMs": "Memory timeout (ms)",
	"prewarm.enabled": "Prompt pre-warm",
	"workers.default.target": "Default target",
	"workers.default.model": "Default model",
	"workers.default.thinkingLevel": "Default thinking level",
	"workers.profiles": "Add profile",
	"workers.agentBindings": "Add agent route",
	"workers.maxRetries": "Fleet retries",
	"workers.resilienceCooldownMs": "Resilience cooldown (ms)",
	"routing.activeRoles": "Active routing roles",
	"routing.activePostures": "Active routing postures",
	"routing.agentAutomation.activeAgentRoles": "Active agent routes",
	"panes.enabled": "Panes",
	"panes.notifications": "Pane notifications",
	"panes.layout": "Boot layout",
	"panes.workers.ratio": "Workers dock share",
	"panes.journal": "Run event journal",
	"panes.yazi.enabled": "Files pane",
	"panes.yazi.mode": "Files pane mode",
	"panes.yazi.profile": "Yazi profile",
	"panes.yazi.followCwd": "Follow conversation cwd",
	"panes.yazi.ratio": "Files dock share",
	scope: "Model cycle set",
	"modelSelector.recentLimit": "Recent models kept",
	"modelSelector.favorites": "Pinned favorites",
	"budget.sessionCeilingUsd": "Session ceiling (USD)",
	"defaults.maxTokens": "Output budget (tokens)",
	"budget.concurrency": "Fleet concurrency",
	"guardrails.turnToolCallBudget": "Turn tool-call budget",
	"guardrails.workerToolCallCap": "Worker tool-call cap",
	"guardrails.maxDispatchRuns": "Run ledger retention",
	"guardrails.readMaxBytes": "Read byte cap",
	"guardrails.observationTurnBudgetBytes": "Observation byte pool",
	"guardrails.internalDispatchTimeoutMs": "Internal dispatch timeout (ms)",
	"compaction.auto": "Auto-compact",
	"compaction.threshold": "Compaction threshold",
	"context.workingSet.enabled": "Working-set eviction",
	"context.workingSet.policy": "Eviction policy",
	"context.workingSet.target": "Eviction target pressure",
	"context.workingSet.protectLastTurns": "Turns protected from eviction",
	"context.workingSet.minEvictableTokens": "Minimum evictable tokens",
	"retry.enabled": "Retry transient errors",
	"retry.maxRetries": "Max retries",
	"retry.baseDelayMs": "Base delay (ms)",
	"retry.maxDelayMs": "Max delay (ms)",
	"retry.streamStallMs": "Stream stall timeout (ms)",
	"terminal.showTerminalProgress": "Terminal progress badges",
	"terminal.outputVerbosity": "Output detail",
	"terminal.tuiMode": "TUI mode",
	"terminal.fullscreenScrollbar": "Fullscreen scrollbar",
	"terminal.smoothStreaming": "Smooth streaming",
	"terminal.notify": "Desktop notifications",
	"watchdog.enabled": "Turn-end watchdog",
	"watchdog.target": "Watchdog target",
	"watchdog.cadenceToolCalls": "Watchdog cadence (tools)",
	runtimePlugins: "Runtime plugins",
	"compaction.model": "Compaction model",
	"compaction.systemPrompt": "Compaction prompt",
	"delegation.defaults.connectTimeoutMs": "Delegate connect (ms)",
	"delegation.defaults.turnTimeoutMs": "Delegate turn (ms)",
	"delegation.defaults.permissionTimeoutMs": "Delegate permission (ms)",
	targets: "Configured targets",
	keybindings: "Keybinding overrides",
	"delegation.agents": "Delegation agents",
	"library.catalog": "Library catalog path",
	"library.remote": "Library remote",
	"library.confirmedRemote": "Confirmed library remote",
	"library.sync": "Library sync",
} as const;

/**
 * Entry rows (one per fleet profile field, agent binding, target, fleet node)
 * are keyed by the config path they edit; fleet node rows are read-only status.
 */
type EntrySettingId =
	| `workers.profiles.${string}`
	| `workers.agentBindings.${string}`
	| `targets.${string}`
	| `fleet.nodes.${string}`
	| `fleet.endpoints.${string}`;
export type EditableSettingId = keyof typeof SETTINGS_LABELS_BY_ID | EntrySettingId;
type FleetGroupHeaderId =
	`fleet.group.${"defaults" | "profiles" | "agent-routes" | "route-activation" | "placement" | "panes"}`;
type TerminalGroupHeaderId = "terminal.group.files-pane";
type BudgetGroupHeaderId = "budget.group.guardrails";
type CompactionGroupHeaderId = "compaction.group.working-set";
type AdvancedGroupHeaderId = "advanced.group.library";
type GroupHeaderId =
	| FleetGroupHeaderId
	| TerminalGroupHeaderId
	| BudgetGroupHeaderId
	| CompactionGroupHeaderId
	| AdvancedGroupHeaderId;
type TargetsCtaId = "targets.add-cta";
export type SettingsCenterRowId = EditableSettingId | GroupHeaderId | TargetsCtaId;
const REMOVE_PROFILE_CHOICE = "(remove profile)";
const UNBIND_CHOICE = "(unbind)";
const AUTO_PLACEMENT_CHOICE = "(auto placement)";
const PROFILE_FIELD_SEPARATOR = " -> ";
const PROFILE_SUMMARY_VALUE_BUDGET = 26;

export const SETTINGS_SECTION_ROWS = {
	safety: [
		"autonomy",
		"workers.onPermission",
		"workers.escalation.timeoutMs",
		"workers.escalation.fallback",
		"delegation.defaults.toolGovernance",
		"skills.trustProjectCompatRoots",
		"safetyNet",
	],
	orchestrator: [
		"orchestrator.thinkingLevel",
		"orchestrator.target",
		"orchestrator.model",
		"background.target",
		"background.model",
		"memory.intervention.enabled",
		"memory.intervention.everyNTools",
		"memory.intervention.windowSteps",
		"memory.intervention.maxTokens",
		"memory.intervention.timeoutMs",
		"prewarm.enabled",
	],
	fleet: [
		"workers.default.target",
		"workers.default.model",
		"workers.default.thinkingLevel",
		"workers.maxRetries",
		"workers.resilienceCooldownMs",
		"workers.profiles",
		"workers.agentBindings",
		"routing.activeRoles",
		"routing.activePostures",
		"routing.agentAutomation.activeAgentRoles",
		"panes.enabled",
		"panes.notifications",
		"panes.layout",
		"panes.workers.ratio",
		"panes.journal",
	],
	models: ["scope", "modelSelector.recentLimit", "modelSelector.favorites"],
	budget: [
		"budget.sessionCeilingUsd",
		"defaults.maxTokens",
		"budget.concurrency",
		"guardrails.turnToolCallBudget",
		"guardrails.workerToolCallCap",
		"guardrails.maxDispatchRuns",
		"guardrails.readMaxBytes",
		"guardrails.observationTurnBudgetBytes",
		"guardrails.internalDispatchTimeoutMs",
	],
	compaction: [
		"compaction.auto",
		"compaction.threshold",
		"context.workingSet.enabled",
		"context.workingSet.policy",
		"context.workingSet.target",
		"context.workingSet.protectLastTurns",
		"context.workingSet.minEvictableTokens",
	],
	retry: ["retry.enabled", "retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs", "retry.streamStallMs"],
	terminal: [
		"terminal.showTerminalProgress",
		"terminal.outputVerbosity",
		"terminal.tuiMode",
		"terminal.fullscreenScrollbar",
		"terminal.smoothStreaming",
		"terminal.notify",
		"panes.yazi.enabled",
		"panes.yazi.mode",
		"panes.yazi.profile",
		"panes.yazi.followCwd",
		"panes.yazi.ratio",
	],
	watchdog: ["watchdog.enabled", "watchdog.target", "watchdog.cadenceToolCalls"],
	advanced: [
		"runtimePlugins",
		"attribution.gitCommits",
		"compaction.model",
		"compaction.systemPrompt",
		"delegation.defaults.connectTimeoutMs",
		"delegation.defaults.turnTimeoutMs",
		"delegation.defaults.permissionTimeoutMs",
		"keybindings",
		"delegation.agents",
		"library.catalog",
		"library.remote",
		"library.confirmedRemote",
		"library.sync",
	],
	targets: ["targets"],
} as const satisfies Record<SettingsSectionId, readonly EditableSettingId[]>;

const SETTINGS_DESCRIPTIONS_BY_ID = {
	autonomy: "How freely Clio acts; the safety net always applies.",
	"workers.onPermission":
		"How a worker resolves an approval ask: deny the call, fail the run, or escalate to this session.",
	"workers.escalation.timeoutMs": "How long an escalated worker approval waits for you before the fallback applies.",
	"workers.escalation.fallback": "What an escalated approval becomes when nobody answers inside the timeout.",
	"delegation.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"skills.trustProjectCompatRoots": "Whether third-party project skill roots are loaded.",
	"attribution.gitCommits":
		"Add evidence-backed assistance, testing, review, and contributor trailers to commits created through Clio.",
	safetyNet: "Always-on rails; tuned in .clio-coder/safety.yaml.",
	"orchestrator.thinkingLevel": "Reasoning budget for the chat loop.",
	"orchestrator.target": "Active chat target id.",
	"orchestrator.model": "Active chat wire model id.",
	"background.target": "Optional target for LLM memory steps; unset keeps rules-only memory.",
	"background.model": "Small non-reasoning model used only for task memory steps.",
	"memory.intervention.enabled": "Master switch for rules-only and model-backed task memory.",
	"memory.intervention.everyNTools": "Maximum tool executions between prompted memory steps.",
	"memory.intervention.windowSteps": "Recent completed tool steps visible to the memory policy.",
	"memory.intervention.maxTokens": "Hard cap for one visible memory reminder.",
	"memory.intervention.timeoutMs": "Hard deadline for one background-model memory call.",
	"prewarm.enabled": "Send the next turn's known prefix ahead of time so a local server has already prefilled it.",
	"workers.default.target": "Default /run target id.",
	"workers.default.model": "Default /run wire model id.",
	"workers.default.thinkingLevel": "Reasoning budget for dispatched workers.",
	"workers.profiles": "Named target/model/thinking choices that native workers can use. Enter adds one.",
	"workers.agentBindings": "Pins native Clio agents, including shadow agents, to worker profiles. Enter adds one.",
	"workers.maxRetries": "Automatic retries for a retryable worker outcome.",
	"workers.resilienceCooldownMs":
		"How long a failing target, runtime, and model route is skipped before it is tried again.",
	"routing.activeRoles": "Execution roles whose joint route selection may act instead of only shadowing.",
	"routing.activePostures": "Route postures whose selection may act instead of only shadowing.",
	"routing.agentAutomation.activeAgentRoles": "Exact agent and execution-role pairs whose agent choice may act.",
	"panes.enabled": "Default panes activation for new sessions; `--with-panes` / `--no-panes` beat it.",
	"panes.notifications": "Which terminal run states raise a pane-host toast.",
	"panes.layout": "What composes itself at interactive boot: nothing, the workers dock, or workers plus files.",
	"panes.workers.ratio": "Share of the width the workers dock takes, at most half.",
	"panes.journal": "Whether every dispatched run's event tail is written to disk for `clio-coder fleet view`.",
	"panes.yazi.enabled": "Whether `/panes open yazi` may open the files pane or one-shot chooser.",
	"panes.yazi.mode": "Keep Yazi beside the conversation, or close it after one selection.",
	"panes.yazi.profile": "Use Clio's managed pick profile or leave the operator's Yazi profile untouched.",
	"panes.yazi.followCwd": "Push the conversation directory into an already-open companion pane.",
	"panes.yazi.ratio": "Share of the height the files dock takes, at most half.",
	scope: "Alt+J and Alt+K model cycle set.",
	"modelSelector.recentLimit": "How many recently used models /model remembers.",
	"modelSelector.favorites": "Exact target/model refs pinned in /model.",
	"budget.sessionCeilingUsd": "Per-session cost cap.",
	"defaults.maxTokens": "Output tokens requested per turn, applied to every target.",
	"budget.concurrency": "Parallel workers allowed during dispatch.",
	"guardrails.turnToolCallBudget": "Soft per-turn tool-call budget for this chat loop.",
	"guardrails.workerToolCallCap": "Lifetime ceiling on tool calls one dispatched worker may execute.",
	"guardrails.maxDispatchRuns": "How many finished runs the dispatch ledger keeps before the oldest are dropped.",
	"guardrails.readMaxBytes": "Per-call byte cap for the read tool.",
	"guardrails.observationTurnBudgetBytes": "Shared per-turn byte pool across every observation-producing tool.",
	"guardrails.internalDispatchTimeoutMs": "Wall-clock cap for one internal generator dispatch.",
	"compaction.auto": "Auto-compact before a turn when context crosses the threshold.",
	"compaction.threshold": "Pressure at which compaction masks stale observations, then summarizes.",
	"context.workingSet.enabled": "Non-destructive eviction of stale tool results before a summary is ever needed.",
	"context.workingSet.policy": "Which candidates the eviction pass selects.",
	"context.workingSet.target": "Context pressure an applied eviction batch brings the session down to.",
	"context.workingSet.protectLastTurns": "Recent user turns whose observations are never evicted.",
	"context.workingSet.minEvictableTokens":
		"Results below this token estimate stay; the marker would cost more than it saves.",
	"retry.enabled": "Retry transient provider errors on the next submit.",
	"retry.maxRetries": "Retry attempts after the initial failure.",
	"retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"retry.streamStallMs": "Silence on an in-flight stream past this long is treated as a wedged backend.",
	"terminal.showTerminalProgress": "Emit OSC 9;4 progress badges during agent turns.",
	"terminal.outputVerbosity": "How much reasoning, tool input, and live tool output appears in the transcript.",
	"terminal.tuiMode": "Use regular terminal scrollback or a fullscreen transcript with a sticky composer and footer.",
	"terminal.fullscreenScrollbar": "When the draggable transcript scrollbar is visible in fullscreen mode.",
	"terminal.smoothStreaming": "Presentation-only pacing for streamed assistant text and thinking.",
	"terminal.notify":
		"Content-free desktop notification when a turn ends, a detached batch settles, or an approval parks.",
	"watchdog.enabled": "When enabled, a turn that changed the tree is reviewed by one read-only verifier run.",
	"watchdog.target": "Set target to route the run at a cheap local model; blank uses the session's active target.",
	"watchdog.cadenceToolCalls": "Also fire every N tool calls inside a turn; blank fires at turn end only.",
	runtimePlugins: "npm packages exporting clioRuntimes: RuntimeDescriptor[].",
	"compaction.model": "Dedicated summarization model; blank uses the orchestrator.",
	"compaction.systemPrompt": "Path to a compaction prompt override; blank uses the built-in.",
	"delegation.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"delegation.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"delegation.defaults.permissionTimeoutMs": "How long a delegated permission ask may wait.",
	targets: "Inference targets available for chat and workers. Add one with `clio-coder targets add`.",
	keybindings: "Custom key overrides layered on the defaults.",
	"delegation.agents": "External ACP agents available to /delegate.",
	"library.catalog": "Path to the private resource catalog; blank uses the one in your config directory.",
	"library.remote": "Git remote the catalog syncs with; blank keeps the library entirely local.",
	"library.confirmedRemote": "The remote you confirmed. Sync refuses until it matches library.remote.",
	"library.sync": "Whether `clio-coder library sync` and `push` may talk to the remote at all.",
} as const satisfies Record<EditableSettingId, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
const SETTINGS_HELP_BY_ID: Partial<Record<EditableSettingId, string>> = {
	autonomy:
		"read-only observes; suggest parks non-read calls; auto-edit edits, dispatches, and runs recognized commands; full-auto runs except command substitution and system-level changes. A confirmation marked exposure=outward parks for you at suggest and auto-edit.",
	"defaults.maxTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"compaction.threshold":
		"pressure = estimated tokens ÷ context window. Higher keeps more history but risks overflow before a summary runs.",
	"context.workingSet.enabled":
		"Eviction moves stale tool-result bodies and thinking blocks out of the model's working set and records a ledger entry; history is never rewritten. Off skips eviction and goes straight to summary compaction. Legal values: true, false · default: true.",
	"context.workingSet.policy":
		"structural-v1 selects by message structure; age-horizon is the older age-based rule. Legal values: structural-v1, age-horizon · default: structural-v1.",
	"context.workingSet.target":
		"An applied eviction batch keeps evicting until pressure reaches this ratio, so it sits below compaction.threshold. Greater than 0 and less than 1 · default: 0.6.",
	"context.workingSet.protectLastTurns": "Counted in user turns. Whole number of at least 1 · default: 6.",
	"context.workingSet.minEvictableTokens":
		"The floor sweep put marker break-even near 50 tokens; 200 is the churn guard. Whole number, 0 evicts anything · default: 200.",
	"guardrails.turnToolCallBudget":
		"Crossing it blocks further calls in the turn with a stop-and-summarize directive, and the hard interrupt ceiling sits a fixed margin above. A backstop against a model spraying unproductive calls, not a routine ceiling: a repo-wide audit legitimately runs dozens. Whole number of at least 1 · default: 60.",
	"guardrails.workerToolCallCap":
		"Bounds admitted calls, not attempts: a call the harness refuses never ran and never spends the cap. Dispatch takes the smaller of this and the agent recipe's own budget, so the recipe normally binds. Whole number of at least 1 · default: 150.",
	"guardrails.maxDispatchRuns":
		"Runs leaving the ring also lose their event journal directory. Whole number of at least 1 · default: 1000.",
	"guardrails.readMaxBytes":
		"Clamped up to a 1KB floor at use. Whole number of bytes, at least 1 · default: 51200 (50KB).",
	"guardrails.observationTurnBudgetBytes":
		"One pool shared by every observation-producing tool in a turn, so a single verbose tool cannot starve the rest. Whole number of bytes, at least 1 · default: 196608 (192KB).",
	"guardrails.internalDispatchTimeoutMs":
		"Covers the wiki documenter and the bootstrap scout. Continuous output satisfies the heartbeat watchdog and a run mid-generation spends no tool calls, so this is the only guard that ends a degenerate generator. Healthy runs finish in minutes. Whole milliseconds of at least 1 · default: 900000 (15 minutes).",
	"retry.streamStallMs":
		"Measured from the last token received, not from the request, so a slow-but-alive stream is never aborted. The retry then follows the same enabled/maxRetries/delay settings above. Whole milliseconds · default: 180000 (three minutes).",
	"library.catalog":
		"Absolute path, or blank for the catalog in your config directory. The catalog is the index `clio-coder library` reads; installed resources land in the usual skill and resource roots either way. Default: blank.",
	"library.remote":
		"A Git remote URL, or blank to keep the library local. Setting it is not enough to sync: the remote must also be confirmed, and library.sync must be true. Default: blank.",
	"library.confirmedRemote":
		"Written by the confirm flow, not by hand, because confirming a remote here would be the record confirming itself. Sync refuses with library_remote_unconfirmed until this equals library.remote. Default: blank.",
	"library.sync":
		"Off means `clio-coder library sync` and `push` refuse before touching the network, whatever the remote says. Legal values: true, false · default: false.",
	"budget.concurrency": "auto sizes to your machine. A fixed number caps how many workers run at once.",
	"skills.trustProjectCompatRoots":
		"Project roots like .claude/skills and .codex/skills are untrusted by default; enabling exposes them to the model.",
	"attribution.gitCommits":
		"Role trailers are added only when Clio has trusted evidence for that role. Disabling leaves subsequent commit messages entirely unchanged.",
	"workers.onPermission":
		"deny turns the ask into a tool denial and the run continues; fail stops the run as permission_required; escalate forwards the ask to you and falls back per workers.escalation on timeout.",
	"workers.escalation.timeoutMs":
		"Only the escalate posture reads it, and it is what keeps that posture non-stall: a headless session has no operator to answer, so the fallback always governs there. Whole milliseconds of at least 1; default: 120000 (two minutes).",
	"workers.escalation.fallback":
		"deny turns the unanswered ask into a tool denial and the run continues; fail ends the run as permission_required. Legal values: deny, fail · default: deny.",
	"workers.resilienceCooldownMs":
		"Applied per target, runtime, and wire model after a failure class that trips the breaker; a clean run clears it immediately. Whole milliseconds, 0 disables the cooldown; default: 15000.",
	"routing.activeRoles":
		"Joint route selection stays shadow-only, recording what it would have picked, unless both the execution role and the requested posture are named as active. Legal values: researcher, verifier, reviewer, judge · default: none active.",
	"routing.activePostures":
		"Manual pins are exact rather than adaptive, so manual is never an activated posture. Legal values: quality, balanced, latency, economy · default: none active.",
	"routing.agentAutomation.activeAgentRoles":
		"Exact agentId and executionRole pairs, because independent agent and role lists would authorize their whole cross-product. Execution roles: builder, researcher, verifier, reviewer, judge; the agentId `auto` is reserved. Edit the pairs in settings.yaml; default: none active.",
	"prewarm.enabled":
		"Fires at session start, after a resume rebuilds the message array, and after a compaction settles, never while a turn or dispatch is running. Local-native targets and interactive sessions only, whatever this says. Legal values: true, false · default: true.",
	"workers.agentBindings":
		"Bind base, custom, and shadow native agents such as scout, researcher, and provenance to profiles. ACP delegation agents cannot be bound.",
	"delegation.defaults.toolGovernance":
		"clio-coder-policy gates the agent through Clio's safety net; agent-managed trusts the agent; deny-all blocks every tool.",
	scope: "Choose target-level or exact target/model refs. Alt+J / Alt+K step the chat target through this list.",
	runtimePlugins: "Comma-separated package names, loaded at startup. Restart Clio after changing.",
	"terminal.notify":
		"OSC 777, or OSC 9 on iTerm2, Windows Terminal, and ConEmu. Interactive TTY runs only; the body never carries prompt text, file paths, or model output.",
	"watchdog.enabled":
		"The verifier run is briefed with the turn's coalesced diff and the task board's current scope; its blockers become one transcript notice and nothing else. Headless and ACP runs never fire it.",
	"watchdog.target":
		"A watchdog run costs a worker run per mutating turn, so routing it at a local target keeps the review cheap. Leave blank to reuse whatever the session is already talking to.",
	"watchdog.cadenceToolCalls":
		"Mid-turn firing is how scope drift becomes visible before the turn ends. Leave blank and the watchdog fires at turn end only.",
	keybindings:
		"Renderer controls: Alt+O newest tool or worker details, Ctrl+Alt+O or Alt+Shift+O all of them, Alt+P live tool output, Alt+R latest reasoning, Ctrl+Alt+R or Alt+Shift+R all reasoning. Override these in settings.yaml or use /help.",
};

/** Per-value meaning, surfaced for the current value of an enum knob. */
const SETTINGS_VALUE_HELP_BY_ID: Partial<Record<EditableSettingId, Record<string, string>>> = {
	autonomy: {
		"read-only": "observe and answer only; never edits files or runs commands",
		suggest:
			"propose every edit and command for your approval; confirmations marked exposure=outward (filing an issue or PR, pushing, releasing) park here as well",
		"auto-edit":
			"edits and dispatches run; recognized commands (tests, lint, build, .clio-coder/safety.yaml entries) run; other commands ask, as do confirmations marked exposure=outward (filing an issue or PR, pushing, releasing)",
		"full-auto":
			"runs without approval prompts, outward-facing confirmations included, except command substitution and system-level changes; hard blocks always apply",
	},
	"workers.onPermission": {
		deny: "a worker permission ask becomes a tool denial; the run continues",
		fail: "the run ends immediately as permission_required",
		escalate:
			"the ask is forwarded to this session's operator; on timeout it falls back to deny or fail per workers.escalation",
	},
	"workers.escalation.fallback": {
		deny: "an unanswered escalation becomes a tool denial and the run continues",
		fail: "an unanswered escalation ends the run as permission_required",
	},
	"prewarm.enabled": {
		true: "prefill the next turn's known prefix on local-native targets",
		false: "never send a pre-warm request; the first turn pays the whole prefill",
	},
	"context.workingSet.enabled": {
		true: "evict stale observations non-destructively before summarizing",
		false: "skip eviction and go straight to summary compaction",
	},
	"context.workingSet.policy": {
		"structural-v1": "select eviction candidates by message structure",
		"age-horizon": "the older rule: select by age alone",
	},
	"library.sync": {
		true: "allow `clio-coder library sync` and `push` to reach the confirmed remote",
		false: "refuse every library network operation",
	},
	"delegation.defaults.toolGovernance": {
		"clio-coder-policy": "Clio's safety policy gates the delegated agent's tools",
		"agent-managed": "the external agent governs its own tools",
		"deny-all": "block every tool the delegated agent requests",
	},
	"compaction.auto": {
		true: "compact automatically before a turn crosses the threshold",
		false: "context is only compacted when you run /context compact",
	},
	// `embedded` is a declared rung with no implementation behind it, and a row
	// that offered it beside two working values read as a third working value.
	// It stays selectable, because refusing it outright would break a settings
	// file that names it, but nothing here lets an operator pick it believing
	// they will get panes.
	"panes.enabled": {
		auto: "detect a herdr session and join it as a guest; no pane host, no panes",
		embedded: "NOT IMPLEMENTED (ships in phase 5): this session gets no panes at all, guest mode included",
		off: "never detect or open a pane",
	},
	"retry.enabled": {
		true: "retry transient provider errors automatically",
		false: "surface transient errors immediately without retrying",
	},
	"skills.trustProjectCompatRoots": {
		true: "load skills from .claude/.codex/.github/etc. project roots",
		false: "ignore third-party project skill roots",
	},
	"attribution.gitCommits": {
		enabled: "add only the Clio role trailers justified by trusted evidence",
		disabled: "leave every subsequent commit message byte-for-byte unchanged",
	},
	"terminal.showTerminalProgress": {
		true: "emit OSC 9;4 taskbar/tab progress badges during turns",
		false: "no terminal progress badges",
	},
	"terminal.outputVerbosity": {
		minimal: "quiet transcript; tools stay to one-line outcomes and reasoning stays folded",
		default: "balanced transcript; unfold the latest tool, worker, or reasoning block on demand",
		verbose: "transparent transcript; reasoning, arguments, and live tool output stay visible",
	},
	"terminal.tuiMode": {
		regular: "preserve terminal scrollback and render the composer below the transcript",
		fullscreen: "use the alternate screen with an independently scrollable transcript and sticky composer/footer",
	},
	"terminal.fullscreenScrollbar": {
		hidden: "never draw the fullscreen transcript scrollbar",
		auto: "show the scrollbar while scrolling or dragging",
		always: "reserve the rightmost column for the scrollbar",
	},
	"terminal.notify": {
		true: "post a content-free desktop notification on turn end, batch settlement, and a parked approval",
		false: "never post a desktop notification",
	},
	"watchdog.enabled": {
		true: "review every mutating turn with one read-only verifier run",
		false: "no verifier run; a turn ends without a second opinion",
	},
	"terminal.smoothStreaming": {
		off: "preserve the current immediate 16ms-coalesced streaming behavior",
		auto: "pace only on a capable local TTY without accessibility or backpressure risk",
		on: "request grapheme-safe pacing; stdout backpressure still pauses presentation",
	},
};

export type SettingSubmenuBuilder = NonNullable<SettingItem["submenu"]>;
type SettingsCenterLane = "sections" | "rows";
/**
 * Where the operator is in the Settings stack, independent of width. Narrow
 * terminals render one level at a time and wide ones render adjacent context,
 * but both share this state so Esc walks the same chain everywhere.
 */
export type SettingsNavigationDepth = "sections" | "rows" | "detail";

export type SettingsPresentationKind =
	| "setting"
	| "status"
	| "action"
	| "group-header"
	| "read-only-fact"
	| "destructive-action";

type SettingsValueTone = "neutral" | "healthy" | "degraded" | "unhealthy" | "unknown" | "activity";

export interface SettingsValueSegment {
	text: string;
	tone: SettingsValueTone;
}

export interface SettingsCenterItem extends SettingItem {
	id: SettingsCenterRowId;
	label: string;
	description: string;
	section: SettingsSectionId;
	configPath: string;
	affordance: string;
	scope: SettingScope;
	readOnly: boolean;
	presentationKind: SettingsPresentationKind;
	valueSegments: readonly SettingsValueSegment[];
	targetConsole?: {
		health: SettingsValueSegment;
		id: string;
		roles: string;
		runtime: string;
		latency: string;
		url: string;
		defaultModel: string;
		lastProbe: string;
		failureReason: string;
	};
	help?: string;
	valueHelp?: Record<string, string>;
	defaultValue?: string;
	/**
	 * What a free-text editor opens with when it differs from the rendered
	 * value. A row that renders its absence as prose such as `(session target)`
	 * must not hand that prose to the editor, or the operator's typing lands
	 * behind it and the placeholder is written into settings.yaml.
	 */
	editValue?: string;
}

export interface SettingsCenterSection {
	id: SettingsSectionId;
	label: string;
	items: SettingsCenterItem[];
}

export interface SettingsCenterSelection {
	lane: SettingsCenterLane;
	depth: SettingsNavigationDepth;
	section: SettingsSectionId;
	rowIndex: number;
	rowId: SettingsCenterRowId | null;
	submenuOpen: boolean;
	filter: string;
}

interface BuildSettingItemsOptions {
	providers?: ProvidersContract;
	/**
	 * Live settings source for submenus. The static `settings` snapshot is
	 * captured when the overlay opens; submenus must read through this so
	 * changing target, then picking model lists models for the new target.
	 */
	getSettings?: () => Readonly<ClioSettings>;
	/** Re-derive rows after an action that changes what they show without a commit (a health probe). */
	requestRefresh?: () => void;
	/** Live fleet node snapshots (scheduling.fleet.list()); absent hides the node rows. */
	getFleetNodes?: () => ReadonlyArray<FleetNodeSnapshot>;
	/** Run the API-key / OAuth connect flow for a target; absent hides the action. */
	connectTarget?: (targetId: string) => Promise<void> | void;
	/** The connect/probe operation currently acting on a target, if any. */
	getTargetOperation?: (targetId: string) => "connect" | "probe" | null;
	/** Keeps the row grammar synchronized with the lifetime of connect/probe work. */
	onTargetOperationChange?: (targetId: string, operation: "connect" | "probe" | null, operationToken: object) => void;
	/** Detected agents not yet wired; absent or empty hides the add action on the delegation.agents row. */
	getInteropProposals?: () => ReadonlyArray<InteropProposal>;
}

const DELEGATION_ADD_PREFIX = "add ";
const DELEGATION_REMOVE_PREFIX = "remove ";

/**
 * The delegation.agents row is read-only until interop has something to offer.
 * Adding writes the same entry `configure --interop` would, and removing names
 * the `/delegate` id that stops resolving, which is the only user-visible
 * consequence a change plan cannot show from a settings diff.
 */
function delegationAgentsAffordance(
	agents: ReadonlyArray<{ id: string }>,
	proposals: ReadonlyArray<InteropProposal>,
): { affordance: string; readOnly?: boolean; submenu?: SettingSubmenuBuilder } {
	const choices = [
		...proposals.map((proposal) => ({
			value: `${DELEGATION_ADD_PREFIX}${proposal.kind}`,
			label: `Add detected agent ${proposal.entry.id} (${[proposal.entry.command, ...proposal.entry.args].join(" ")})`,
			presentationKind: "action" as const,
		})),
		...agents.map((agent) => ({
			value: `${DELEGATION_REMOVE_PREFIX}${agent.id}`,
			label: `Remove ${agent.id}; /delegate ${agent.id} stops resolving`,
			presentationKind: "destructive-action" as const,
		})),
	];
	if (choices.length === 0) return { affordance: "edit settings.yaml", readOnly: true };
	return {
		affordance: "opens picker",
		submenu: selectListSubmenu(
			"Delegation agents",
			choices,
			"An added peer runs under clio-coder-policy governance and inherits projectContext: none.",
		),
	};
}

type SubmenuTitle = string | ((width: number) => string);

export class SubmenuWrapper implements Component {
	/**
	 * Why the last submission was refused, or null while nothing is wrong. The
	 * editor sets it instead of closing, so the operator corrects the value with
	 * the reason on screen rather than back at the row list with no reason.
	 */
	private problem: string | null = null;

	constructor(
		private readonly title: SubmenuTitle,
		private readonly child: Component,
		private readonly hint: string = buildHint([{ key: "Enter", verb: "confirm" }], "back"),
		private readonly note?: string,
	) {}

	setProblem(problem: string | null): void {
		this.problem = problem;
	}

	render(width: number): string[] {
		const theme = clioTheme();
		const lines: string[] = [];
		const titleWidth = Math.max(1, width - 2);
		const title = typeof this.title === "function" ? this.title(titleWidth) : this.title;
		lines.push(screenTitle(theme, `  ${title}`));
		if (this.note) {
			for (const line of wrapTextWithAnsi(this.note, Math.max(1, width - 2))) {
				lines.push(theme.fg("dim", `  ${line}`));
			}
		}
		lines.push("");
		// The two-column indent is this wrapper's to spend, so the child is told
		// what is left. Handing it the full width made every row that pads itself
		// arrive two columns over budget: the checklist's entries came back at
		// `width`, the indent pushed them to `width + 2`, and the panel then cut
		// two columns off each one and marked the cut, so every entry wore a
		// trailing … it had not earned.
		lines.push(...this.child.render(Math.max(1, width - 2)).map((line) => `  ${line}`));
		if (this.problem !== null) {
			for (const line of wrapTextWithAnsi(this.problem, Math.max(1, width - 2))) {
				lines.push(theme.fg("error", `  ${line}`));
			}
		}
		lines.push("");
		lines.push(theme.fg("dim", `  ${this.hint}`));
		return lines;
	}

	handleInput(data: string): void {
		this.child.handleInput?.(data);
	}

	invalidate(): void {
		this.child.invalidate?.();
	}
}

function textInputSubmenu(title: string, note?: string): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.setValue(currentValue);
		input.focused = true;
		input.onSubmit = (val) => done(val);
		input.onEscape = () => done();
		return new SubmenuWrapper(title, input, buildHint([{ key: "Enter", verb: "confirm" }], "back"), note);
	};
}

function selectTargetSubmenu(providers: ProvidersContract): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const statuses = providers.list();
		if (statuses.length === 0) {
			return textInputSubmenu("Type target id")(currentValue, done);
		}
		const items = statuses.map((status) => ({
			value: status.target.id,
			label: `${status.target.id} (${status.target.url ?? "no url"})`,
		}));
		return selectListSubmenu("Select target", items)(currentValue, done);
	};
}

function selectOptionalBackgroundTargetSubmenu(providers: ProvidersContract): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const statuses = providers.list();
		const items = [
			{ value: "(unset)", label: "(unset — rules-only)" },
			...statuses.map((status) => ({
				value: status.target.id,
				label: `${status.target.id} (${status.target.url ?? "no url"})`,
			})),
		];
		const note = "Unset keeps the zero-cost rules-only tier.";
		return selectListSubmenu("Select memory target", items, note)(currentValue, done);
	};
}

function selectModelSubmenu(
	providers: ProvidersContract,
	getActiveTarget: () => string | undefined,
): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const targetId = getActiveTarget();
		const status = providers.list().find((s) => s.target.id === targetId);
		const models = status ? modelsForTarget(status) : [];
		if (models.length === 0) {
			return textInputSubmenu("Type model name")(currentValue, done);
		}
		const items = models.map((m) => ({ value: m, label: m }));
		return selectListSubmenu(`Select model for ${targetId}`, items)(currentValue, done);
	};
}

function editTextSubmenu(title: string, note?: string): SettingSubmenuBuilder {
	return textInputSubmenu(title, note);
}

/**
 * The bound a number row enforces, shared by the editor and the apply path so
 * the two cannot drift: whatever the editor forwards, the apply path stores.
 * The bounds mirror the config validator's, so a value the Settings Center
 * refuses is one settings.yaml would have refused too, in the same words.
 */
interface NumberSettingRule {
	readonly min: number;
	readonly max?: number;
	readonly integer: boolean;
	/** A blank submission clears the key instead of being a parse failure. */
	readonly allowBlank?: boolean;
}

const NUMBER_SETTING_RULES = {
	"budget.sessionCeilingUsd": { min: 0, integer: false },
	"watchdog.cadenceToolCalls": { min: 1, integer: true, allowBlank: true },
	"delegation.defaults.connectTimeoutMs": { min: 1, max: MAX_TIMER_DELAY_MS, integer: true },
	"delegation.defaults.turnTimeoutMs": { min: 1, max: MAX_TIMER_DELAY_MS, integer: true },
	"delegation.defaults.permissionTimeoutMs": { min: 1, max: MAX_TIMER_DELAY_MS, integer: true },
	// The escalation deadline is armed as a timer, so it shares the delegation
	// bounds; the rest mirror the config validator's own integer bounds.
	"workers.escalation.timeoutMs": { min: 1, max: MAX_TIMER_DELAY_MS, integer: true },
	"workers.resilienceCooldownMs": { min: 0, integer: true },
	"guardrails.turnToolCallBudget": { min: 1, integer: true },
	"guardrails.workerToolCallCap": { min: 1, integer: true },
	"guardrails.maxDispatchRuns": { min: 1, integer: true },
	"guardrails.readMaxBytes": { min: 1, integer: true },
	"guardrails.observationTurnBudgetBytes": { min: 1, integer: true },
	"guardrails.internalDispatchTimeoutMs": { min: 1, integer: true },
	// The config validator's bounds for both dock shares; half the axis is the cap.
	"panes.workers.ratio": { min: 0.05, max: 0.5, integer: false },
	"panes.yazi.ratio": { min: 0.05, max: 0.5, integer: false },
} as const satisfies Partial<Record<EditableSettingId, NumberSettingRule>>;

export type NumberSettingId = keyof typeof NUMBER_SETTING_RULES;

export const NUMBER_SETTING_IDS = Object.keys(NUMBER_SETTING_RULES) as readonly NumberSettingId[];

type NumberSettingOutcome = { readonly value: number | null } | { readonly refusal: string };

function describeSubmittedText(value: string): string {
	const trimmed = value.trim();
	return trimmed.length === 0 ? "an empty string" : JSON.stringify(trimmed);
}

/**
 * Parse one submitted number-row value under its rule. A null value means the
 * operator cleared an optional key. The refusal is worded like the config
 * validator's issue for the same key ("expected an integer >= 1, got 0"), with
 * a "Not applied:" prefix so it reads as the outcome of this submission.
 */
function parseNumberSetting(value: string, rule: NumberSettingRule): NumberSettingOutcome {
	const trimmed = value.trim();
	const noun = rule.integer ? "an integer" : "a number";
	if (trimmed.length === 0 && rule.allowBlank === true) return { value: null };
	const parsed = trimmed.length === 0 ? Number.NaN : Number(trimmed);
	if (!Number.isFinite(parsed) || (rule.integer && !Number.isInteger(parsed))) {
		const shown = Number.isFinite(parsed) ? String(parsed) : describeSubmittedText(value);
		return { refusal: `Not applied: expected ${noun}, got ${shown}.` };
	}
	if (parsed < rule.min) return { refusal: `Not applied: expected ${noun} >= ${rule.min}, got ${parsed}.` };
	if (rule.max !== undefined && parsed > rule.max) {
		return { refusal: `Not applied: expected ${noun} <= ${rule.max}, got ${parsed}.` };
	}
	return { value: parsed };
}

function numberSettingNote(rule: NumberSettingRule): string {
	const noun = rule.integer ? "a whole number" : "a number";
	const clears = rule.allowBlank === true ? "; blank clears it" : "";
	if (rule.min > 0 && rule.max !== undefined) return `Use ${noun} from ${rule.min} to ${rule.max}${clears}.`;
	if (rule.min > 0) return `Use ${noun} of at least ${rule.min}${clears}.`;
	return `Use a non-negative ${rule.integer ? "whole number" : "number"}${clears}.`;
}

/**
 * A number editor that stays open on a refused submission. Closing with no
 * value looked like a successful edit that changed nothing, so the reason is
 * rendered under the input and the operator corrects the text in place; Esc
 * still leaves without applying.
 */
function editNumberSubmenu(title: string, id: NumberSettingId): SettingSubmenuBuilder {
	const rule = NUMBER_SETTING_RULES[id];
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.setValue(currentValue);
		input.focused = true;
		const wrapper = new SubmenuWrapper(
			title,
			input,
			buildHint([{ key: "Enter", verb: "confirm" }], "back"),
			numberSettingNote(rule),
		);
		input.onSubmit = (val) => {
			const outcome = parseNumberSetting(val, rule);
			if ("refusal" in outcome) {
				wrapper.setProblem(outcome.refusal);
				return;
			}
			wrapper.setProblem(null);
			done(outcome.value === null ? "" : val.trim());
		};
		input.onEscape = () => done();
		return wrapper;
	};
}

/**
 * The comma-separated set an activation list holds, refused in place when an
 * entry is not one of the legal values. Silently dropping the unknown entry
 * would leave the operator looking at a list they thought they had activated,
 * so the editor stays open and names both the entry and the vocabulary.
 */
function parseEnumListSetting(value: string, legal: readonly string[]): { values: string[] } | { refusal: string } {
	const entries = value
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const unknown = entries.find((entry) => !legal.includes(entry));
	if (unknown !== undefined) {
		return { refusal: `Not applied: '${unknown}' is not one of ${legal.join(", ")}.` };
	}
	const duplicate = entries.find((entry, index) => entries.indexOf(entry) !== index);
	if (duplicate !== undefined) return { refusal: `Not applied: '${duplicate}' is listed twice.` };
	return { values: entries };
}

function editEnumListSubmenu(title: string, legal: readonly string[]): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.setValue(currentValue);
		input.focused = true;
		const wrapper = new SubmenuWrapper(
			title,
			input,
			buildHint([{ key: "Enter", verb: "confirm" }], "back"),
			`Comma-separated, from ${legal.join(", ")}; blank activates none.`,
		);
		input.onSubmit = (val) => {
			const outcome = parseEnumListSetting(val, legal);
			if ("refusal" in outcome) {
				wrapper.setProblem(outcome.refusal);
				return;
			}
			wrapper.setProblem(null);
			done(outcome.values.join(", "));
		};
		input.onEscape = () => done();
		return wrapper;
	};
}

function selectListSubmenu(
	title: string,
	items: ReadonlyArray<{
		value: string;
		label: string;
		presentationKind?: SettingsPresentationKind;
	}>,
	note?: string,
): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const theme = clioTheme();
		const presented = items.map((item) => ({
			value: item.value,
			label:
				item.presentationKind === "destructive-action"
					? theme.fg("error", `${GLYPH.error} ${item.label}`)
					: item.presentationKind === "action"
						? `${GLYPH.active} ${item.label}`
						: item.label,
		}));
		const list = new SettingsSelectList(presented, Math.min(10, Math.max(1, items.length)), DEFAULT_SELECT_THEME);
		const currentIndex = items.findIndex((item) => item.value === currentValue);
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper(title, list, undefined, note);
	};
}

interface ScopedModelChecklistEntry {
	kind: "entry";
	key: string;
	ref: string;
	label: string;
	detail: string;
	available: boolean;
}

interface ScopedModelChecklistGroup {
	kind: "group";
	label: string;
}

type ScopedModelChecklistRow = ScopedModelChecklistEntry | ScopedModelChecklistGroup;
const SCOPED_MODEL_SELECTION_PREFIX = "__clio_scope_v1__:";

function serializeScopedModelSelection(refs: readonly string[]): string {
	return `${SCOPED_MODEL_SELECTION_PREFIX}${JSON.stringify(refs)}`;
}

function parseScopedModelSelection(value: string): string[] | null {
	if (!value.startsWith(SCOPED_MODEL_SELECTION_PREFIX)) return null;
	try {
		const parsed: unknown = JSON.parse(value.slice(SCOPED_MODEL_SELECTION_PREFIX.length));
		return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : null;
	} catch {
		return null;
	}
}

function compactCapabilityCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "unknown";
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}m`;
	if (value >= 1000) return `${Math.round(value / 1000)}k`;
	return String(Math.round(value));
}

function scopedModelCapabilityDetail(caps: CapabilityFlags, thinking?: string): string {
	const enabled = [
		caps.chat ? "chat" : null,
		caps.tools ? "tools" : null,
		caps.reasoning ? "reasoning" : null,
		caps.vision ? "vision" : null,
		caps.audio ? "audio" : null,
		caps.embeddings ? "embeddings" : null,
		caps.rerank ? "rerank" : null,
		caps.fim ? "fim" : null,
	].filter((value): value is string => value !== null);
	return `Capabilities: ${enabled.length > 0 ? enabled.join(", ") : "none reported"} · context ${compactCapabilityCount(caps.contextWindow)} · max output ${compactCapabilityCount(caps.maxTokens)}${thinking ? ` · thinking ${thinking}` : ""}`;
}

function scopedModelEntryDetail(providers: ProvidersContract, status: TargetStatus, model: string | null): string {
	if (!model) {
		return `${scopedModelCapabilityDetail(status.capabilities)} · target-level scope uses this target's default model when switching targets`;
	}
	const resolved = resolveModelRuntimeCapabilitiesForProviders(providers, status.target.id, model);
	return resolved
		? scopedModelCapabilityDetail(resolved.capabilities, resolved.thinking.display)
		: `${scopedModelCapabilityDetail(status.capabilities)} · model details unresolved`;
}

function buildScopedModelChecklistRows(
	selectedRefs: readonly string[],
	providers: ProvidersContract | undefined,
): { rows: ScopedModelChecklistRow[]; availableRefs: ReadonlySet<string> } {
	const rows: ScopedModelChecklistRow[] = [];
	const availableRefs = new Set<string>();
	if (providers) {
		for (const status of providers.list()) {
			const targetRef = status.target.id;
			rows.push({ kind: "group", label: `Target · ${targetRef}` });
			availableRefs.add(targetRef);
			rows.push({
				kind: "entry",
				key: `available:${targetRef}`,
				ref: targetRef,
				label: `${targetRef} (all models)`,
				detail: scopedModelEntryDetail(providers, status, null),
				available: true,
			});
			for (const model of modelsForTarget(status)) {
				const ref = `${targetRef}/${model}`;
				if (availableRefs.has(ref)) continue;
				availableRefs.add(ref);
				rows.push({
					kind: "entry",
					key: `available:${ref}`,
					ref,
					label: ref,
					detail: scopedModelEntryDetail(providers, status, model),
					available: true,
				});
			}
		}
	}
	const unavailable = [...new Set(selectedRefs.filter((ref) => !availableRefs.has(ref.trim())))];
	if (unavailable.length > 0) {
		rows.push({ kind: "group", label: "Unavailable" });
		for (const ref of unavailable) {
			rows.push({
				kind: "entry",
				key: `unavailable:${ref}`,
				ref,
				label: ref,
				detail:
					"Not present in the current provider catalog. It remains selected and will be preserved unchanged unless you uncheck it.",
				available: false,
			});
		}
	}
	if (rows.length === 0) rows.push({ kind: "group", label: "No configured targets or scoped references" });
	return { rows, availableRefs };
}

class ScopedModelChecklist implements Component {
	private readonly rows: ScopedModelChecklistRow[];
	private readonly availableRefs: ReadonlySet<string>;
	private readonly selectedKeys = new Set<string>();
	private selectedRow = 0;

	constructor(
		private readonly originalRefs: readonly string[],
		providers: ProvidersContract | undefined,
		private readonly done: (value?: string) => void,
	) {
		const built = buildScopedModelChecklistRows(originalRefs, providers);
		this.rows = built.rows;
		this.availableRefs = built.availableRefs;
		for (const ref of originalRefs) {
			const trimmed = ref.trim();
			this.selectedKeys.add(this.availableRefs.has(trimmed) ? `available:${trimmed}` : `unavailable:${ref}`);
		}
		this.selectedRow = this.nextEntryIndex(0, 1);
	}

	render(width: number): string[] {
		const theme = clioTheme();
		if (!this.rows.some((row) => row.kind === "entry")) {
			return [theme.fg("dim", "No models are available to select.")];
		}
		const visibleRows = Math.min(10, this.rows.length);
		const [start, end] = scrollWindow(this.rows.length, this.selectedRow, visibleRows);
		const lines = this.rows.slice(start, end).map((row, offset) => {
			if (row.kind === "group") return theme.style("dim", row.label, { bold: true });
			const selected = start + offset === this.selectedRow;
			const checked = this.selectedKeys.has(row.key);
			const pointer = selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
			const check = theme.fg(checked ? "accent" : "dim", checked ? "[x]" : "[ ]");
			const label = selected ? theme.style("accent", row.label, { bold: true }) : theme.fg("muted", row.label);
			return truncateToWidth(`${pointer}${check} ${label}`, Math.max(1, width), ELLIPSIS, true);
		});
		const selected = this.rows[this.selectedRow];
		if (selected?.kind === "entry") {
			const detail = selected.available ? selected.detail : `Unavailable · ${selected.detail}`;
			const wrapped = wrapTextWithAnsi(theme.fg("dim", detail), Math.max(1, width));
			const kept = wrapped.slice(0, 3);
			// A capability sentence that stops at "context 131" reads as the whole
			// fact, so the line that survives the clip says it is not.
			const last = kept.at(-1);
			const marked =
				wrapped.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${ELLIPSIS}`] : kept;
			lines.push("", ...marked);
		}
		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.selectedRow = this.nextEntryIndex(this.selectedRow - 1, -1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.selectedRow = this.nextEntryIndex(this.selectedRow + 1, 1);
			return;
		}
		if (data === " ") {
			const row = this.rows[this.selectedRow];
			if (row?.kind !== "entry") return;
			if (this.selectedKeys.has(row.key)) this.selectedKeys.delete(row.key);
			else this.selectedKeys.add(row.key);
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			this.done(serializeScopedModelSelection(this.selectedRefs()));
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.done();
	}

	invalidate(): void {}

	private nextEntryIndex(from: number, direction: -1 | 1): number {
		if (!this.rows.some((row) => row.kind === "entry")) return 0;
		let index = from;
		for (let attempts = 0; attempts < this.rows.length; attempts += 1) {
			if (index < 0) index = this.rows.length - 1;
			if (index >= this.rows.length) index = 0;
			if (this.rows[index]?.kind === "entry") return index;
			index += direction;
		}
		return 0;
	}

	private selectedRefs(): string[] {
		const preserved = this.originalRefs.filter((ref) => {
			const trimmed = ref.trim();
			const key = this.availableRefs.has(trimmed) ? `available:${trimmed}` : `unavailable:${ref}`;
			return this.selectedKeys.has(key);
		});
		const selectedOriginalRefs = new Set(this.originalRefs.map((ref) => ref.trim()));
		const additions = this.rows
			.filter((row): row is ScopedModelChecklistEntry => row.kind === "entry" && row.available)
			.filter((row) => this.selectedKeys.has(row.key) && !selectedOriginalRefs.has(row.ref))
			.map((row) => row.ref);
		return [...preserved, ...additions];
	}
}

function scopedModelsSubmenu(
	selectedRefs: readonly string[],
	providers: ProvidersContract | undefined,
): SettingSubmenuBuilder {
	return (_currentValue, done) =>
		new SubmenuWrapper(
			"Choose the model cycle set",
			new ScopedModelChecklist(selectedRefs, providers, done),
			buildHint(
				[
					{ key: "Space", verb: "toggle" },
					{ key: "Enter", verb: "continue" },
				],
				"back",
			),
			"Target entries cycle by target, using its default model when switching targets. Model entries pin one exact target/model reference.",
		);
}

/** Two pickers in sequence joined into one committed value; Esc at either step cancels. */
function chainSubmenus(
	first: SettingSubmenuBuilder,
	second: (firstValue: string) => SettingSubmenuBuilder,
	join: (first: string, second: string) => string,
): SettingSubmenuBuilder {
	return (_currentValue: string, done: (val?: string) => void) => {
		let active: Component = first("", (head) => {
			const trimmed = head?.trim() ?? "";
			if (!trimmed) return done();
			active = second(trimmed)("", (tail) => done(tail?.trim() ? join(trimmed, tail.trim()) : undefined));
		});
		return {
			render: (width: number) => active.render(width),
			handleInput: (data: string) => active.handleInput?.(data),
			invalidate: () => active.invalidate?.(),
		};
	};
}

/** Dispatch-eligible targets for a fleet profile; every configured target when no provider domain is wired. */
function profileTargetChoices(
	live: () => Readonly<ClioSettings>,
	providers: ProvidersContract | undefined,
): Array<{ value: string; label: string }> {
	if (!providers)
		return live().targets.map((target) => ({
			value: target.id,
			label: target.id,
		}));
	return providers
		.list()
		.filter((status) => status.runtime !== null && isDispatchEligibleRuntime(status.runtime))
		.map((status) => ({
			value: status.target.id,
			label: `${status.target.id} (${status.target.url ?? "no url"})`,
		}));
}

function profileNameChoices(live: () => Readonly<ClioSettings>): Array<{ value: string; label: string }> {
	const names = Object.keys(live().fleet.profiles).sort();
	return names.map((name) => ({ value: name, label: name }));
}

/**
 * Per-target actions. Probe and connect are not settings changes: they run,
 * then the rows refresh; only use/remove commit.
 */
function targetActionsSubmenu(targetId: string, options: BuildSettingItemsOptions | undefined): SettingSubmenuBuilder {
	const providers = options?.providers;
	const requestRefresh = options?.requestRefresh;
	const connectTarget = options?.connectTarget;
	return (currentValue: string, done: (val?: string) => void) => {
		const status = providers?.list().find((entry) => entry.target.id === targetId);
		const target = status?.target ?? options?.getSettings?.().targets.find((entry) => entry.id === targetId);
		const runtime = status?.runtime ?? null;
		const chatEligible = !providers || (runtime !== null && isOrchestratorEligibleRuntime(runtime));
		const items = [
			...(chatEligible
				? [
						{
							value: "use",
							label: "Use for chat and fleet dispatch",
							presentationKind: "action" as const,
						},
					]
				: []),
			...(connectTarget
				? [
						{
							value: "connect",
							label: "Connect (API key or OAuth), then probe",
							presentationKind: "action" as const,
						},
					]
				: []),
			...(providers
				? [
						{
							value: "probe",
							label: "Probe health now",
							presentationKind: "action" as const,
						},
					]
				: []),
			{
				value: "remove",
				label: "Remove target",
				presentationKind: "destructive-action" as const,
			},
		];
		const details = `URL: ${target?.url ?? "(none)"} · Default model: ${target?.defaultModel ?? "(none)"} · Last probe: ${status?.health.lastCheckAt ? clockLocal(status.health.lastCheckAt) : "never"} · Failure reason: ${status?.health.lastError ?? (!status?.available && status?.reason ? status.reason : "none")}`;
		const note = chatEligible ? details : `Not chat-eligible: its runtime is not HTTP/native. · ${details}`;
		return selectListSubmenu(
			`Target ${targetId}`,
			items,
			note,
		)(currentValue, (value) => {
			const refresh = (): void => requestRefresh?.();
			if (value === "connect" && connectTarget) {
				done();
				const operationToken = {};
				options?.onTargetOperationChange?.(targetId, "connect", operationToken);
				refresh();
				const settle = (): void => {
					options?.onTargetOperationChange?.(targetId, null, operationToken);
					refresh();
				};
				try {
					void Promise.resolve(connectTarget(targetId)).then(settle, settle);
				} catch {
					settle();
				}
				return;
			}
			if (value !== "probe" || !providers) return done(value);
			done();
			const operationToken = {};
			options?.onTargetOperationChange?.(targetId, "probe", operationToken);
			refresh();
			const settle = (): void => {
				options?.onTargetOperationChange?.(targetId, null, operationToken);
				refresh();
			};
			try {
				void Promise.resolve(providers.probeTarget(targetId)).then(settle, settle);
			} catch {
				settle();
			}
		});
	};
}

function sectionForSetting(id: EditableSettingId): SettingsSectionId {
	if (id.startsWith("workers.profiles.") || id.startsWith("workers.agentBindings.") || id.startsWith("fleet.nodes.")) {
		return "fleet";
	}
	if (id.startsWith("targets.")) return "targets";
	for (const section of SETTINGS_SECTIONS) {
		if ((SETTINGS_SECTION_ROWS[section.id] as readonly EditableSettingId[]).includes(id)) return section.id;
	}
	return "safety";
}

function cycleAffordance(values: readonly string[]): string {
	return `cycles: ${values.join(", ")}`;
}

function scopeForId(id: EditableSettingId): SettingScope {
	return RESTART_REQUIRED_IDS.has(id) ? "restart" : "live";
}

/** Shipped default as a display string, for the "default: X" hint and the modified marker. */
function defaultValueFor(id: EditableSettingId): string | undefined {
	const path = settingsV2PathForRow(id);
	if (isRoutingPath(path)) return undefined;
	const raw = getAtPath(DEFAULT_SETTINGS, path);
	if (raw === null || raw === undefined || typeof raw === "object") return undefined;
	if (id === "attribution.gitCommits") return raw === true ? "enabled" : "disabled";
	return String(raw);
}

const SETTINGS_CENTER_V2_PATH_OVERRIDES: Readonly<Record<string, string>> = {
	"workers.profiles": "fleet.profiles",
	"workers.agentBindings": "fleet.agentProfiles",
	"routing.agentAutomation.activeAgentRoles": "fleet.adaptiveRouting.agentRoles",
	"panes.enabled": "interface.panes.enabled",
	"panes.notifications": "interface.panes.notifications",
	"panes.journal": "fleet.history.journal",
	"panes.yazi.enabled": "interface.panes.files.enabled",
	"panes.yazi.mode": "interface.panes.files.mode",
	"panes.yazi.profile": "interface.panes.files.profile",
	"panes.yazi.followCwd": "interface.panes.files.followCwd",
	"panes.yazi.ratio": "interface.panes.files.ratio",
	"panes.layout": "interface.panes.layout",
	"panes.workers.ratio": "interface.panes.workers.ratio",
	"delegation.agents": "integrations.externalAgents.entries",
	keybindings: "interface.keybindings",
};

/** Keep the existing Center navigation while showing and persisting only canonical v2 paths. */
function settingsV2PathForRow(id: EditableSettingId): string {
	if (id.startsWith("workers.profiles.")) return `fleet.profiles.${id.slice("workers.profiles.".length)}`;
	if (id.startsWith("workers.agentBindings.")) return `fleet.agentProfiles.${id.slice("workers.agentBindings.".length)}`;
	const override = SETTINGS_CENTER_V2_PATH_OVERRIDES[id];
	if (override !== undefined) return override;
	for (const [v1Path, v2Path] of SETTINGS_V1_PATH_MOVES) {
		if (v1Path === id) return v2Path;
		if (v1Path === `${id}[]` && v2Path.endsWith("[]")) return v2Path.slice(0, -2);
	}
	return id;
}

function settingItem(
	id: EditableSettingId,
	currentValue: string,
	options: {
		values?: readonly string[];
		submenu?: SettingSubmenuBuilder;
		affordance?: string;
		readOnly?: boolean;
		presentationKind?: SettingsPresentationKind;
		valueSegments?: readonly SettingsValueSegment[];
		label?: string;
		description?: string;
		help?: string;
		editValue?: string;
	},
): SettingsCenterItem {
	const item: SettingsCenterItem = {
		id,
		label: options.label ?? SETTINGS_LABELS_BY_ID[id as keyof typeof SETTINGS_LABELS_BY_ID],
		currentValue,
		description: options.description ?? SETTINGS_DESCRIPTIONS_BY_ID[id as keyof typeof SETTINGS_LABELS_BY_ID],
		section: sectionForSetting(id),
		configPath: settingsV2PathForRow(id),
		affordance: options.affordance ?? (options.values ? cycleAffordance(options.values) : "opens picker"),
		scope: scopeForId(id),
		readOnly: options.readOnly ?? false,
		presentationKind: options.presentationKind ?? (options.readOnly ? "read-only-fact" : "setting"),
		valueSegments: options.valueSegments ?? [{ text: currentValue, tone: "neutral" }],
	};
	const help = options.help ?? SETTINGS_HELP_BY_ID[id];
	if (help) item.help = help;
	if (options.editValue !== undefined) item.editValue = options.editValue;
	const valueHelp = SETTINGS_VALUE_HELP_BY_ID[id];
	if (valueHelp) item.valueHelp = valueHelp;
	const def = defaultValueFor(id);
	if (def !== undefined) item.defaultValue = def;
	if (options.values) item.values = [...options.values];
	if (options.submenu) item.submenu = options.submenu;
	return item;
}

/**
 * A heading row that names the block of settings under it. The id carries the
 * section it belongs to, so one builder serves every section that groups its
 * rows rather than a near-duplicate per section.
 */
function groupHeader(
	id: GroupHeaderId,
	section: SettingsSectionId,
	label: string,
	description: string,
): SettingsCenterItem {
	return {
		id,
		label,
		currentValue: "",
		description,
		section,
		configPath: id,
		affordance: "group heading",
		scope: "live",
		readOnly: true,
		presentationKind: "group-header",
		valueSegments: [],
	};
}

function fleetGroupHeader(id: FleetGroupHeaderId, label: string): SettingsCenterItem {
	return groupHeader(id, "fleet", label, `${label} in the Fleet workbench.`);
}

function terminalGroupHeader(id: TerminalGroupHeaderId, label: string): SettingsCenterItem {
	return groupHeader(id, "terminal", label, `${label} behavior in the terminal.`);
}

function targetAddCta(): SettingsCenterItem {
	return {
		id: "targets.add-cta",
		label: "Add target",
		currentValue: "`clio-coder targets add`",
		description: "Launch the accepted target setup wizard from your shell.",
		section: "targets",
		configPath: "targets.add-cta",
		affordance: "accepted CLI wizard",
		scope: "live",
		readOnly: true,
		presentationKind: "action",
		valueSegments: [{ text: "`clio-coder targets add`", tone: "neutral" }],
	};
}

function thinkingChoices(
	providers: ProvidersContract | undefined,
	target: string | null,
	model: string | null,
	level: ClioSettings["chat"]["thinkingLevel"],
): { display: string; values: readonly string[] } {
	const resolved = providers
		? resolveModelRuntimeCapabilitiesForProviders(providers, target, model, level ?? "off")?.thinking
		: null;
	const display = resolved?.display ?? level ?? "off";
	const values = resolved
		? resolved.supportedLevels.map((entry) => thinkingLevelChoiceLabel(resolved.mechanism, entry))
		: FALLBACK_THINKING_VALUES;
	return { display, values };
}

/**
 * Surface every configurable knob. Editable knobs carry values/submenus;
 * read-only pointer rows (targets, keybindings, favorites, safety net) name the
 * surface that owns them so the Center has no dead-but-tappable rows.
 */
function buildSettingItems(settings: Readonly<ClioSettings>, options?: BuildSettingItemsOptions): SettingsCenterItem[] {
	const live = options?.getSettings ?? ((): Readonly<ClioSettings> => settings);
	const scopeList = settings.chat.modelPicker.cycleSet ?? [];
	const scopeText = scopeList.length > 0 ? scopeList.join(", ") : "(empty)";
	const compaction = settings.context.compaction;
	const retry = settings.chat.retry;
	const terminal = settings.interface;
	const watchdog = settings.safety.review;
	const panes = settings.interface.panes;
	const orchestratorThinking = thinkingChoices(
		options?.providers,
		settings.chat.target,
		settings.chat.model,
		settings.chat.thinkingLevel,
	);
	const workerThinking = thinkingChoices(
		options?.providers,
		settings.fleet.default.target,
		settings.fleet.default.model,
		settings.fleet.default.thinkingLevel,
	);
	const profileCount = Object.keys(settings.fleet.profiles ?? {}).length;
	const addProfileSubmenu = chainSubmenus(
		textInputSubmenu("New profile name"),
		() => selectListSubmenu("Select the profile's target", profileTargetChoices(live, options?.providers)),
		(name, target) => `${name} -> ${target}`,
	);
	const addBindingSubmenu = chainSubmenus(
		textInputSubmenu("Agent id to bind", "Native agents only, such as scout, researcher, or provenance."),
		(agentId) => selectListSubmenu(`Select the profile for ${agentId}`, profileNameChoices(live)),
		(agentId, profile) => `${agentId} -> ${profile}`,
	);
	const targetSubmenu = options?.providers ? selectTargetSubmenu(options.providers) : editTextSubmenu("Type target id");
	const orchestratorModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().chat.target ?? undefined)
		: editTextSubmenu("Type model name");
	const workerModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().fleet.default.target ?? undefined)
		: editTextSubmenu("Type model name");
	const backgroundTargetSubmenu = options?.providers
		? selectOptionalBackgroundTargetSubmenu(options.providers)
		: editTextSubmenu("Type memory target id", "Leave blank for rules-only memory.");
	const backgroundModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().context.memory.target ?? undefined)
		: editTextSubmenu("Type memory model name");
	// Both are optional in the settings type, so the row falls back to the
	// shipped value rather than rendering a blank for a key that is in force.
	const escalation = settings.fleet.permissions.escalation ?? SHIPPED_ESCALATION;
	const resilienceCooldownMs = settings.fleet.retry.routeCooldownMs ?? SHIPPED_RESILIENCE_COOLDOWN_MS;
	const workingSet = settings.context.workingSet;
	const safetyLimits = settings.safety.limits;
	const fleetLimits = settings.fleet.limits;
	const routing = settings.fleet.adaptiveRouting;
	const library = settings.integrations.library;
	const activeAgentRoles = routing.agentRoles;
	const favorites = settings.chat.modelPicker?.favorites ?? [];
	const agents = settings.integrations.externalAgents?.entries ?? [];
	const keybindingCount = Object.keys(settings.interface.keybindings ?? {}).length;
	return [
		settingItem("autonomy", settings.safety.autonomy, {
			values: ["read-only", "suggest", "auto-edit", "full-auto"],
		}),
		settingItem("workers.onPermission", settings.fleet.permissions.mode ?? "deny", {
			values: ["deny", "fail", "escalate"],
		}),
		settingItem("workers.escalation.timeoutMs", String(escalation.timeoutMs), {
			submenu: editNumberSubmenu("Edit escalation timeout (ms)", "workers.escalation.timeoutMs"),
			affordance: "free text",
		}),
		settingItem("workers.escalation.fallback", escalation.fallback, {
			values: ["deny", "fail"],
		}),
		settingItem("delegation.defaults.toolGovernance", settings.integrations.externalAgents.defaults.toolGovernance, {
			values: ["clio-coder-policy", "agent-managed", "deny-all"],
		}),
		settingItem("skills.trustProjectCompatRoots", String(settings.integrations.projectResources.trustProjectImports), {
			values: ["false", "true"],
		}),
		settingItem("safetyNet", "always on", {
			affordance: "tuned in .clio-coder/safety.yaml",
			readOnly: true,
		}),
		settingItem("orchestrator.thinkingLevel", orchestratorThinking.display, {
			values: orchestratorThinking.values,
		}),
		settingItem("orchestrator.target", settings.chat.target ?? "(unset)", {
			submenu: targetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("orchestrator.model", settings.chat.model ?? "(unset)", {
			submenu: orchestratorModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("background.target", settings.context.memory.target ?? "(unset — rules-only)", {
			submenu: backgroundTargetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("background.model", settings.context.memory.model ?? "(unset)", {
			submenu: backgroundModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("memory.intervention.enabled", String(settings.context.memory.enabled), {
			values: ["true", "false"],
		}),
		settingItem("memory.intervention.everyNTools", String(settings.context.memory.cadenceToolCalls), {
			values: ["5", "10", "20", "30"],
		}),
		settingItem("memory.intervention.windowSteps", String(settings.context.memory.trajectorySteps), {
			values: ["4", "8", "12", "20"],
		}),
		settingItem("memory.intervention.maxTokens", String(settings.context.memory.maxOutputTokens), {
			values: ["100", "200", "400", "800"],
		}),
		settingItem("memory.intervention.timeoutMs", String(settings.context.memory.timeoutMs), {
			values: ["5000", "10000", "20000", "30000", "60000"],
		}),
		settingItem("prewarm.enabled", String(settings.chat.prewarm), {
			values: ["true", "false"],
		}),
		fleetGroupHeader("fleet.group.defaults", "Defaults"),
		settingItem("workers.default.target", settings.fleet.default.target ?? "(unset)", {
			submenu: targetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("workers.default.model", settings.fleet.default.model ?? "(unset)", {
			submenu: workerModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("workers.default.thinkingLevel", workerThinking.display, {
			values: workerThinking.values,
		}),
		settingItem("workers.maxRetries", String(settings.fleet.retry.maxRetries), {
			values: ["0", "1", "2", "3", "5", "8"],
		}),
		settingItem("workers.resilienceCooldownMs", String(resilienceCooldownMs), {
			submenu: editNumberSubmenu("Edit resilience cooldown (ms)", "workers.resilienceCooldownMs"),
			affordance: "free text",
		}),
		fleetGroupHeader("fleet.group.profiles", "Profiles"),
		...fleetProfileRows(settings, live, options),
		settingItem("workers.profiles", "", {
			label: "Add profile",
			submenu: addProfileSubmenu,
			affordance: "Enter: name and route a new profile",
			presentationKind: "action",
			valueSegments: [],
		}),
		fleetGroupHeader("fleet.group.agent-routes", "Agent routes"),
		...agentBindingRows(settings, live),
		settingItem("workers.agentBindings", "", {
			label: "Add agent route",
			...(profileCount > 0 ? { submenu: addBindingSubmenu } : { readOnly: true }),
			affordance: profileCount > 0 ? "Enter binds an agent" : "create a profile first",
			presentationKind: profileCount > 0 ? "action" : "read-only-fact",
			valueSegments: [],
		}),
		fleetGroupHeader("fleet.group.route-activation", "Route activation"),
		settingItem("routing.activeRoles", routing.roles.length > 0 ? routing.roles.join(", ") : "(none)", {
			submenu: editEnumListSubmenu("Edit active routing roles", ACTIVE_ROUTING_ROLES),
			affordance: `free text from ${ACTIVE_ROUTING_ROLES.join(", ")}`,
			editValue: routing.roles.join(", "),
		}),
		settingItem("routing.activePostures", routing.postures.length > 0 ? routing.postures.join(", ") : "(none)", {
			submenu: editEnumListSubmenu("Edit active routing postures", ACTIVE_ROUTING_POSTURES),
			affordance: `free text from ${ACTIVE_ROUTING_POSTURES.join(", ")}`,
			editValue: routing.postures.join(", "),
		}),
		settingItem(
			"routing.agentAutomation.activeAgentRoles",
			activeAgentRoles.length > 0
				? activeAgentRoles.map((pair) => `${pair.agentId}/${pair.executionRole}`).join(", ")
				: "(none)",
			{ affordance: "edit settings.yaml", readOnly: true },
		),
		fleetGroupHeader("fleet.group.placement", "Placement"),
		...fleetNodeRows(options?.getFleetNodes?.() ?? []),
		...fleetEndpointRows(options?.providers),
		fleetGroupHeader("fleet.group.panes", "Panes"),
		settingItem("panes.enabled", panes.enabled, { values: ["auto", "embedded", "off"] }),
		settingItem("panes.notifications", panes.notifications, { values: ["failures", "all", "off"] }),
		settingItem("panes.layout", panes.layout, { values: ["off", "workers", "cockpit"] }),
		settingItem("panes.workers.ratio", formatThreshold(panes.workers.ratio, "0.34"), {
			submenu: editNumberSubmenu("Edit workers dock share (0.05–0.5)", "panes.workers.ratio"),
			affordance: "free text",
		}),
		settingItem("panes.journal", String(settings.fleet.history.journal), { values: ["true", "false"] }),
		settingItem("targets", "", {
			description: "Live inference target inventory and routing roles.",
			affordance: "column heading",
			readOnly: true,
			presentationKind: "group-header",
			valueSegments: [],
		}),
		...targetRows(settings, options),
		targetAddCta(),
		settingItem("scope", scopeText, {
			submenu: scopedModelsSubmenu(scopeList, options?.providers),
			affordance: "opens provider-backed checklist",
		}),
		settingItem("modelSelector.recentLimit", String(settings.chat.modelPicker.recentLimit), {
			values: ["6", "12", "20", "50"],
		}),
		settingItem("modelSelector.favorites", favorites.length > 0 ? `${favorites.length} pinned` : "(none)", {
			affordance: "manage in /model",
			readOnly: true,
		}),
		settingItem("budget.sessionCeilingUsd", String(settings.safety.limits.sessionCostUsd), {
			submenu: editNumberSubmenu("Edit session cost ceiling USD", "budget.sessionCeilingUsd"),
			affordance: "free text",
		}),
		settingItem("defaults.maxTokens", String(settings.chat.maxOutputTokens), {
			values: ["0", "4096", "8192", "16384", "32768", "65536", "131072"],
		}),
		settingItem("budget.concurrency", String(settings.fleet.concurrency), {
			values: ["auto", "1", "2", "4", "8"],
		}),
		groupHeader(
			"budget.group.guardrails",
			"budget",
			"Guardrails",
			"Numeric backstops that bound runaway agent behavior.",
		),
		settingItem("guardrails.turnToolCallBudget", String(safetyLimits.chatToolCallsPerTurn), {
			submenu: editNumberSubmenu("Edit turn tool-call budget", "guardrails.turnToolCallBudget"),
			affordance: "free text",
		}),
		settingItem("guardrails.workerToolCallCap", String(fleetLimits.toolCallsPerRun), {
			submenu: editNumberSubmenu("Edit worker tool-call cap", "guardrails.workerToolCallCap"),
			affordance: "free text",
		}),
		settingItem("guardrails.maxDispatchRuns", String(settings.fleet.history.maxRuns), {
			submenu: editNumberSubmenu("Edit run ledger retention", "guardrails.maxDispatchRuns"),
			affordance: "free text",
		}),
		settingItem("guardrails.readMaxBytes", String(safetyLimits.readBytesPerCall), {
			submenu: editNumberSubmenu("Edit read byte cap", "guardrails.readMaxBytes"),
			affordance: "free text",
		}),
		settingItem("guardrails.observationTurnBudgetBytes", String(safetyLimits.observationBytesPerTurn), {
			submenu: editNumberSubmenu("Edit observation byte pool", "guardrails.observationTurnBudgetBytes"),
			affordance: "free text",
		}),
		settingItem("guardrails.internalDispatchTimeoutMs", String(fleetLimits.internalRunTimeoutMs), {
			submenu: editNumberSubmenu("Edit internal dispatch timeout (ms)", "guardrails.internalDispatchTimeoutMs"),
			affordance: "free text",
		}),
		settingItem("compaction.auto", String(compaction.auto), {
			values: ["true", "false"],
		}),
		settingItem("compaction.threshold", formatThreshold(compaction.threshold), {
			values: ["0.7", "0.8", "0.85", "0.9"],
		}),
		groupHeader(
			"compaction.group.working-set",
			"compaction",
			"Working set",
			"The non-destructive eviction layer that runs before a summary is needed.",
		),
		settingItem("context.workingSet.enabled", String(workingSet.enabled), {
			values: ["true", "false"],
		}),
		settingItem("context.workingSet.policy", workingSet.policy, {
			values: ["structural-v1", "age-horizon"],
		}),
		settingItem("context.workingSet.target", formatThreshold(workingSet.target, "0.6"), {
			values: ["0.4", "0.5", "0.6", "0.7"],
		}),
		settingItem("context.workingSet.protectLastTurns", String(workingSet.protectLastTurns), {
			values: ["3", "6", "10", "15"],
		}),
		settingItem("context.workingSet.minEvictableTokens", String(workingSet.minEvictableTokens), {
			values: ["0", "100", "200", "500", "1000"],
		}),
		settingItem("retry.enabled", String(retry.enabled), {
			values: ["true", "false"],
		}),
		settingItem("retry.maxRetries", String(retry.maxRetries), {
			values: ["0", "1", "2", "3", "5", "8"],
		}),
		settingItem("retry.baseDelayMs", String(retry.baseDelayMs), {
			values: ["500", "1000", "2000", "5000", "10000"],
		}),
		settingItem("retry.maxDelayMs", String(retry.maxDelayMs), {
			values: ["10000", "30000", "60000", "120000", "300000"],
		}),
		settingItem("retry.streamStallMs", String(retry.streamStallMs), {
			values: ["60000", "120000", "180000", "300000", "600000"],
		}),
		settingItem("terminal.showTerminalProgress", String(terminal.terminalProgress), {
			values: ["false", "true"],
		}),
		settingItem("terminal.outputVerbosity", terminal.outputDetail, {
			values: ["minimal", "default", "verbose"],
		}),
		settingItem("terminal.tuiMode", terminal.mode, {
			values: ["regular", "fullscreen"],
		}),
		settingItem("terminal.fullscreenScrollbar", terminal.fullscreenScrollbar, {
			values: ["hidden", "auto", "always"],
		}),
		settingItem("terminal.smoothStreaming", terminal.smoothStreaming, {
			values: ["off", "auto", "on"],
		}),
		settingItem("terminal.notify", String(terminal.desktopNotifications), {
			values: ["false", "true"],
		}),
		terminalGroupHeader("terminal.group.files-pane", "Files pane"),
		settingItem("panes.yazi.enabled", String(panes.files.enabled), { values: ["true", "false"] }),
		settingItem("panes.yazi.mode", panes.files.mode, { values: ["companion", "chooser"] }),
		settingItem("panes.yazi.profile", panes.files.profile, { values: ["managed", "user"] }),
		settingItem("panes.yazi.followCwd", String(panes.files.followCwd), { values: ["true", "false"] }),
		settingItem("panes.yazi.ratio", formatThreshold(panes.files.ratio, "0.3"), {
			submenu: editNumberSubmenu("Edit files dock share (0.05–0.5)", "panes.yazi.ratio"),
			affordance: "free text",
		}),
		settingItem("watchdog.enabled", String(watchdog.enabled), {
			values: ["false", "true"],
		}),
		// Both optional keys render their absence rather than a fabricated value:
		// an unset target means the session's own, and an unset cadence means the
		// watchdog fires at turn end only. Submitting an empty value clears them.
		settingItem("watchdog.target", watchdog.target ?? "(session target)", {
			submenu: editTextSubmenu("Edit watchdog target; blank uses the session's active target"),
			affordance: "free text",
			editValue: watchdog.target ?? "",
		}),
		settingItem(
			"watchdog.cadenceToolCalls",
			watchdog.cadenceToolCalls === undefined ? "(turn end only)" : String(watchdog.cadenceToolCalls),
			{
				submenu: editNumberSubmenu(
					"Edit watchdog cadence in tool calls; blank fires at turn end only",
					"watchdog.cadenceToolCalls",
				),
				affordance: "free text",
				editValue: watchdog.cadenceToolCalls === undefined ? "" : String(watchdog.cadenceToolCalls),
			},
		),
		settingItem(
			"runtimePlugins",
			settings.integrations.runtimePlugins.length > 0 ? settings.integrations.runtimePlugins.join(", ") : "(none)",
			{
				submenu: editTextSubmenu("Edit runtime plugins comma-separated list", "Restart Clio to load changes."),
				affordance: "free text",
			},
		),
		settingItem("attribution.gitCommits", settings.integrations.git.commitAttribution ? "enabled" : "disabled", {
			values: ["enabled", "disabled"],
		}),
		settingItem("compaction.model", compaction.model ?? "(orchestrator target)", {
			submenu: editTextSubmenu("Edit compaction model; blank uses the orchestrator"),
			affordance: "free text",
		}),
		settingItem("compaction.systemPrompt", compaction.systemPrompt ?? "(built-in)", {
			submenu: editTextSubmenu("Edit compaction prompt path; blank uses the built-in"),
			affordance: "free text",
		}),
		settingItem(
			"delegation.defaults.connectTimeoutMs",
			String(settings.integrations.externalAgents.defaults.connectTimeoutMs),
			{
				submenu: editNumberSubmenu("Edit delegate connect timeout (ms)", "delegation.defaults.connectTimeoutMs"),
				affordance: "free text",
			},
		),
		settingItem(
			"delegation.defaults.turnTimeoutMs",
			String(settings.integrations.externalAgents.defaults.turnTimeoutMs),
			{
				submenu: editNumberSubmenu("Edit delegate turn timeout (ms)", "delegation.defaults.turnTimeoutMs"),
				affordance: "free text",
			},
		),
		settingItem(
			"delegation.defaults.permissionTimeoutMs",
			String(settings.integrations.externalAgents.defaults.permissionTimeoutMs),
			{
				submenu: editNumberSubmenu("Edit delegate permission timeout (ms)", "delegation.defaults.permissionTimeoutMs"),
				affordance: "free text",
			},
		),
		settingItem("keybindings", keybindingCount > 0 ? `${keybindingCount} override(s)` : "(defaults)", {
			affordance: "edit settings.yaml",
			readOnly: true,
		}),
		settingItem("delegation.agents", agents.length > 0 ? `${agents.length} agent(s)` : "(none)", {
			...delegationAgentsAffordance(agents, options?.getInteropProposals?.() ?? []),
		}),
		groupHeader(
			"advanced.group.library",
			"advanced",
			"Library",
			"The private resource catalog and the remote it may sync with.",
		),
		settingItem("library.catalog", library.catalog ?? "(config directory)", {
			submenu: editTextSubmenu("Edit library catalog path; blank uses the config directory"),
			affordance: "free text",
			editValue: library.catalog ?? "",
		}),
		settingItem("library.remote", library.remote ?? "(local only)", {
			submenu: editTextSubmenu("Edit library remote URL; blank keeps the library local"),
			affordance: "free text",
			editValue: library.remote ?? "",
		}),
		// Confirming a remote from the settings row would be the trust record
		// confirming itself, so this row reports what the confirm flow wrote.
		settingItem("library.confirmedRemote", library.confirmedRemote ?? "(unconfirmed)", {
			affordance: "set by `clio-coder library` on confirmation",
			readOnly: true,
		}),
		settingItem("library.sync", String(library.sync), {
			values: ["true", "false"],
		}),
	];
}

function fleetProfileRows(
	settings: Readonly<ClioSettings>,
	live: () => Readonly<ClioSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingsCenterItem[] {
	const providers = options?.providers;
	return Object.entries(settings.fleet.profiles)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, profile]) => {
			const thinking = thinkingChoices(providers, profile.target, profile.model, profile.thinkingLevel);
			const target = profile.target ?? "(unset)";
			const model = profile.model ?? "(unset)";
			const placement = profile.node ?? "auto";
			const summary = `${target}/${model}  ${thinking.display}  ${placement}`;
			const compactThinking = truncateProfileFact(thinking.display, 7);
			const compactPlacement = truncateProfileFact(placement, 7);
			const route = target === settings.fleet.default.target ? model : `${target}/${model}`;
			const routeBudget = Math.max(
				8,
				PROFILE_SUMMARY_VALUE_BUDGET -
					visibleWidth(compactThinking) -
					visibleWidth(compactPlacement) -
					visibleWidth(ROW_GAP) * 2,
			);
			const compactRoute = truncateProfileFact(route, routeBudget);
			return settingItem(`workers.profiles.${name}`, summary, {
				label: name,
				description: `Profile ${name}. Enter to edit its target, model, thinking level, placement, or remove it.`,
				help: ["target", "model", "thinkingLevel", "node"].map((field) => `fleet.profiles.${name}.${field}`).join(" · "),
				submenu: profileWorkbenchSubmenu(name, settings, live, options),
				affordance: "Enter: drill into profile fields",
				valueSegments: [
					{ text: compactRoute, tone: "neutral" },
					{ text: `${ROW_GAP}${compactThinking}`, tone: "neutral" },
					{ text: `${ROW_GAP}${compactPlacement}`, tone: "neutral" },
				],
			});
		});
}

function profileWorkbenchSubmenu(
	name: string,
	settings: Readonly<ClioSettings>,
	live: () => Readonly<ClioSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingSubmenuBuilder {
	return (_currentValue: string, done: (value?: string) => void): Component => {
		const fields = [
			{ value: "target", label: "Edit target", presentationKind: "action" as const },
			{ value: "model", label: "Edit model", presentationKind: "action" as const },
			{ value: "thinkingLevel", label: "Edit thinking level", presentationKind: "action" as const },
			{ value: "node", label: "Edit placement", presentationKind: "action" as const },
			{
				value: "remove",
				label: "Remove profile",
				presentationKind: "destructive-action" as const,
			},
		];
		let active: Component;
		const openField = (field?: string): void => {
			if (!field) {
				done();
				return;
			}
			const profile = live().fleet.profiles[name];
			if (!profile) {
				done();
				return;
			}
			if (field === "remove") {
				done(REMOVE_PROFILE_CHOICE);
				return;
			}
			const finish = (value?: string): void =>
				done(value === undefined ? undefined : `${field}${PROFILE_FIELD_SEPARATOR}${value}`);
			if (field === "target") {
				active = selectListSubmenu(
					`Target for profile ${name}`,
					profileTargetChoices(live, options?.providers),
					"Changing the target rebases the model on that target's default.",
				)(profile.target ?? "(unset)", finish);
				return;
			}
			if (field === "model") {
				const submenu = options?.providers
					? selectModelSubmenu(options.providers, () => live().fleet.profiles[name]?.target ?? undefined)
					: editTextSubmenu("Type model name");
				active = submenu(profile.model ?? "(unset)", finish);
				return;
			}
			if (field === "thinkingLevel") {
				const thinking = thinkingChoices(options?.providers, profile.target, profile.model, profile.thinkingLevel);
				active = selectListSubmenu(
					`Thinking level for profile ${name}`,
					thinking.values.map((value) => ({ value, label: value })),
				)(thinking.display, finish);
				return;
			}
			active = selectListSubmenu(`Placement for profile ${name}`, profileNodeChoices(settings, options))(
				profile.node ?? AUTO_PLACEMENT_CHOICE,
				finish,
			);
		};
		const picker = selectListSubmenu(`Profile ${name}`, fields)("", openField);
		active = picker;
		return {
			render: (width: number) => active.render(width),
			handleInput: (data: string) => active.handleInput?.(data),
			invalidate: () => active.invalidate?.(),
		};
	};
}

/** Pin choices: auto placement, never-remote local, then every declared node (with live state when known). */
function profileNodeChoices(
	settings: Readonly<ClioSettings>,
	options: BuildSettingItemsOptions | undefined,
): Array<{ value: string; label: string }> {
	const live = new Map(options?.getFleetNodes?.().map((node) => [node.id, node] as const) ?? []);
	return [
		{ value: AUTO_PLACEMENT_CHOICE, label: AUTO_PLACEMENT_CHOICE },
		{ value: "local", label: "local (never remote)" },
		...settings.fleet.nodes.map((node) => {
			const state = live.get(node.id);
			return {
				value: node.id,
				label: `${node.id} (${node.host}${state ? `, ${state.state}` : ""})`,
			};
		}),
	];
}

function agentBindingRows(settings: Readonly<ClioSettings>, live: () => Readonly<ClioSettings>): SettingsCenterItem[] {
	return Object.entries(settings.fleet.agentProfiles)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([agentId, profileName]) => {
			const missing = !settings.fleet.profiles[profileName];
			return settingItem(`workers.agentBindings.${agentId}`, profileName, {
				label: `${agentId} · profile`,
				description: missing
					? `Agent ${agentId} is bound to profile ${profileName}, which does not exist; it dispatches on the fleet default until the profile is created.`
					: `Profile agent ${agentId} dispatches with.`,
				submenu: selectListSubmenu(`Profile for ${agentId}`, [
					...profileNameChoices(live),
					{ value: UNBIND_CHOICE, label: UNBIND_CHOICE },
				]),
			});
		});
}

function targetRows(
	settings: Readonly<ClioSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingsCenterItem[] {
	const providers = options?.providers;
	const statuses = new Map(providers?.list().map((status) => [status.target.id, status] as const) ?? []);
	return settings.targets.map((target) => {
		const status = statuses.get(target.id);
		const roles = [
			settings.chat.target === target.id ? "chat" : null,
			settings.fleet.default.target === target.id ? "fleet" : null,
			settings.context.memory.target === target.id ? "memory" : null,
		].filter((role) => role !== null);
		const health = status?.health.status ?? "unknown";
		const operation = options?.getTargetOperation?.(target.id) ?? null;
		const roleText = roles.length > 0 ? roles.join("+") : "—";
		const healthSegment = targetHealthSegment(health);
		const activitySegment: SettingsValueSegment | null = operation
			? {
					text: `${GLYPH.running} ${operation === "connect" ? "connecting" : "probing"}`,
					tone: "activity",
				}
			: null;
		const liveHealth = activitySegment ?? healthSegment;
		const runtime = status?.runtime?.id ?? target.runtime;
		const latency =
			status?.health.latencyMs === null || status?.health.latencyMs === undefined ? "—" : `${status.health.latencyMs} ms`;
		const lastProbe = status?.health.lastCheckAt ? clockLocal(status.health.lastCheckAt) : "never";
		const failureReason = status?.health.lastError ?? (!status?.available && status?.reason ? status.reason : "none");
		const valueSegments = [
			liveHealth,
			{ text: `  ${target.id}`, tone: "neutral" as const },
			{ text: `  ${roleText}`, tone: "neutral" as const },
			{ text: `  ${runtime}`, tone: "neutral" as const },
			{ text: `  ${latency}`, tone: "neutral" as const },
		];
		const value = `${health} · ${target.id} · ${roleText} · ${runtime} · ${latency}`;
		const item = settingItem(`targets.${target.id}`, value, {
			label: target.id,
			description: `URL: ${target.url ?? "(none)"} · Default model: ${target.defaultModel ?? "(none)"}`,
			help: `Last probe: ${lastProbe} · Failure reason: ${failureReason}`,
			submenu: targetActionsSubmenu(target.id, options),
			affordance: options?.connectTarget ? "Enter: use, connect, probe, remove" : "Enter: use, probe, remove",
			presentationKind: "status",
			valueSegments,
		});
		item.targetConsole = {
			health: liveHealth,
			id: target.id,
			roles: roleText,
			runtime,
			latency,
			url: target.url ?? "(none)",
			defaultModel: target.defaultModel ?? "(none)",
			lastProbe,
			failureReason,
		};
		return item;
	});
}

function targetHealthSegment(status: TargetHealth["status"]): SettingsValueSegment {
	switch (status) {
		case "healthy":
			return { text: `${GLYPH.running} healthy`, tone: "healthy" };
		case "degraded":
			return { text: "◐ degraded", tone: "degraded" };
		case "down":
			return { text: "○ down", tone: "unhealthy" };
		case "unknown":
			return { text: "? unknown", tone: "unknown" };
	}
}

/** Read-only placement rows: where dispatched workers run, from the live scheduler snapshot. */
function fleetNodeRows(nodes: ReadonlyArray<FleetNodeSnapshot>): SettingsCenterItem[] {
	return nodes.map((node) => {
		const busy = node.maxWorkers > 0 ? `${node.activeWorkers}/${node.maxWorkers} busy` : `${node.activeWorkers} busy`;
		return settingItem(`fleet.nodes.${node.id}`, `${node.state} · ${busy}`, {
			label: `node ${node.id}`,
			description: `${node.kind} · ${node.host}${node.stateReason ? ` · ${node.stateReason}` : ""}${node.lastSeenAt ? ` · seen ${clockLocal(node.lastSeenAt)}` : ""}`,
			affordance: "declared as fleet.nodes in settings.yaml; `clio-coder doctor` preflights them",
			readOnly: true,
			presentationKind: "status",
			valueSegments: [
				{
					text: `${node.state === "online" ? GLYPH.running : "○"} ${node.state}`,
					tone: node.state === "online" ? "healthy" : "unhealthy",
				},
				{ text: ` · ${busy}`, tone: "neutral" },
			],
		});
	});
}

/** Read-only endpoint rows show the independent inference scheduler dimension. */
function fleetEndpointRows(providers: ProvidersContract | undefined): SettingsCenterItem[] {
	if (providers === undefined) return [];
	let usage: Readonly<Record<string, number>> = {};
	try {
		usage = capacityLeaseUsage().endpoints;
	} catch {
		// A damaged capacity file belongs to admission. Settings still shows the configured limits.
	}
	const capacities = endpointCapacitiesForStatuses(providers.list());
	const targetsByEndpoint = new Map<string, string[]>();
	for (const status of providers.list()) {
		const endpoint = endpointCapacityForStatus(status);
		if (endpoint === null) continue;
		targetsByEndpoint.set(endpoint.key, [...(targetsByEndpoint.get(endpoint.key) ?? []), status.target.id]);
	}
	return Object.entries(capacities).map(([key, endpoint]) => {
		const slots = `slots ${usage[key] ?? 0}/${endpoint.limit}`;
		return settingItem(`fleet.endpoints.${key}`, slots, {
			label: `endpoint ${endpoint.label}`,
			description: `Targets: ${(targetsByEndpoint.get(key) ?? []).join(", ")} · Limit source: ${endpoint.source}`,
			affordance: "read-only inference endpoint capacity",
			readOnly: true,
			presentationKind: "status",
			valueSegments: [{ text: slots, tone: "neutral" }],
		});
	});
}

function buildSettingsSections(items: readonly SettingsCenterItem[]): SettingsCenterSection[] {
	return SETTINGS_SECTIONS.map((section) => ({
		id: section.id,
		label: section.label,
		items: items.filter((item) => item.section === section.id),
	}));
}

function refreshSettingItemsInPlace(items: SettingsCenterItem[], next: readonly SettingsCenterItem[]): void {
	const byId = new Map(next.map((item) => [item.id, item] as const));
	// Entry rows come and go with their profiles, bindings, and targets; surviving row objects keep their identity.
	const existing = new Map(items.map((item) => [item.id, item] as const));
	items.splice(0, items.length, ...next.map((item) => existing.get(item.id) ?? item));
	for (const item of items) {
		const updated = byId.get(item.id);
		if (!updated) continue;
		item.label = updated.label;
		item.currentValue = updated.currentValue;
		item.description = updated.description;
		item.section = updated.section;
		item.configPath = updated.configPath;
		item.affordance = updated.affordance;
		item.scope = updated.scope;
		item.readOnly = updated.readOnly;
		item.presentationKind = updated.presentationKind;
		item.valueSegments = updated.valueSegments;
		if (updated.targetConsole) item.targetConsole = updated.targetConsole;
		else delete item.targetConsole;
		if (updated.help) item.help = updated.help;
		else delete item.help;
		if (updated.valueHelp) item.valueHelp = updated.valueHelp;
		else delete item.valueHelp;
		if (updated.defaultValue !== undefined) item.defaultValue = updated.defaultValue;
		else delete item.defaultValue;
		if (updated.values) item.values = updated.values;
		else delete item.values;
		if (updated.submenu) item.submenu = updated.submenu;
		else delete item.submenu;
	}
}

function formatThreshold(value: number, fallback = "0.8"): string {
	return Number.isFinite(value) ? String(value) : fallback;
}

function applyNonNegativeInteger(value: string, set: (next: number) => void): void {
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed >= 0) set(Math.floor(parsed));
}

/**
 * Store a number-row submission under the row's shared rule. A refused value
 * leaves the setting alone; the editor has already shown the operator why, and
 * `describeNumberSettingRefusal` names the reason for any other caller.
 */
function applyNumberSetting(id: NumberSettingId, value: string, set: (next: number | null) => void): void {
	const outcome = parseNumberSetting(value, NUMBER_SETTING_RULES[id]);
	if ("refusal" in outcome) return;
	set(outcome.value);
}

/**
 * Pure mutation applied in place for Settings Center editable rows.
 */
function applyDelegationAgentChange(settings: ClioSettings, value: string): void {
	if (value.startsWith(DELEGATION_REMOVE_PREFIX)) {
		const id = value.slice(DELEGATION_REMOVE_PREFIX.length);
		settings.integrations.externalAgents.entries = settings.integrations.externalAgents.entries.filter(
			(agent) => agent.id !== id,
		);
		return;
	}
	if (!value.startsWith(DELEGATION_ADD_PREFIX)) return;
	const kind = interopAgentKind(value.slice(DELEGATION_ADD_PREFIX.length) as InteropAgentId);
	if (kind?.acp === undefined) return;
	const entry = delegationEntryForKind(kind, settings.integrations.externalAgents.defaults);
	if (settings.integrations.externalAgents.entries.some((agent) => agent.id === entry.id)) return;
	settings.integrations.externalAgents.entries.push(entry);
}

function applySettingChange(settings: ClioSettings, id: string, value: string): void {
	if (applyEntrySettingChange(settings, id, value)) return;
	switch (id) {
		case "autonomy":
			if (value === "read-only" || value === "suggest" || value === "auto-edit" || value === "full-auto")
				settings.safety.autonomy = value;
			return;
		case "workers.onPermission":
			if (value === "deny" || value === "fail" || value === "escalate") settings.fleet.permissions.mode = value;
			return;
		case "delegation.defaults.toolGovernance":
			if (value === "clio-coder-policy" || value === "agent-managed" || value === "deny-all")
				settings.integrations.externalAgents.defaults.toolGovernance = value;
			return;
		case "delegation.agents":
			applyDelegationAgentChange(settings, value);
			return;
		case "skills.trustProjectCompatRoots":
			if (value === "true" || value === "false")
				settings.integrations.projectResources.trustProjectImports = value === "true";
			return;
		case "attribution.gitCommits":
			if (value === "enabled" || value === "disabled") settings.integrations.git.commitAttribution = value === "enabled";
			return;
		case "orchestrator.thinkingLevel":
			settings.chat.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.chat.thinkingLevel;
			return;
		case "memory.intervention.enabled":
			if (value === "true" || value === "false") settings.context.memory.enabled = value === "true";
			return;
		case "memory.intervention.everyNTools":
		case "memory.intervention.windowSteps":
		case "memory.intervention.maxTokens":
		case "memory.intervention.timeoutMs":
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) {
					// The v1 row ids are the presentation vocabulary; the v2 fields they
					// write have their own names.
					const key = (
						{
							"memory.intervention.everyNTools": "cadenceToolCalls",
							"memory.intervention.windowSteps": "trajectorySteps",
							"memory.intervention.maxTokens": "maxOutputTokens",
							"memory.intervention.timeoutMs": "timeoutMs",
						} as const
					)[id];
					if (key) settings.context.memory[key] = next;
				}
			});
			return;
		case "workers.default.thinkingLevel":
			settings.fleet.default.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.fleet.default.thinkingLevel;
			return;
		case "workers.maxRetries":
			applyNonNegativeInteger(value, (next) => {
				settings.fleet.retry.maxRetries = next;
			});
			return;
		case "panes.enabled":
			if (value === "auto" || value === "embedded" || value === "off") settings.interface.panes.enabled = value;
			return;
		case "panes.notifications":
			if (value === "failures" || value === "all" || value === "off") settings.interface.panes.notifications = value;
			return;
		case "panes.layout":
			if (value === "off" || value === "workers" || value === "cockpit") settings.interface.panes.layout = value;
			return;
		case "panes.workers.ratio":
			applyNumberSetting(id, value, (next) => {
				if (next !== null) settings.interface.panes.workers.ratio = next;
			});
			return;
		case "panes.yazi.ratio":
			applyNumberSetting(id, value, (next) => {
				if (next !== null) settings.interface.panes.files.ratio = next;
			});
			return;
		case "panes.journal":
			if (value === "true" || value === "false") settings.fleet.history.journal = value === "true";
			return;
		case "panes.yazi.enabled":
			if (value === "true" || value === "false") settings.interface.panes.files.enabled = value === "true";
			return;
		case "panes.yazi.mode":
			if (value === "companion" || value === "chooser") settings.interface.panes.files.mode = value;
			return;
		case "panes.yazi.profile":
			if (value === "managed" || value === "user") settings.interface.panes.files.profile = value;
			return;
		case "panes.yazi.followCwd":
			if (value === "true" || value === "false") settings.interface.panes.files.followCwd = value === "true";
			return;
		case "modelSelector.recentLimit":
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) settings.chat.modelPicker.recentLimit = next;
			});
			return;
		case "defaults.maxTokens":
			applyNonNegativeInteger(value, (next) => {
				settings.chat.maxOutputTokens = next;
			});
			return;
		case "budget.concurrency": {
			if (value === "auto") {
				settings.fleet.concurrency = "auto";
				return;
			}
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) settings.fleet.concurrency = next;
			});
			return;
		}
		case "compaction.auto":
			if (value === "true" || value === "false") settings.context.compaction.auto = value === "true";
			return;
		case "compaction.threshold": {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) settings.context.compaction.threshold = parsed;
			return;
		}
		case "compaction.model": {
			const trimmed = value.trim();
			if (trimmed) settings.context.compaction.model = trimmed;
			else delete settings.context.compaction.model;
			return;
		}
		case "compaction.systemPrompt": {
			const trimmed = value.trim();
			if (trimmed) settings.context.compaction.systemPrompt = trimmed;
			else delete settings.context.compaction.systemPrompt;
			return;
		}
		case "retry.enabled":
			if (value === "true" || value === "false") settings.chat.retry.enabled = value === "true";
			return;
		case "retry.maxRetries":
			applyNonNegativeInteger(value, (next) => {
				settings.chat.retry.maxRetries = next;
			});
			return;
		case "retry.baseDelayMs":
			applyNonNegativeInteger(value, (next) => {
				settings.chat.retry.baseDelayMs = next;
			});
			return;
		case "retry.maxDelayMs":
			applyNonNegativeInteger(value, (next) => {
				settings.chat.retry.maxDelayMs = next;
			});
			return;
		case "terminal.showTerminalProgress":
			if (value === "true" || value === "false") settings.interface.terminalProgress = value === "true";
			return;
		case "terminal.outputVerbosity":
			if (value === "minimal" || value === "default" || value === "verbose") settings.interface.outputDetail = value;
			return;
		case "terminal.tuiMode":
			if (value === "regular" || value === "fullscreen") settings.interface.mode = value;
			return;
		case "terminal.fullscreenScrollbar":
			if (value === "hidden" || value === "auto" || value === "always") {
				settings.interface.fullscreenScrollbar = value;
			}
			return;
		case "terminal.notify":
			if (value === "true" || value === "false") settings.interface.desktopNotifications = value === "true";
			return;
		case "watchdog.enabled":
			if (value === "true" || value === "false") settings.safety.review.enabled = value === "true";
			return;
		// Both watchdog options are absent-by-default, and an empty submission is
		// how the operator says "go back to the default" from a text row. Deleting
		// the key rather than storing a blank keeps settings.yaml matching what the
		// config validator accepts.
		case "watchdog.target": {
			const trimmed = value.trim();
			if (trimmed) settings.safety.review.target = trimmed;
			else delete settings.safety.review.target;
			return;
		}
		case "watchdog.cadenceToolCalls":
			applyNumberSetting("watchdog.cadenceToolCalls", value, (next) => {
				if (next === null) delete settings.safety.review.cadenceToolCalls;
				else settings.safety.review.cadenceToolCalls = next;
			});
			return;
		case "terminal.smoothStreaming":
			if (value === "off" || value === "auto" || value === "on") settings.interface.smoothStreaming = value;
			return;
		case "runtimePlugins":
			settings.integrations.runtimePlugins = value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
			return;
		case "delegation.defaults.connectTimeoutMs":
			applyNumberSetting("delegation.defaults.connectTimeoutMs", value, (next) => {
				if (next !== null) settings.integrations.externalAgents.defaults.connectTimeoutMs = next;
			});
			return;
		case "delegation.defaults.turnTimeoutMs":
			applyNumberSetting("delegation.defaults.turnTimeoutMs", value, (next) => {
				if (next !== null) settings.integrations.externalAgents.defaults.turnTimeoutMs = next;
			});
			return;
		case "delegation.defaults.permissionTimeoutMs":
			applyNumberSetting("delegation.defaults.permissionTimeoutMs", value, (next) => {
				if (next !== null) settings.integrations.externalAgents.defaults.permissionTimeoutMs = next;
			});
			return;
		case "orchestrator.target": {
			const target = value === "(unset)" || value === "" ? null : value;
			// Switching targets re-bases the model on the new target default.
			if (target !== settings.chat.target) {
				settings.chat.model = target ? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null) : null;
			}
			settings.chat.target = target;
			return;
		}
		case "orchestrator.model":
			settings.chat.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "background.target": {
			const target = value.startsWith("(unset") || value === "" ? null : value;
			if (target !== settings.context.memory.target) {
				settings.context.memory.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.context.memory.target = target;
			return;
		}
		case "background.model":
			settings.context.memory.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "workers.default.target": {
			const target = value === "(unset)" || value === "" ? null : value;
			if (target !== settings.fleet.default.target) {
				settings.fleet.default.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.fleet.default.target = target;
			return;
		}
		case "workers.default.model":
			settings.fleet.default.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "scope":
			settings.chat.modelPicker.cycleSet =
				parseScopedModelSelection(value) ??
				value
					.split(",")
					.map((v) => v.trim())
					.filter(Boolean);
			return;
		case "budget.sessionCeilingUsd":
			applyNumberSetting("budget.sessionCeilingUsd", value, (next) => {
				if (next !== null) settings.safety.limits.sessionCostUsd = next;
			});
			return;
		case "workers.escalation.timeoutMs":
			applyNumberSetting("workers.escalation.timeoutMs", value, (next) => {
				if (next === null) return;
				settings.fleet.permissions.escalation = {
					...(settings.fleet.permissions.escalation ?? SHIPPED_ESCALATION),
					timeoutMs: next,
				};
			});
			return;
		case "workers.escalation.fallback": {
			if (value !== "deny" && value !== "fail") return;
			settings.fleet.permissions.escalation = {
				...(settings.fleet.permissions.escalation ?? SHIPPED_ESCALATION),
				fallback: value,
			};
			return;
		}
		case "workers.resilienceCooldownMs":
			applyNumberSetting("workers.resilienceCooldownMs", value, (next) => {
				if (next !== null) settings.fleet.retry.routeCooldownMs = next;
			});
			return;
		case "routing.activeRoles": {
			const outcome = parseEnumListSetting(value, ACTIVE_ROUTING_ROLES);
			if ("values" in outcome) settings.fleet.adaptiveRouting.roles = outcome.values as ActiveRoutingRole[];
			return;
		}
		case "routing.activePostures": {
			const outcome = parseEnumListSetting(value, ACTIVE_ROUTING_POSTURES);
			if ("values" in outcome) settings.fleet.adaptiveRouting.postures = outcome.values as ActiveRoutingPosture[];
			return;
		}
		case "prewarm.enabled":
			if (value === "true" || value === "false") settings.chat.prewarm = value === "true";
			return;
		case "guardrails.turnToolCallBudget":
		case "guardrails.workerToolCallCap":
		case "guardrails.maxDispatchRuns":
		case "guardrails.readMaxBytes":
		case "guardrails.observationTurnBudgetBytes":
		case "guardrails.internalDispatchTimeoutMs":
			applyNumberSetting(id, value, (next) => {
				if (next === null) return;
				if (id === "guardrails.turnToolCallBudget") settings.safety.limits.chatToolCallsPerTurn = next;
				else if (id === "guardrails.workerToolCallCap") settings.fleet.limits.toolCallsPerRun = next;
				else if (id === "guardrails.maxDispatchRuns") settings.fleet.history.maxRuns = next;
				else if (id === "guardrails.readMaxBytes") settings.safety.limits.readBytesPerCall = next;
				else if (id === "guardrails.observationTurnBudgetBytes") settings.safety.limits.observationBytesPerTurn = next;
				else settings.fleet.limits.internalRunTimeoutMs = next;
			});
			return;
		case "context.workingSet.enabled":
			if (value === "true" || value === "false") settings.context.workingSet.enabled = value === "true";
			return;
		case "context.workingSet.policy":
			if (value === "structural-v1" || value === "age-horizon") settings.context.workingSet.policy = value;
			return;
		case "context.workingSet.target": {
			// The validator's bound is exclusive at both ends, so an eviction target
			// of 0 or 1 is refused here rather than written and rejected at boot.
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) settings.context.workingSet.target = parsed;
			return;
		}
		case "context.workingSet.protectLastTurns":
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) settings.context.workingSet.protectLastTurns = next;
			});
			return;
		case "context.workingSet.minEvictableTokens":
			applyNonNegativeInteger(value, (next) => {
				settings.context.workingSet.minEvictableTokens = next;
			});
			return;
		case "retry.streamStallMs":
			applyNonNegativeInteger(value, (next) => {
				settings.chat.retry.streamStallMs = next;
			});
			return;
		case "library.catalog":
		case "library.remote": {
			const key = id.slice("library.".length) as "catalog" | "remote";
			const trimmed = value.trim();
			settings.integrations.library[key] = trimmed.length > 0 ? trimmed : null;
			return;
		}
		case "library.sync":
			if (value === "true" || value === "false") settings.integrations.library.sync = value === "true";
			return;
	}
}

/** Per-entry rows route to the same mutations the `clio-coder targets` CLI applies. */
function applyEntrySettingChange(settings: ClioSettings, id: string, value: string): boolean {
	if (id === "workers.profiles" || id === "workers.agentBindings") {
		// `name -> target` / `agent -> profile`: the encoding the chained add pickers produce.
		const [head = "", tail = ""] = value.split(" -> ").map((part) => part.trim());
		if (!head || !tail) return true;
		if (id === "workers.profiles") setFleetProfileInSettings(settings, head, tail);
		else bindAgentProfileInSettings(settings, head, tail);
		return true;
	}
	if (id.startsWith("workers.profiles.")) {
		const encoded = value.split(PROFILE_FIELD_SEPARATOR);
		const summaryName = id.slice("workers.profiles.".length);
		const legacySegments = id.split(".");
		const legacyField = legacySegments.at(-1);
		const usesLegacyField =
			!settings.fleet.profiles[summaryName] && ["target", "model", "thinkingLevel", "node"].includes(legacyField ?? "");
		const field = usesLegacyField ? legacyField : encoded.shift();
		const name = usesLegacyField ? legacySegments.slice(2, -1).join(".") : summaryName;
		const fieldValue = usesLegacyField ? value : encoded.join(PROFILE_FIELD_SEPARATOR);
		const profile = settings.fleet.profiles[name];
		if (!profile) return true;
		if (value === REMOVE_PROFILE_CHOICE) {
			removeFleetProfileFromSettings(settings, name);
		} else if (field === "target") {
			if (fieldValue !== profile.target) setFleetProfileInSettings(settings, name, fieldValue);
		} else if (field === "model") {
			profile.model = fieldValue === "(unset)" || fieldValue === "" ? null : fieldValue;
		} else if (field === "thinkingLevel") {
			profile.thinkingLevel = thinkingLevelFromChoiceLabel(fieldValue) ?? profile.thinkingLevel;
		} else if (field === "node") {
			if (fieldValue === AUTO_PLACEMENT_CHOICE || fieldValue === "") delete profile.node;
			else profile.node = fieldValue;
		}
		return true;
	}
	if (id.startsWith("workers.agentBindings.")) {
		const agentId = id.slice("workers.agentBindings.".length);
		if (value === UNBIND_CHOICE) delete settings.fleet.agentProfiles[agentId];
		else bindAgentProfileInSettings(settings, agentId, value);
		return true;
	}
	if (id.startsWith("targets.")) {
		const targetId = id.slice("targets.".length);
		if (value === "use") useTargetInSettings(settings, targetId);
		else if (value === "remove") removeTargetFromSettings(settings, targetId);
		return true;
	}
	return false;
}

/**
 * The scoped commit persists one dotted leaf per call and an entry action can
 * touch several (`use` moves chat and fleet routing; removing a profile drops
 * its bindings), so diff the blobs. Profile objects and arrays are leaves.
 */
function changedLeafPaths(before: Readonly<ClioSettings>, after: Readonly<ClioSettings>): string[] {
	const out: string[] = [];
	const isRecord = (v: unknown): v is Record<string, unknown> =>
		v !== null && typeof v === "object" && !Array.isArray(v);
	const visit = (a: unknown, b: unknown, path: string): void => {
		if (a === b) return;
		const profileLeaf = path.startsWith("fleet.profiles.") && path.split(".").length === 3;
		if (!isRecord(a) || !isRecord(b) || profileLeaf) {
			if (JSON.stringify(a) !== JSON.stringify(b)) out.push(path);
			return;
		}
		for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
			visit(a[key], b[key], path ? `${path}.${key}` : key);
		}
	};
	visit(before, after, "");
	return out;
}

type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer U)[]
		? readonly DeepReadonly<U>[]
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T;

export type SettingsPropagationTiming = "now" | "next-dispatch" | "next-session";

export interface SettingsChangePlan {
	readonly rowId: EditableSettingId;
	readonly label: string;
	readonly originalValue: string;
	readonly selectedValue: string;
	readonly original: DeepReadonly<ClioSettings>;
	readonly proposed: DeepReadonly<ClioSettings>;
	readonly leaves: readonly {
		readonly path: string;
		readonly before: unknown;
		readonly after: unknown;
	}[];
	readonly propagation: readonly {
		readonly path: string;
		readonly timing: SettingsPropagationTiming;
	}[];
	readonly impact: string;
	readonly sessionCapable: boolean;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value as DeepReadonly<T>;
}

function propagationTiming(
	id: string,
	selectedValue: string,
	path: string,
	restartRequired: boolean,
): SettingsPropagationTiming {
	if (restartRequired) return "next-session";
	if (id.startsWith("targets.")) {
		if (selectedValue === "remove") return "next-dispatch";
		return path.startsWith("chat.") ? "now" : "next-dispatch";
	}
	if (path.startsWith("fleet.")) return "next-dispatch";
	return "now";
}

function impactFor(propagation: SettingsChangePlan["propagation"]): string {
	const timings = new Set(propagation.map((entry) => entry.timing));
	if (timings.has("now") && timings.has("next-dispatch"))
		return "takes effect for chat now and fleet routing at the next dispatch";
	if (timings.has("next-session")) return "takes effect next session";
	if (timings.has("next-dispatch")) return "takes effect at the next dispatch";
	return "takes effect now";
}

function createSettingsChangePlan(
	settings: Readonly<ClioSettings>,
	item: Pick<SettingsCenterItem, "id" | "label" | "currentValue" | "scope">,
	selectedValue: string,
	sessionDestinationAvailable = true,
): SettingsChangePlan | null {
	if (item.id.startsWith("fleet.group.")) return null;
	const rowId = item.id as EditableSettingId;
	const original = structuredClone(settings);
	const proposed = structuredClone(original);
	applySettingChange(proposed, rowId, selectedValue);
	const paths = changedLeafPaths(original, proposed);
	if (paths.length === 0) return null;
	const restartRequired = item.scope === "restart";
	const sessionCapable = !restartRequired && sessionDestinationAvailable;
	const leaves = paths.map((path) => ({
		path,
		before: getAtPath(original, path),
		after: getAtPath(proposed, path),
	}));
	const propagation = paths.map((path) => ({
		path,
		timing: propagationTiming(rowId, selectedValue, path, restartRequired),
	}));
	return deepFreeze({
		rowId,
		label: item.label,
		originalValue: item.currentValue,
		selectedValue,
		original,
		proposed,
		leaves,
		propagation,
		impact: impactFor(propagation),
		sessionCapable,
	});
}

/**
 * A selection of several model references is a set, not a destination.
 * Spelling it out produced `…-coder-model, node-b/example-…`, a left-chopped ref dump
 * with the row label pushed off the front, so a multi-reference selection is
 * summarized by count and the note beneath the title carries the leaves.
 */
function scopedSelectionSummary(plan: SettingsChangePlan): string | null {
	if (plan.rowId !== "scope") return null;
	const refs = parseScopedModelSelection(plan.selectedValue);
	return refs && refs.length >= 2 ? `${refs.length} changes` : null;
}

/** Keep the destination—the value the operator is about to commit—visible as confirmation titles narrow. */
function formatScopeConfirmTitle(plan: SettingsChangePlan, width: number): string {
	const summary = scopedSelectionSummary(plan);
	if (summary !== null) {
		const title = `${plan.label}: ${summary}`;
		return visibleWidth(title) <= width ? title : ellipsizeFromLeft(title, width);
	}
	const selectedValue = humanizeChangePlanValue(plan);
	const full = plan.originalValue.trim()
		? `${plan.label}: ${plan.originalValue} → ${selectedValue}`
		: `${plan.label}: ${selectedValue}`;
	if (visibleWidth(full) <= width) return full;
	const destinationFirst = plan.originalValue.trim()
		? `${plan.label}: → ${selectedValue}`
		: `${plan.label}: ${selectedValue}`;
	if (visibleWidth(destinationFirst) <= width) return destinationFirst;
	return ellipsizeFromLeft(destinationFirst, width);
}

function humanizeChangePlanValue(plan: SettingsChangePlan): string {
	if (plan.rowId === "scope") {
		const summary = scopedSelectionSummary(plan);
		if (summary !== null) return summary;
		const refs = parseScopedModelSelection(plan.selectedValue);
		if (refs) return refs.length > 0 ? refs.join(", ") : "(empty)";
	}
	const separatorIndex = plan.selectedValue.indexOf(PROFILE_FIELD_SEPARATOR);
	if (separatorIndex < 0) return plan.selectedValue;
	const head = plan.selectedValue.slice(0, separatorIndex).trim();
	const tail = plan.selectedValue.slice(separatorIndex + PROFILE_FIELD_SEPARATOR.length).trim();
	if (plan.rowId === "workers.profiles" || plan.rowId === "workers.agentBindings") return `${head} → ${tail}`;
	if (!plan.rowId.startsWith("workers.profiles.")) return plan.selectedValue;
	const label =
		head === "thinkingLevel" ? "thinking" : head === "node" ? "placement" : head === "target" ? "target" : "model";
	return `${label} → ${tail}`;
}

function truncateProfileFact(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	if (safeWidth <= visibleWidth(ELLIPSIS)) return ELLIPSIS;
	const characters: string[] = [];
	let used = 0;
	const contentWidth = safeWidth - visibleWidth(ELLIPSIS);
	for (const character of Array.from(text)) {
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > contentWidth) break;
		characters.push(character);
		used += characterWidth;
	}
	return `${characters.join("")}${ELLIPSIS}`;
}

function ellipsizeFromLeft(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	if (visibleWidth(text) <= safeWidth) return text;
	if (safeWidth <= visibleWidth(ELLIPSIS)) return ELLIPSIS;
	const suffixWidth = safeWidth - visibleWidth(ELLIPSIS);
	const suffix: string[] = [];
	let used = 0;
	for (const character of Array.from(text).reverse()) {
		const characterWidth = visibleWidth(character);
		if (used + characterWidth > suffixWidth) break;
		suffix.unshift(character);
		used += characterWidth;
	}
	return `${ELLIPSIS}${suffix.join("")}`;
}

interface RowColumns {
	label: number;
	path: number;
}

/** When a change reaches the running system, in the vocabulary of the config-change classification. */
function propagationFor(id: string): string | null {
	if (RESTART_REQUIRED_IDS.has(id)) return "takes effect next session";
	if (id !== "targets.add-cta" && id.startsWith("targets."))
		return "use: chat now, workers at the next dispatch · remove: next dispatch";
	if (id.startsWith("workers.")) return "takes effect at the next dispatch";
	return null;
}

function fixedLines(lines: readonly string[], width: number, height: number): string[] {
	const out = lines.slice(0, height).map((line) => padAnsi(line, width, ELLIPSIS));
	while (out.length < height) out.push(" ".repeat(Math.max(0, width)));
	return out;
}

/** Typed text, as opposed to an escape sequence or a control byte. */
function isPrintableInput(data: string): boolean {
	if (data.length === 0 || data.startsWith("\u001b")) return false;
	return Array.from(data).every((character) => character >= " " && character !== "\u007f");
}

function scrollWindow(total: number, selected: number, height: number): [number, number] {
	if (height <= 0 || total <= height) return [0, total];
	const clamped = Math.max(0, Math.min(selected, total - 1));
	const start = Math.max(0, Math.min(clamped - Math.floor(height / 2), total - height));
	return [start, Math.min(total, start + height)];
}

function rowColumns(items: readonly SettingsCenterItem[], width: number, indentWidth: number): RowColumns {
	const safeWidth = Math.max(1, width);
	const prefixWidth = indentWidth + 2;
	// Drop the dotted config-path column entirely on very narrow terminals so the
	// value never gets squeezed out of view.
	if (safeWidth < DROP_PATH_COLUMN_WIDTH) {
		const available = Math.max(1, safeWidth - prefixWidth - visibleWidth(ROW_GAP));
		const label = Math.min(20, Math.max(6, Math.floor(available * 0.5)));
		return { label, path: 0 };
	}
	const available = Math.max(1, safeWidth - prefixWidth - visibleWidth(ROW_GAP) * 2);
	const labelNatural = Math.max(8, ...items.map((item) => visibleWidth(item.label)));
	const pathNatural = Math.max(10, ...items.map((item) => visibleWidth(item.configPath)));
	let label = Math.min(labelNatural, 26, Math.max(8, Math.floor(available * 0.34)));
	let path = Math.min(pathNatural, 36, Math.max(8, Math.floor(available * 0.42)));
	while (available - label - path < 8 && path > 8) path -= 1;
	while (available - label - path < 8 && label > 8) label -= 1;
	if (available - label - path < 4) {
		path = Math.max(4, available - label - 4);
	}
	return { label, path };
}

function formatSettingRow(
	item: SettingsCenterItem,
	width: number,
	selected: boolean,
	columns: RowColumns,
	indentWidth: number,
	displayValue: string,
	pending: boolean,
): string {
	const theme = clioTheme();
	const indent = " ".repeat(Math.max(0, indentWidth));
	if (item.id === "targets") return formatTargetConsoleHeader(width, indentWidth);
	if (item.targetConsole) return formatTargetConsoleRow(item, width, selected, indentWidth);
	if (item.id === "targets.add-cta") {
		const prefix = selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
		const label = theme.style("accentDeep", item.label, { bold: true });
		return truncateToWidth(
			`${indent}${prefix}${label}${ROW_GAP}${theme.fg(selected ? "accent" : "muted", item.currentValue)}`,
			width,
			ELLIPSIS,
			true,
		);
	}
	const prefix = selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
	const labelText = padAnsi(item.label, columns.label, ELLIPSIS);
	const label = selected
		? theme.style("accent", labelText, { bold: true })
		: item.presentationKind === "group-header"
			? theme.style("dim", labelText, { bold: true })
			: item.presentationKind === "action"
				? theme.style("accentDeep", labelText, { bold: true })
				: labelText;
	if (item.presentationKind === "group-header") {
		return truncateToWidth(`${indent}  ${label}`, width, ELLIPSIS, true);
	}
	const modified = !item.readOnly && item.defaultValue !== undefined && item.currentValue !== item.defaultValue;
	const marker = pending
		? theme.fg("accent", `${GLYPH.scoped} `)
		: modified
			? theme.fg("accent", `${GLYPH.scoped} `)
			: "  ";
	let used = visibleWidth(indent) + 2 + columns.label + visibleWidth(ROW_GAP);
	let pathSegment = "";
	// Status rows need enough room for both their role/fact and their semantic
	// health text. At the ultrawide center-column floor, the dotted config path
	// is the expendable metadata; keeping it would collapse `chat+fleet` to
	// `cha…` beside an otherwise readable health state.
	if (columns.path > 0 && !(item.presentationKind === "status" && width < 64)) {
		pathSegment = `${theme.fg("dim", padAnsi(item.configPath, columns.path, ELLIPSIS))}${ROW_GAP}`;
		used += columns.path + visibleWidth(ROW_GAP);
	}
	const valueWidth = Math.max(1, width - used - 2);
	const valueSegments = pending
		? [{ text: displayValue, tone: "neutral" as const }]
		: item.presentationKind === "read-only-fact"
			? [{ text: "— ", tone: "neutral" as const }, ...item.valueSegments]
			: item.valueSegments;
	const value = renderSettingValue(valueSegments, valueWidth, selected, item.readOnly);
	return truncateToWidth(`${indent}${prefix}${label}${ROW_GAP}${pathSegment}${marker}${value}`, width, ELLIPSIS, true);
}

function targetConsoleColumns(
	width: number,
): Array<{ key: "health" | "id" | "roles" | "runtime" | "latency"; width: number }> {
	const safeWidth = Math.max(1, width);
	if (safeWidth < 34) {
		const health = Math.min(11, Math.max(6, Math.floor(safeWidth * 0.42)));
		return [
			{ key: "health", width: health },
			{ key: "id", width: Math.max(1, safeWidth - health - 2) },
		];
	}
	if (safeWidth < 47) {
		const latency = 7;
		const health = 10;
		return [
			{ key: "health", width: health },
			{ key: "id", width: Math.max(6, safeWidth - health - latency - 4) },
			{ key: "latency", width: latency },
		];
	}
	if (safeWidth < 56) {
		const gaps = 6;
		const health = 12;
		const latency = 7;
		const roles = 6;
		return [
			{ key: "health", width: health },
			{ key: "id", width: safeWidth - gaps - health - latency - roles },
			{ key: "roles", width: roles },
			{ key: "latency", width: latency },
		];
	}
	const gaps = 8;
	const cells = safeWidth - gaps;
	const health = 12;
	const latency = 7;
	const extra = cells - 48;
	const roles = Math.min(13, 6 + Math.floor(extra * 0.25));
	const id = Math.min(18, 8 + Math.floor(extra * 0.5));
	return [
		{ key: "health", width: health },
		{ key: "id", width: id },
		{ key: "roles", width: roles },
		{ key: "runtime", width: cells - health - latency - roles - id },
		{ key: "latency", width: latency },
	];
}

function formatTargetConsoleHeader(width: number, indentWidth: number): string {
	const theme = clioTheme();
	const indent = " ".repeat(Math.max(0, indentWidth));
	const available = Math.max(1, width - visibleWidth(indent) - 2);
	const labels = { health: "HEALTH", id: "TARGET", roles: "ROLES", runtime: "RUNTIME", latency: "LATENCY" } as const;
	const cells = targetConsoleColumns(available).map((column) => padAnsi(labels[column.key], column.width, ELLIPSIS));
	return truncateToWidth(`${indent}  ${theme.style("dim", cells.join(ROW_GAP), { bold: true })}`, width, ELLIPSIS, true);
}

function formatTargetConsoleRow(
	item: SettingsCenterItem,
	width: number,
	selected: boolean,
	indentWidth: number,
): string {
	const console = item.targetConsole;
	if (!console) return "";
	const theme = clioTheme();
	const indent = " ".repeat(Math.max(0, indentWidth));
	const prefix = selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
	const available = Math.max(1, width - visibleWidth(indent) - 2);
	const cells = targetConsoleColumns(available).map((column) => {
		const text = column.key === "health" ? console.health.text : console[column.key];
		const padded = padAnsi(text, column.width, ELLIPSIS);
		if (column.key === "health")
			return renderSettingValue([{ ...console.health, text: padded }], column.width, selected, false);
		if (column.key === "id" && selected) return theme.style("accent", padded, { bold: true });
		return theme.fg(selected ? "accent" : "muted", padded);
	});
	return truncateToWidth(`${indent}${prefix}${cells.join(ROW_GAP)}`, width, ELLIPSIS, true);
}

function renderSettingValue(
	segments: readonly SettingsValueSegment[],
	width: number,
	selected: boolean,
	readOnly: boolean,
): string {
	const theme = clioTheme();
	let semantic: SettingsValueSegment | null = null;
	for (let index = segments.length - 1; index >= 0; index -= 1) {
		const candidate = segments[index];
		if (candidate && candidate.tone !== "neutral") {
			semantic = candidate;
			break;
		}
	}
	let visible = segments;
	if (semantic && visibleWidth(segments.map((segment) => segment.text).join("")) > width) {
		const semanticWidth = Math.min(width, visibleWidth(semantic.text));
		const prefixWidth = Math.max(0, width - semanticWidth);
		const prefix = segments
			.slice(0, segments.indexOf(semantic))
			.map((segment) => segment.text)
			.join("")
			.replace(/ · $/, "·");
		visible = [
			...(prefixWidth > 0
				? [
						{
							text: visibleWidth(prefix) <= prefixWidth ? prefix : truncateToWidth(prefix, prefixWidth, ELLIPSIS, true),
							tone: "neutral" as const,
						},
					]
				: []),
			{
				...semantic,
				text: truncateToWidth(semantic.text, semanticWidth, ELLIPSIS, true),
			},
		];
	}
	let remaining = width;
	const rendered: string[] = [];
	for (const segment of visible) {
		if (remaining <= 0) break;
		const text = truncateToWidth(segment.text, remaining, ELLIPSIS);
		remaining -= visibleWidth(text);
		const token =
			segment.tone === "healthy"
				? "success"
				: segment.tone === "degraded"
					? "warning"
					: segment.tone === "unhealthy"
						? "error"
						: segment.tone === "activity"
							? "action"
							: segment.tone === "unknown"
								? "dim"
								: readOnly
									? "dim"
									: selected
										? "accent"
										: "muted";
		rendered.push(theme.fg(token, text));
	}
	return rendered.join("");
}

export interface SettingsCenterOptions {
	getBodyHeight: () => number;
	prepareChange: (item: SettingsCenterItem, newValue: string) => SettingsChangePlan | null;
	onApply: (plan: SettingsChangePlan, scope: "session" | "global") => void;
	onCancel: () => void;
	requestRender?: () => void;
}

export class SettingsCenter implements Component {
	/** The stack level that owns input; "detail" is implied by an open submenu. */
	private level: SettingsCenterLane = "rows";
	private selectedSectionId: SettingsSectionId = SETTINGS_SECTIONS[0].id;
	private readonly rowIndexBySection = new Map<SettingsSectionId, number>();
	/** Semantic anchors survive rows being inserted, removed, or reordered during refresh. */
	private readonly rowIdBySection = new Map<SettingsSectionId, SettingsCenterRowId>();
	private submenuComponent: Component | null = null;
	/** Committed catalog filter; empty means unfiltered. */
	private filterQuery = "";
	/**
	 * Draft while the filter editor owns input; null when it is closed. The
	 * draft narrows the catalog live per keystroke, matching /model and /resume;
	 * Enter commits it and Esc restores the committed query.
	 */
	private filterDraft: string | null = null;
	/** Local cycle preview for the selected row; committed on Enter. */
	private pendingValue: string | null = null;

	constructor(
		private readonly items: SettingsCenterItem[],
		private readonly options: SettingsCenterOptions,
	) {}

	getSelection(): SettingsCenterSelection {
		const section = this.currentSection();
		const rowIndex = section ? this.rowIndex(section.id) : 0;
		const row = section?.items[rowIndex] ?? null;
		return {
			lane: this.level,
			depth: this.depth(),
			section: section?.id ?? this.selectedSectionId,
			rowIndex,
			rowId: row?.id ?? null,
			submenuOpen: this.submenuComponent !== null,
			filter: this.filterQuery,
		};
	}

	setSelection(sectionId: SettingsSectionId, rowIndex: number, lane: SettingsCenterLane = "rows"): void {
		if (this.sections().some((section) => section.id === sectionId)) this.selectedSectionId = sectionId;
		const section = this.currentSection();
		if (section) this.setRowIndex(section, this.selectableRowIndex(section, rowIndex));
		this.level = lane;
		this.submenuComponent = null;
		this.pendingValue = null;
	}

	refreshItems(): void {
		this.normalizeSelection();
	}

	render(width: number): string[] {
		const bodyHeight = Math.max(1, this.options.getBodyHeight());
		this.normalizeSelection();
		const lines =
			width < WIDE_LAYOUT_MIN_WIDTH
				? this.renderNarrow(width, bodyHeight)
				: width >= ULTRAWIDE_LAYOUT_MIN_WIDTH
					? this.renderUltraWide(width, bodyHeight)
					: this.renderWide(width, bodyHeight);
		return fixedLines(lines, width, bodyHeight);
	}

	/**
	 * Settings is component-owned for Esc: the application router forwards it
	 * here instead of closing the overlay, so one press moves up exactly one
	 * level. Every physical encoding (raw, Kitty CSI-u, modifyOtherKeys) is
	 * recognized before any delegation, which is what lets the parent pop a
	 * submenu whose own cancel binding has been customized. Key releases are not
	 * presses and do nothing.
	 */
	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (matchesKey(data, "escape")) {
			this.back();
			return;
		}
		if (this.filterDraft !== null) {
			this.handleFilterKey(data);
			return;
		}
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}
		const kb = getKeybindings();
		if (data === "/") {
			this.filterDraft = this.filterQuery;
			return;
		}
		if (matchesKey(data, "tab")) {
			this.toggleLevel();
			return;
		}
		if (matchesKey(data, "left")) {
			this.level = "sections";
			this.pendingValue = null;
			return;
		}
		if (matchesKey(data, "right")) {
			this.level = "rows";
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down") || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (data === " " && this.level === "rows") {
			this.cyclePreview();
			return;
		}
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			if (this.level === "sections") {
				this.level = "rows";
				return;
			}
			this.activateSelectedItem();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) this.back();
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	/**
	 * One level up, at every width: cancel the filter editor, then the open
	 * submenu, then the rows page, and only from the section list does Esc close
	 * Settings. A pending Space preview is part of the row context, so leaving
	 * rows discards it rather than costing an extra press.
	 */
	private back(): void {
		if (this.filterDraft !== null) {
			this.filterDraft = null;
			this.options.requestRender?.();
			return;
		}
		if (this.submenuComponent) {
			this.submenuComponent = null;
			this.pendingValue = null;
			this.options.requestRender?.();
			return;
		}
		if (this.level === "rows" && this.sections().length > 0) {
			this.level = "sections";
			this.pendingValue = null;
			this.options.requestRender?.();
			return;
		}
		this.options.onCancel();
	}

	private depth(): SettingsNavigationDepth {
		return this.submenuComponent ? "detail" : this.level;
	}

	private handleFilterKey(data: string): void {
		const draft = this.filterDraft ?? "";
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
			this.filterQuery = draft.trim();
			this.filterDraft = null;
			this.normalizeSelection();
			this.options.requestRender?.();
			return;
		}
		if (data === "\x7f" || data === "\b") {
			this.filterDraft = draft.slice(0, -1);
			this.normalizeSelection();
			this.options.requestRender?.();
			return;
		}
		if (isPrintableInput(data)) {
			this.filterDraft = draft + data;
			this.normalizeSelection();
			this.options.requestRender?.();
		}
	}

	/** The query the catalog is narrowed by right now: the live draft while the
	 * filter editor is open, the committed query otherwise. */
	private effectiveFilterQuery(): string {
		return (this.filterDraft ?? this.filterQuery).trim();
	}

	private matchesFilter(item: SettingsCenterItem): boolean {
		const query = this.effectiveFilterQuery().toLowerCase();
		if (query.length === 0) return true;
		return (
			item.label.toLowerCase().includes(query) ||
			item.configPath.toLowerCase().includes(query) ||
			item.description.toLowerCase().includes(query)
		);
	}

	/**
	 * The catalog the operator can currently reach. Group headers survive only as
	 * context for a matching row beneath them, never as results or stops, and a
	 * section with no matching row disappears from the list entirely.
	 */
	private sections(): SettingsCenterSection[] {
		const all = buildSettingsSections(this.items);
		if (this.effectiveFilterQuery().length === 0) return all;
		return all
			.map((section) => ({ ...section, items: this.filterSectionItems(section.items) }))
			.filter((section) => section.items.some((item) => this.isSelectableRow(item)));
	}

	private filterSectionItems(items: readonly SettingsCenterItem[]): SettingsCenterItem[] {
		const kept: SettingsCenterItem[] = [];
		let pendingHeader: SettingsCenterItem | null = null;
		for (const item of items) {
			if (!this.isSelectableRow(item)) {
				pendingHeader = item;
				continue;
			}
			if (!this.matchesFilter(item)) continue;
			if (pendingHeader) {
				kept.push(pendingHeader);
				pendingHeader = null;
			}
			kept.push(item);
		}
		return kept;
	}

	private currentSection(): SettingsCenterSection | null {
		const sections = this.sections();
		return sections.find((section) => section.id === this.selectedSectionId) ?? sections[0] ?? null;
	}

	private rowIndex(sectionId: SettingsSectionId): number {
		const section = this.sections().find((entry) => entry.id === sectionId);
		if (!section) return 0;
		const rowId = this.rowIdBySection.get(sectionId);
		const identityIndex = rowId ? section.items.findIndex((item) => item.id === rowId) : -1;
		if (identityIndex >= 0 && this.isSelectableRow(section.items[identityIndex])) return identityIndex;
		return this.selectableRowIndex(section, this.rowIndexBySection.get(sectionId) ?? 0);
	}

	private isSelectableRow(item: SettingsCenterItem | undefined): boolean {
		return item !== undefined && item.presentationKind !== "group-header";
	}

	private selectableRowIndex(section: SettingsCenterSection, rowIndex: number): number {
		if (section.items.length === 0) return 0;
		const clamped = Math.max(0, Math.min(rowIndex, section.items.length - 1));
		if (this.isSelectableRow(section.items[clamped])) return clamped;
		for (let distance = 1; distance < section.items.length; distance += 1) {
			const after = clamped + distance;
			if (this.isSelectableRow(section.items[after])) return after;
			const before = clamped - distance;
			if (this.isSelectableRow(section.items[before])) return before;
		}
		return 0;
	}

	private setRowIndex(section: SettingsCenterSection, rowIndex: number): void {
		const next = this.selectableRowIndex(section, rowIndex);
		this.rowIndexBySection.set(section.id, next);
		const item = section.items[next];
		if (item && this.isSelectableRow(item)) this.rowIdBySection.set(section.id, item.id);
	}

	private normalizeSelection(): void {
		const sections = this.sections();
		// A committed filter that hides everything leaves nowhere to drill into, so
		// the stack sits at its top level and one Esc closes Settings from the
		// empty state. A live draft narrows per keystroke and may pass through the
		// empty state on its way to a match, so it must not disturb the level:
		// Esc's first press cancels the draft and lands back where editing began.
		if (sections.length === 0) {
			if (this.filterDraft === null) this.level = "sections";
			return;
		}
		if (!sections.some((section) => section.id === this.selectedSectionId)) {
			this.selectedSectionId = sections[0]?.id ?? this.selectedSectionId;
		}
		for (const section of sections) {
			this.setRowIndex(section, this.rowIndex(section.id));
		}
	}

	private selectedItem(): SettingsCenterItem | null {
		const section = this.currentSection();
		if (!section) return null;
		return section.items[this.rowIndex(section.id)] ?? null;
	}

	private toggleLevel(): void {
		this.level = this.level === "sections" ? "rows" : "sections";
		this.pendingValue = null;
	}

	private moveSelection(delta: -1 | 1): void {
		this.pendingValue = null;
		if (this.level === "sections") {
			this.moveSection(delta);
			return;
		}
		// Rows are the section's own rows at every width. Flattening the catalog
		// on narrow terminals meant an operator scrolling Retry fell into Terminal
		// with nothing in the frame saying they had left the section they opened.
		const section = this.currentSection();
		if (!section) return;
		const selectable = section.items
			.map((item, index) => (this.isSelectableRow(item) ? index : -1))
			.filter((index) => index >= 0);
		if (selectable.length === 0) return;
		const current = selectable.indexOf(this.rowIndex(section.id));
		const next = selectable[(Math.max(0, current) + delta + selectable.length) % selectable.length];
		if (next !== undefined) this.setRowIndex(section, next);
	}

	private moveSection(delta: -1 | 1): void {
		const sections = this.sections();
		if (sections.length === 0) return;
		const current = Math.max(
			0,
			sections.findIndex((section) => section.id === this.selectedSectionId),
		);
		const next = sections[(current + delta + sections.length) % sections.length];
		if (next) this.selectedSectionId = next.id;
		this.normalizeSelection();
	}

	/** Space cycles a local preview of an enum/bool row without committing. */
	private cyclePreview(): void {
		const item = this.selectedItem();
		if (!item || item.readOnly || !item.values || item.values.length === 0) return;
		const base = this.pendingValue ?? item.currentValue;
		const currentIndex = item.values.indexOf(base);
		const nextIndex = (currentIndex + 1) % item.values.length;
		this.pendingValue = item.values[nextIndex] ?? base;
	}

	private activateSelectedItem(): void {
		const item = this.selectedItem();
		if (!item || item.readOnly) return;
		if (item.submenu) {
			this.submenuComponent = item.submenu(item.editValue ?? item.currentValue, (selectedValue) => {
				this.submenuComponent = null;
				if (selectedValue !== undefined) this.prepareScopeConfirm(item, selectedValue);
				this.options.requestRender?.();
			});
			return;
		}
		if (item.values && item.values.length > 0) {
			const selectedValue = this.pendingValue ?? item.currentValue;
			const choices = item.values.map((value) => ({ value, label: value }));
			const list = new SettingsSelectList(choices, Math.min(10, choices.length), DEFAULT_SELECT_THEME);
			list.setSelectedIndex(Math.max(0, item.values.indexOf(selectedValue)));
			list.onSelect = (choice) => this.prepareScopeConfirm(item, choice.value);
			list.onCancel = () => {
				this.submenuComponent = null;
				this.options.requestRender?.();
			};
			this.submenuComponent = new SubmenuWrapper(
				`Select ${item.label}`,
				list,
				buildHint([{ key: "Enter", verb: "choose" }], "back"),
			);
		}
	}

	private prepareScopeConfirm(item: SettingsCenterItem, value: string): void {
		const plan = this.options.prepareChange(item, value);
		if (!plan) {
			this.submenuComponent = null;
			this.pendingValue = null;
			this.options.requestRender?.();
			return;
		}
		this.openScopeConfirm(plan);
	}

	/** Hold one immutable plan while the operator chooses its destination. */
	private openScopeConfirm(plan: SettingsChangePlan): void {
		const options = plan.sessionCapable
			? [
					{ value: "session", label: "Apply this session" },
					{ value: "global", label: "Apply and save globally" },
					{ value: "cancel", label: "Cancel" },
				]
			: [
					{ value: "global", label: "Apply and save globally" },
					{ value: "cancel", label: "Cancel" },
				];
		const list = new SettingsSelectList(options, options.length, DEFAULT_SELECT_THEME);
		const finish = (chosen: "session" | "global" | "cancel"): void => {
			if (chosen === "session" || chosen === "global") this.options.onApply(plan, chosen);
			this.submenuComponent = null;
			this.pendingValue = null;
			this.options.requestRender?.();
		};
		list.onSelect = (opt) => finish(opt.value as "session" | "global" | "cancel");
		list.onCancel = () => finish("cancel");
		const title = (width: number): string => formatScopeConfirmTitle(plan, width);
		const affectedBindings = plan.leaves
			.filter((leaf) => leaf.path.startsWith("fleet.agentProfiles."))
			.map((leaf) => leaf.path.slice("fleet.agentProfiles.".length));
		const bindingPreflight =
			plan.selectedValue === REMOVE_PROFILE_CHOICE
				? `Affected agent routes: ${affectedBindings.length > 0 ? affectedBindings.join(", ") : "none"} · `
				: "";
		const targetRemovalPreflight = (() => {
			if (!plan.rowId.startsWith("targets.") || plan.selectedValue !== "remove") return "";
			const paths = (prefix: string): string[] =>
				plan.leaves.filter((leaf) => leaf.path.startsWith(prefix)).map((leaf) => leaf.path);
			const profiles = paths("fleet.profiles.").map((path) => path.slice("fleet.profiles.".length));
			const describe = (label: string, affected: readonly string[]): string =>
				`Affected ${label}: ${affected.length > 0 ? affected.join(", ") : "none"}`;
			return `${describe("chat route", paths("chat."))} · ${describe("fleet route", paths("fleet.default."))} · ${describe("memory route", paths("context.memory."))} · ${describe("profiles", profiles)} · `;
		})();
		const note = `${bindingPreflight}${targetRemovalPreflight}Affects ${plan.leaves.map((leaf) => leaf.path).join(", ")} · ${plan.impact}`;
		this.submenuComponent = new SubmenuWrapper(title, list, buildHint([{ key: "Enter", verb: "choose" }], "back"), note);
	}

	private displayValueFor(item: SettingsCenterItem, selected: boolean): { value: string; pending: boolean } {
		if (selected && this.pendingValue !== null && this.pendingValue !== item.currentValue) {
			return { value: this.pendingValue, pending: true };
		}
		return { value: item.currentValue, pending: false };
	}

	/**
	 * Section 2.6's ultrawide row: categories left, settings center, and the live
	 * description as its own right column.
	 *
	 * Below this width the description is a footer under both lanes, which is the
	 * only place it fits. At 120 columns that footer was spending five or six rows
	 * of height on prose while 40-odd columns sat empty to the right of the
	 * settings rows, so the panel scrolled a list it had the room to show. The
	 * description lane is a readout, not a third focus target: Tab still moves
	 * between sections and rows.
	 */
	private renderUltraWide(width: number, bodyHeight: number): string[] {
		const head = this.filterEditorLines(width);
		const bodyRows = Math.max(1, bodyHeight - head.length);
		if (this.sections().length === 0) return [...head, ...this.emptyFilterLines(width, bodyRows)];
		const theme = clioTheme();
		const separator = barSep(theme);
		const separatorWidth = visibleWidth(" │ ");
		const leftWidth = Math.min(SECTION_LANE_WIDTH, Math.max(16, Math.floor(width * 0.28)));
		const left = this.renderSectionLane(leftWidth, bodyRows);
		// A detail page owns the work area: the description column would be a second
		// readout beside a submenu that already carries its own title and note.
		if (this.submenuComponent) {
			const workWidth = Math.max(1, width - leftWidth - separatorWidth);
			const work = this.renderRightLane(workWidth, bodyRows);
			return [
				...head,
				...Array.from(
					{ length: bodyRows },
					(_, index) =>
						`${padAnsi(left[index] ?? "", leftWidth, ELLIPSIS)}${separator}${padAnsi(work[index] ?? "", workWidth, ELLIPSIS)}`,
				),
			];
		}
		const detailWidth = Math.max(28, Math.min(44, Math.floor(width * 0.3)));
		const centerWidth = Math.max(1, width - leftWidth - detailWidth - separatorWidth * 2);
		const center = this.renderRightLane(centerWidth, bodyRows);
		const right = this.renderDetailLane(detailWidth, bodyRows);
		return [
			...head,
			...Array.from({ length: bodyRows }, (_, index) =>
				[
					padAnsi(left[index] ?? "", leftWidth, ELLIPSIS),
					padAnsi(center[index] ?? "", centerWidth, ELLIPSIS),
					padAnsi(right[index] ?? "", detailWidth, ELLIPSIS),
				].join(separator),
			),
		];
	}

	/** The one-line filter editor, shown at every width while it owns input. */
	private filterEditorLines(width: number): string[] {
		if (this.filterDraft === null) return [];
		const theme = clioTheme();
		return [truncateToWidth(theme.fg("accent", `Filter settings: ${this.filterDraft}_`), width, ELLIPSIS, true)];
	}

	private emptyFilterLines(width: number, height: number): string[] {
		const theme = clioTheme();
		return fixedLines(
			[
				theme.fg("muted", truncateToWidth(`No settings match “${this.effectiveFilterQuery()}”`, width, ELLIPSIS, true)),
				theme.fg("dim", truncateToWidth("/ edit filter · empty Enter clears", width, ELLIPSIS, true)),
			],
			width,
			height,
		);
	}

	/**
	 * The right column: what the selected row is, what it means, and where a
	 * change to it lands. Same content the footer carries below 120 columns,
	 * wrapped to a narrow column instead of a wide strip, with the scope note
	 * pinned to the bottom so it survives a long explanation.
	 */
	private renderDetailLane(width: number, height: number): string[] {
		const theme = clioTheme();
		const section = this.currentSection();
		const item = this.selectedItem();
		if (!section) return fixedLines([], width, height);
		if (this.level === "sections" || !item) {
			const rows = [
				screenTitle(theme, section.label),
				"",
				...wrapTextWithAnsi(theme.fg("muted", SETTINGS_SECTION_DESCRIPTIONS[section.id]), width),
				"",
				theme.fg("dim", "Tab or → to edit its settings"),
			];
			return fixedLines(rows, width, height);
		}
		const body: string[] = [
			screenTitle(theme, item.label),
			"",
			...wrapTextWithAnsi(theme.fg("muted", item.description), width),
		];
		if (item.help) body.push("", ...wrapTextWithAnsi(theme.fg("dim", item.help), width));
		const detail = this.footerDetail(item, theme);
		if (detail) body.push("", ...wrapTextWithAnsi(detail, width));
		const note = wrapTextWithAnsi(theme.fg("dim", this.footerScopeNote(item)), width);
		// The note is the answer to "where does this land", so it keeps its rows
		// and the explanation above it is what gets cut, with a marker.
		const bodyBudget = Math.max(0, height - note.length - 1);
		const kept = body.slice(0, bodyBudget);
		// A cut that lands on one of the blank spacer rows would otherwise mark it,
		// leaving a lone `…` under the last full sentence. The marker belongs on the
		// last line that actually carries text.
		while (kept.length > 0 && (kept.at(-1) ?? "").trim().length === 0) kept.pop();
		const last = kept.at(-1);
		const marked = body.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${ELLIPSIS}`] : kept;
		const filler = Array.from({ length: Math.max(0, height - marked.length - note.length) }, () => "");
		return fixedLines([...marked, ...filler, ...note], width, height);
	}

	private renderWide(width: number, bodyHeight: number): string[] {
		const head = this.filterEditorLines(width);
		const available = Math.max(1, bodyHeight - head.length);
		if (this.sections().length === 0) return [...head, ...this.emptyFilterLines(width, available)];
		// A detail page owns the work area, and the footer describes the row the
		// operator has already left, so it is suppressed while a submenu is open.
		const footer = this.submenuComponent ? [] : this.renderFooter(width, this.footerBudget(available));
		const contentHeight = Math.max(1, available - footer.length);
		const leftWidth = Math.min(SECTION_LANE_WIDTH, Math.max(16, Math.floor(width * 0.28)));
		const separator = barSep(clioTheme());
		const separatorWidth = visibleWidth(" │ ");
		const rightWidth = Math.max(1, width - leftWidth - separatorWidth);
		const left = this.renderSectionLane(leftWidth, contentHeight);
		const right = this.renderRightLane(rightWidth, contentHeight);
		const body = Array.from(
			{ length: contentHeight },
			(_, index) =>
				`${padAnsi(left[index] ?? "", leftWidth, ELLIPSIS)}${separator}${padAnsi(right[index] ?? "", rightWidth, ELLIPSIS)}`,
		);
		return [...head, ...body, ...footer];
	}

	/**
	 * The footer is the selected setting's detail surface at two-lane widths, so
	 * it may use every row the list does not need. A fixed four-line ceiling left
	 * a dozen blank body rows at an 80-column terminal while cutting the autonomy
	 * explanation after its first sentence. Keeping six list rows makes the full
	 * prose reachable when height is available and still degrades to no footer on
	 * a short terminal.
	 */
	private footerBudget(bodyHeight: number): number {
		return Math.max(0, bodyHeight - 6);
	}

	private renderSectionLane(width: number, height: number): string[] {
		const theme = clioTheme();
		const rows = [{ line: theme.fg("dim", "Sections"), sectionId: null as SettingsSectionId | null }];
		rows.push(...this.sectionCatalogRows());
		const selectedLine = Math.max(
			0,
			rows.findIndex((row) => row.sectionId === this.selectedSectionId),
		);
		const [start, end] = scrollWindow(rows.length, selectedLine, height);
		return fixedLines(
			rows.slice(start, end).map((row) => row.line),
			width,
			height,
		);
	}

	/**
	 * The section catalog, shared by the wide lane and the narrow sections page.
	 * Group tags stay visual separators: they carry no cursor and are never a stop.
	 */
	private sectionCatalogRows(): Array<{ line: string; sectionId: SettingsSectionId | null }> {
		const theme = clioTheme();
		const filtering = this.effectiveFilterQuery().length > 0;
		const rows: Array<{ line: string; sectionId: SettingsSectionId | null }> = [];
		let previousGroup: string | null = null;
		for (const section of this.sections()) {
			const group = SETTINGS_SECTIONS.find((entry) => entry.id === section.id)?.group;
			if (group && group !== previousGroup) {
				rows.push({ line: theme.style("accentDeep", group, { bold: true }), sectionId: null });
				previousGroup = group;
			}
			const selected = section.id === this.selectedSectionId;
			const cursor = selected && this.level === "sections" ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
			const matchCount = section.items.filter((item) => this.isSelectableRow(item)).length;
			const modifiedCount = section.items.filter(
				(item) => !item.readOnly && item.defaultValue !== undefined && item.currentValue !== item.defaultValue,
			).length;
			const badge = filtering
				? theme.fg("accent", ` ${matchCount}`)
				: modifiedCount > 0
					? theme.fg("accent", ` ${GLYPH.scoped}${modifiedCount}`)
					: "";
			const label = selected ? theme.style("accent", section.label, { bold: true }) : section.label;
			rows.push({ line: `${cursor}${label}${badge}`, sectionId: section.id });
		}
		return rows;
	}

	private renderRightLane(width: number, height: number): string[] {
		if (this.submenuComponent) {
			const lines = this.submenuComponent.render(width);
			return fixedLines(lines, width, height);
		}
		const theme = clioTheme();
		const section = this.currentSection();
		if (!section) return fixedLines([], width, height);
		const rowBudget = Math.max(0, height - 1);
		const selected = this.rowIndex(section.id);
		const [start, end] = scrollWindow(section.items.length, selected, rowBudget);
		const columns = rowColumns(section.items, width, 0);
		const rows = section.items.slice(start, end).map((item, offset) => {
			const isSelected = start + offset === selected && this.level === "rows";
			const display = this.displayValueFor(item, isSelected);
			return formatSettingRow(item, width, isSelected, columns, 0, display.value, display.pending);
		});
		return fixedLines([screenTitle(theme, section.label), ...rows], width, height);
	}

	/**
	 * The narrow stack: one page at a time under a breadcrumb. The flattened
	 * catalog it replaces rendered every section and every row into one scroll,
	 * so a 40-column terminal showed six sections' worth of context and no way to
	 * tell which one owned the cursor.
	 */
	private renderNarrow(width: number, bodyHeight: number): string[] {
		const head = [this.breadcrumbLine(width), ...this.filterEditorLines(width)];
		const available = Math.max(1, bodyHeight - head.length);
		if (this.sections().length === 0) return [...head, ...this.emptyFilterLines(width, available)];
		if (this.submenuComponent) {
			return [...head, ...fixedLines(this.submenuComponent.render(width), width, available)];
		}
		const inspector = this.narrowInspector(width, bodyHeight);
		const listHeight = Math.max(1, available - inspector.length);
		const list =
			this.level === "sections" ? this.renderSectionsPage(width, listHeight) : this.renderRowsPage(width, listHeight);
		return [...head, ...list, ...inspector];
	}

	private breadcrumbLine(width: number): string {
		const theme = clioTheme();
		const section = this.currentSection();
		const trail: string[] = ["Settings"];
		if (this.level === "sections" && !this.submenuComponent) trail.push("Sections");
		else if (section) trail.push(section.label);
		if (this.submenuComponent) {
			const item = this.selectedItem();
			if (item) trail.push(item.label);
		}
		const query = this.filterQuery.trim().length > 0 ? theme.fg("accent", `  /${this.filterQuery}`) : "";
		return truncateToWidth(`${screenTitle(theme, trail.join(" › "))}${query}`, width, ELLIPSIS, true);
	}

	/**
	 * Prose is the first thing a short terminal can spare. Sixteen body rows keep
	 * two inspector rows, ten keep one, and anything shorter gives every row to
	 * the list; the description stays reachable at wider widths and through the
	 * filter.
	 */
	private narrowInspector(width: number, bodyHeight: number): string[] {
		const budget = bodyHeight >= 16 ? 2 : bodyHeight >= 10 ? 1 : 0;
		if (budget === 0) return [];
		const theme = clioTheme();
		const section = this.currentSection();
		if (!section) return [];
		const item = this.level === "rows" ? this.selectedItem() : null;
		const text = item ? item.description : SETTINGS_SECTION_DESCRIPTIONS[section.id];
		const wrapped = wrapTextWithAnsi(theme.fg("muted", text), Math.max(1, width));
		const kept = wrapped.slice(0, budget);
		const last = kept.at(-1);
		return wrapped.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${ELLIPSIS}`] : kept;
	}

	private renderSectionsPage(width: number, height: number): string[] {
		const rows = this.sectionCatalogRows();
		const selectedLine = Math.max(
			0,
			rows.findIndex((row) => row.sectionId === this.selectedSectionId),
		);
		const [start, end] = scrollWindow(rows.length, selectedLine, height);
		return fixedLines(
			rows.slice(start, end).map((row) => row.line),
			width,
			height,
		);
	}

	private renderRowsPage(width: number, height: number): string[] {
		const section = this.currentSection();
		if (!section) return fixedLines([], width, height);
		const selected = this.rowIndex(section.id);
		const [start, end] = scrollWindow(section.items.length, selected, height);
		const columns = rowColumns(section.items, width, 0);
		const rows = section.items.slice(start, end).map((item, offset) => {
			const isSelected = start + offset === selected;
			const display = this.displayValueFor(item, isSelected);
			return formatSettingRow(item, width, isSelected, columns, 0, display.value, display.pending);
		});
		return fixedLines(rows, width, height);
	}

	private renderFooter(width: number, maxFooterLines: number): string[] {
		const theme = clioTheme();
		if (maxFooterLines <= 0) return [];
		const safeWidth = Math.max(1, width);
		const separator = rule(theme, safeWidth);
		const sections = this.sections();
		const section = this.currentSection();
		const item = this.selectedItem();
		if (!section) return [];
		const position = sections.findIndex((entry) => entry.id === section.id) + 1;
		const query = this.filterQuery.trim().length > 0 ? `  ${theme.fg("accent", `/${this.filterQuery}`)}` : "";
		const positionText = `${theme.fg("dim", `section ${position}/${sections.length}`)}${query}`;

		// The note is prose the operator acts on ("choose session, global, or
		// cancel"), so it wraps under the same rule as the description above it. A
		// truncated instruction is the one line in this footer that cannot afford
		// to be a fragment.
		const noteLines = (text: string, tone: "dim" | "muted"): string[] =>
			wrapTextWithAnsi(theme.fg(tone, text), safeWidth);

		if (this.level === "sections") {
			const breadcrumb = `${screenTitle(theme, section.label)}  ${theme.fg("dim", "·")}  ${positionText}`;
			const body = wrapTextWithAnsi(theme.fg("muted", SETTINGS_SECTION_DESCRIPTIONS[section.id]), safeWidth);
			return this.assembleFooter(
				[separator, breadcrumb],
				body,
				noteLines(this.footerNoteText(), "dim"),
				maxFooterLines,
				safeWidth,
			);
		}

		if (!item) {
			return this.assembleFooter([separator], [], noteLines(this.footerNoteText(), "muted"), maxFooterLines, safeWidth);
		}

		const breadcrumb = `${screenTitle(theme, section.label)} ${theme.fg("dim", "›")} ${theme.style("accent", item.label, { bold: true })}  ${theme.fg("dim", "·")}  ${positionText}`;
		const contentLines: string[] = [];
		contentLines.push(...wrapTextWithAnsi(theme.fg("muted", item.description), safeWidth));
		if (item.help) contentLines.push(...wrapTextWithAnsi(theme.fg("dim", item.help), safeWidth));
		const detail = this.footerDetail(item, theme);
		if (detail) contentLines.push(...wrapTextWithAnsi(detail, safeWidth));
		return this.assembleFooter(
			[separator, breadcrumb],
			contentLines,
			noteLines(this.footerScopeNote(item), "dim"),
			maxFooterLines,
			safeWidth,
		);
	}

	/**
	 * The note text renderFooter will show, without theming. `footerBudget` needs
	 * its wrapped height before the footer is rendered, so both read it here and
	 * the ceiling can never disagree with what lands.
	 */
	private footerNoteText(): string {
		const section = this.currentSection();
		if (!section) return "";
		if (this.level === "sections") return "Tab or → to edit its settings";
		const item = this.selectedItem();
		if (!item) return "No setting selected.";
		return this.footerScopeNote(item);
	}

	private footerDetail(item: SettingsCenterItem, theme: ReturnType<typeof clioTheme>): string {
		const parts: string[] = [theme.fg("dim", item.affordance)];
		if (!item.readOnly && item.defaultValue !== undefined) {
			const modified = item.currentValue !== item.defaultValue;
			parts.push(
				modified
					? theme.fg("accent", `${GLYPH.scoped} changed (default: ${item.defaultValue})`)
					: theme.fg("dim", `default: ${item.defaultValue}`),
			);
		}
		const valueMeaning = item.valueHelp?.[item.currentValue];
		if (!item.readOnly && valueMeaning) parts.push(theme.fg("muted", valueMeaning));
		const propagation = propagationFor(item.id);
		if (propagation) parts.push(theme.fg("dim", propagation));
		return parts.join(theme.fg("frame", "  ·  "));
	}

	private footerScopeNote(item: SettingsCenterItem): string {
		if (item.id === "targets.add-cta") return "Run the command shown to open the accepted add wizard";
		if (item.submenu && (item.presentationKind === "status" || item.presentationKind === "action"))
			return "Enter opens actions · nothing changes until an action is confirmed";
		if (item.readOnly) return "Read-only here · managed on the surface above";
		if (item.scope === "restart") return "Saved to settings.yaml · restart Clio to apply";
		return "Enter chooses a value · then choose session, global, or cancel before anything changes";
	}

	/**
	 * Lay out the footer so the breadcrumb (top) and the scope note (bottom)
	 * always survive; the middle help fills whatever rows remain. This keeps the
	 * "where does this land" guidance visible even on short terminals.
	 */
	private assembleFooter(
		top: readonly string[],
		middle: readonly string[],
		note: readonly string[],
		maxFooterLines: number,
		width: number,
	): string[] {
		const fit = (line: string): string => truncateToWidth(line, width, ELLIPSIS, true);
		let out: string[];
		if (maxFooterLines <= top.length) {
			out = top.slice(0, maxFooterLines).map(fit);
		} else {
			// The note owns the rows it wrapped to, up to whatever is left under the
			// breadcrumb; the explanation fills the rest. Dropping a wrapped note
			// line loses less than cutting the sentence mid-word did.
			const noteKept = note.slice(0, Math.max(1, maxFooterLines - top.length));
			const middleBudget = Math.max(0, maxFooterLines - top.length - noteKept.length);
			// The explanation is wrapped, so a short terminal drops whole lines off
			// its end rather than cutting one. At 40 columns the autonomy help
			// stopped at "read-only observes; suggest" and read as the whole
			// sentence, so the last line it keeps says that it is not.
			const kept = middle.slice(0, middleBudget);
			const last = kept.at(-1);
			const marked =
				middle.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${ELLIPSIS}`] : kept;
			out = [...top.map(fit), ...marked.map(fit), ...noteKept.map(fit)];
		}
		while (out.length < maxFooterLines) out.push("");
		return out.slice(0, maxFooterLines);
	}
}

export type SettingsNoticeLevel = "info" | "success" | "warning" | "error";

export interface OpenSettingsOverlayDeps {
	getSettings: () => Readonly<ClioSettings>;
	providers?: ProvidersContract;
	writeSettings: (next: ClioSettings) => void;
	/**
	 * Scoped commit for a single edit. When present, the overlay routes session
	 * and global saves through it; when absent it falls back to writeSettings
	 * (every edit goes global, the legacy behavior).
	 */
	commitSetting?: (id: string, next: ClioSettings, scope: "session" | "global") => void;
	notice?: (level: SettingsNoticeLevel, text: string, key?: string) => void;
	onClose: () => void;
	/** Open focused on this section (deep link from `/settings <section>`). */
	section?: SettingsSectionId;
	/** Optional semantic row anchor for command deep links. */
	rowId?: SettingsCenterRowId;
	getFleetNodes?: BuildSettingItemsOptions["getFleetNodes"];
	connectTarget?: BuildSettingItemsOptions["connectTarget"];
	getInteropProposals?: BuildSettingItemsOptions["getInteropProposals"];
}

function formatSettingChangeNotice(id: string, value: string, scope: "session" | "global"): string {
	const scopedRefs = id === "scope" ? parseScopedModelSelection(value) : null;
	const displayValue = scopedRefs ? (scopedRefs.length > 0 ? scopedRefs.join(", ") : "(empty)") : value;
	return `${id} set to ${displayValue} (${scope === "global" ? "saved globally" : "this session"})`;
}

export interface SettingsOverlayHandle extends OverlayHandle {
	/**
	 * Re-derive every row from the live effective settings. Called after each
	 * committed edit and on config change events while the overlay is open, so
	 * dependent rows never go stale.
	 */
	refreshRows(): void;
}

function settingsBodyHeight(tui: TUI): number {
	return Math.max(1, tui.terminal.rows - SETTINGS_OVERLAY_MARGIN.top - SETTINGS_OVERLAY_MARGIN.bottom - 2);
}

export function openSettingsOverlay(tui: TUI, deps: OpenSettingsOverlayDeps): SettingsOverlayHandle {
	const targetOperations = new Map<string, { operation: "connect" | "probe"; token: object }>();
	const buildOptions: BuildSettingItemsOptions = {
		getSettings: deps.getSettings,
		requestRefresh: () => refreshRows(),
		getTargetOperation: (targetId) => {
			const keyboardOwningOperation = targetOperations.entries().next().value as
				| [string, { operation: "connect" | "probe"; token: object }]
				| undefined;
			return keyboardOwningOperation?.[0] === targetId ? keyboardOwningOperation[1].operation : null;
		},
		onTargetOperationChange: (targetId, operation, operationToken) => {
			if (operation) targetOperations.set(targetId, { operation, token: operationToken });
			else if (targetOperations.get(targetId)?.token === operationToken) targetOperations.delete(targetId);
		},
	};
	if (deps.providers) buildOptions.providers = deps.providers;
	if (deps.getFleetNodes) buildOptions.getFleetNodes = deps.getFleetNodes;
	if (deps.connectTarget) buildOptions.connectTarget = deps.connectTarget;
	if (deps.getInteropProposals) buildOptions.getInteropProposals = deps.getInteropProposals;
	const items = buildSettingItems(deps.getSettings(), buildOptions);
	const center = new SettingsCenter(items, {
		getBodyHeight: () => settingsBodyHeight(tui),
		prepareChange: (item, value) =>
			createSettingsChangePlan(deps.getSettings(), item, value, Boolean(deps.commitSetting)),
		onApply: (plan, scope) => {
			if (deps.commitSetting) {
				for (const leaf of plan.leaves) deps.commitSetting(leaf.path, plan.proposed as ClioSettings, scope);
			} else deps.writeSettings(plan.proposed as ClioSettings);
			deps.notice?.("success", formatSettingChangeNotice(plan.rowId, plan.selectedValue, scope), `settings:${plan.rowId}`);
			refreshRows();
		},
		onCancel: () => deps.onClose(),
		requestRender: () => tui.requestRender(),
	});
	if (deps.section) {
		const sectionItems = buildSettingsSections(items).find((section) => section.id === deps.section)?.items ?? [];
		const rowIndex = deps.rowId ? sectionItems.findIndex((item) => item.id === deps.rowId) : -1;
		center.setSelection(deps.section, rowIndex >= 0 ? rowIndex : 0);
	}
	const refreshRows = (): void => {
		refreshSettingItemsInPlace(items, buildSettingItems(deps.getSettings(), buildOptions));
		center.refreshItems();
		tui.requestRender();
	};
	const handle = showClioOverlayFrame(tui, center, {
		anchor: "top-left",
		width: SETTINGS_OVERLAY_WIDTH,
		maxHeight: SETTINGS_OVERLAY_MAX_HEIGHT,
		// A capturing overlay must own every horizontal cell. Leaving even a
		// two-column compositor margin exposes arbitrary transcript and footer
		// fragments beside the frame, where they read as modal content.
		margin: SETTINGS_OVERLAY_MARGIN,
		markerId: "settings",
		title: "Settings",
		footerHint: (innerWidth) => {
			// The submenu renders its own authoritative choose/back legend. Keeping
			// the parent row controls in the outer border at the same time advertises
			// actions (preview, open, filter) that this input depth does not route.
			if (center.getSelection().submenuOpen) return undefined;
			return innerWidth < WIDE_LAYOUT_MIN_WIDTH
				? buildHint(
						[
							{ key: "↑↓", verb: "move" },
							{ key: "Enter", verb: "open" },
							{ key: "/", verb: "filter" },
						],
						"back",
					)
				: buildHint(
						[
							{ key: "Tab", verb: "switch level" },
							{ key: "Space", verb: "preview" },
							{ key: "Enter", verb: "open" },
							{ key: "/", verb: "filter" },
						],
						"back",
					);
		},
	});
	return Object.assign(handle, { refreshRows });
}
