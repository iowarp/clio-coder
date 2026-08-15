import {
	bindAgentProfileInSettings,
	type ClioSettings,
	removeFleetProfileFromSettings,
	removeTargetFromSettings,
	setFleetProfileInSettings,
	useTargetInSettings,
} from "../../core/config.js";
import { DEFAULT_SETTINGS, THINKING_LEVELS } from "../../core/defaults.js";
import { getAtPath, isRoutingPath } from "../../core/session-routing.js";
import { MAX_TIMER_DELAY_MS } from "../../core/timers.js";
import {
	isDispatchEligibleRuntime,
	isOrchestratorEligibleRuntime,
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	type TargetHealth,
	thinkingLevelChoiceLabel,
	thinkingLevelFromChoiceLabel,
} from "../../domains/providers/index.js";
import type { FleetNodeSnapshot } from "../../domains/scheduling/cluster.js";
import {
	type Component,
	getKeybindings,
	Input,
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

export const SETTINGS_OVERLAY_WIDTH = "100%";
export const SETTINGS_OVERLAY_MAX_HEIGHT = "100%";
export const SETTINGS_OVERLAY_MARGIN = { top: 1, right: 2, bottom: 1, left: 2 } as const;

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
const RESTART_REQUIRED_IDS = new Set<string>(["budget.concurrency", "runtimePlugins"]);

export const SETTINGS_SECTIONS = [
	{ id: "safety", label: "Autonomy & Safety" },
	{ id: "orchestrator", label: "Orchestrator" },
	{ id: "fleet", label: "Fleet" },
	{ id: "targets", label: "Targets" },
	{ id: "models", label: "Models" },
	{ id: "budget", label: "Budget" },
	{ id: "compaction", label: "Compaction" },
	{ id: "retry", label: "Retry" },
	{ id: "terminal", label: "Terminal" },
	{ id: "advanced", label: "Advanced" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

const SETTINGS_SECTION_DESCRIPTIONS = {
	safety: "How freely Clio acts, and how delegated agents' tools are governed.",
	orchestrator: "Interactive chat routing and the optional proactive-memory model plane.",
	fleet: "Defaults, profiles, and agent bindings applied to dispatched workers, and where they run.",
	targets: "Configured inference targets: which one chat and the fleet use, and whether each answers.",
	models: "The /models picker, favorites, and Alt+J / Alt+K cycling.",
	budget: "Cost ceiling, per-turn output budget, and worker concurrency.",
	compaction: "When and how the context window is summarized under pressure.",
	retry: "Automatic recovery from transient provider and network errors.",
	terminal: "Terminal integration and the Clio color palette.",
	advanced: "Identity, runtime plugins, delegation timeouts, and links to other surfaces.",
} as const satisfies Record<SettingsSectionId, string>;

export const SETTINGS_LABELS_BY_ID = {
	autonomy: "Autonomy level",
	// Labels follow the CLI's post-rename vocabulary: the config surface is the
	// fleet, and `worker` is the runtime entity the descriptions still name. A
	// section headed Fleet whose rows read "Worker profiles" and "Worker
	// retries" made one setting look like two subsystems.
	"workers.onPermission": "Fleet approvals routing",
	"delegation.defaults.toolGovernance": "Delegation governance",
	"skills.trustProjectCompatRoots": "Trust project skill roots",
	safetyNet: "Safety net",
	"orchestrator.thinkingLevel": "Thinking level",
	"orchestrator.target": "Target",
	"orchestrator.model": "Model",
	"background.target": "Memory target",
	"background.model": "Memory model",
	"background.thinkingLevel": "Memory thinking level",
	"memory.intervention.enabled": "Proactive memory",
	"memory.intervention.everyNTools": "Memory cadence (tools)",
	"memory.intervention.windowSteps": "Memory trajectory steps",
	"memory.intervention.maxTokens": "Memory reminder tokens",
	"memory.intervention.timeoutMs": "Memory timeout (ms)",
	"workers.default.target": "Default target",
	"workers.default.model": "Default model",
	"workers.default.thinkingLevel": "Default thinking level",
	"workers.profiles": "Fleet profiles",
	"workers.agentBindings": "Agent bindings",
	"workers.maxRetries": "Fleet retries",
	scope: "Model cycle set",
	"modelSelector.recentLimit": "Recent models kept",
	"modelSelector.favorites": "Pinned favorites",
	"budget.sessionCeilingUsd": "Session ceiling (USD)",
	"defaults.maxTokens": "Output budget (tokens)",
	"budget.concurrency": "Fleet concurrency",
	"compaction.auto": "Auto-compact",
	"compaction.excludeLastTurns": "Protected recent turns",
	"compaction.threshold": "Compaction threshold",
	"retry.enabled": "Retry transient errors",
	"retry.maxRetries": "Max retries",
	"retry.baseDelayMs": "Base delay (ms)",
	"retry.maxDelayMs": "Max delay (ms)",
	"terminal.showTerminalProgress": "Terminal progress badges",
	"terminal.outputVerbosity": "Output detail",
	theme: "Theme",
	identity: "Identity",
	runtimePlugins: "Runtime plugins",
	"compaction.model": "Compaction model",
	"compaction.systemPrompt": "Compaction prompt",
	"delegation.defaults.connectTimeoutMs": "Delegate connect (ms)",
	"delegation.defaults.turnTimeoutMs": "Delegate turn (ms)",
	"delegation.defaults.permissionTimeoutMs": "Delegate permission (ms)",
	targets: "Configured targets",
	keybindings: "Keybinding overrides",
	"delegation.agents": "Delegation agents",
} as const;

/**
 * Entry rows (one per fleet profile field, agent binding, target, fleet node)
 * are keyed by the config path they edit; fleet node rows are read-only status.
 */
type EntrySettingId =
	| `workers.profiles.${string}`
	| `workers.agentBindings.${string}`
	| `targets.${string}`
	| `fleet.nodes.${string}`;
export type EditableSettingId = keyof typeof SETTINGS_LABELS_BY_ID | EntrySettingId;
const REMOVE_PROFILE_CHOICE = "(remove profile)";
const UNBIND_CHOICE = "(unbind)";
const AUTO_PLACEMENT_CHOICE = "(auto placement)";

export const SETTINGS_SECTION_ROWS = {
	safety: [
		"autonomy",
		"workers.onPermission",
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
		"background.thinkingLevel",
		"memory.intervention.enabled",
		"memory.intervention.everyNTools",
		"memory.intervention.windowSteps",
		"memory.intervention.maxTokens",
		"memory.intervention.timeoutMs",
	],
	fleet: [
		"workers.default.target",
		"workers.default.model",
		"workers.default.thinkingLevel",
		"workers.profiles",
		"workers.agentBindings",
		"workers.maxRetries",
	],
	models: ["scope", "modelSelector.recentLimit", "modelSelector.favorites"],
	budget: ["budget.sessionCeilingUsd", "defaults.maxTokens", "budget.concurrency"],
	compaction: ["compaction.auto", "compaction.threshold", "compaction.excludeLastTurns"],
	retry: ["retry.enabled", "retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs"],
	terminal: ["terminal.showTerminalProgress", "terminal.outputVerbosity", "theme"],
	advanced: [
		"identity",
		"runtimePlugins",
		"compaction.model",
		"compaction.systemPrompt",
		"delegation.defaults.connectTimeoutMs",
		"delegation.defaults.turnTimeoutMs",
		"delegation.defaults.permissionTimeoutMs",
		"keybindings",
		"delegation.agents",
	],
	targets: ["targets"],
} as const satisfies Record<SettingsSectionId, readonly EditableSettingId[]>;

const SETTINGS_DESCRIPTIONS_BY_ID = {
	autonomy: "How freely Clio acts; the safety net always applies.",
	"workers.onPermission":
		"How a worker resolves an approval ask: deny the call, fail the run, or escalate to this session.",
	"delegation.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"skills.trustProjectCompatRoots": "Whether third-party project skill roots are loaded.",
	safetyNet: "Always-on rails; tuned in .clio-coder/safety.yaml.",
	"orchestrator.thinkingLevel": "Reasoning budget for the chat loop.",
	"orchestrator.target": "Active chat target id.",
	"orchestrator.model": "Active chat wire model id.",
	"background.target": "Optional target for LLM memory steps; unset keeps rules-only memory.",
	"background.model": "Small non-reasoning model used only for task memory steps.",
	"background.thinkingLevel": "Unused: memory steps always request thinking off.",
	"memory.intervention.enabled": "Master switch for rules-only and model-backed task memory.",
	"memory.intervention.everyNTools": "Maximum tool executions between prompted memory steps.",
	"memory.intervention.windowSteps": "Recent completed tool steps visible to the memory policy.",
	"memory.intervention.maxTokens": "Hard cap for one visible memory reminder.",
	"memory.intervention.timeoutMs": "Hard deadline for one background-model memory call.",
	"workers.default.target": "Default /run target id.",
	"workers.default.model": "Default /run wire model id.",
	"workers.default.thinkingLevel": "Reasoning budget for dispatched workers.",
	"workers.profiles": "Named target/model/thinking choices that native workers can use. Enter adds one.",
	"workers.agentBindings": "Pins native Clio agents, including shadow agents, to worker profiles. Enter adds one.",
	"workers.maxRetries": "Automatic retries for a retryable worker outcome.",
	scope: "Alt+J and Alt+K model cycle set.",
	"modelSelector.recentLimit": "How many recently used models /models remembers.",
	"modelSelector.favorites": "Exact target/model refs pinned in /models.",
	"budget.sessionCeilingUsd": "Per-session cost cap.",
	"defaults.maxTokens": "Output tokens requested per turn, applied to every target.",
	"budget.concurrency": "Parallel workers allowed during dispatch.",
	"compaction.auto": "Auto-compact before a turn when context crosses the threshold.",
	"compaction.excludeLastTurns": "Recent user turns protected from observation masking.",
	"compaction.threshold": "Pressure at which compaction masks stale observations, then summarizes.",
	"retry.enabled": "Retry transient provider errors on the next submit.",
	"retry.maxRetries": "Retry attempts after the initial failure.",
	"retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"terminal.showTerminalProgress": "Emit OSC 9;4 progress badges during agent turns.",
	"terminal.outputVerbosity": "How much reasoning, tool input, and live tool output appears in the transcript.",
	theme: "Color palette. Clio ships a single tuned palette.",
	identity: "Name Clio uses for itself in the system prompt.",
	runtimePlugins: "npm packages exporting clioRuntimes: RuntimeDescriptor[].",
	"compaction.model": "Dedicated summarization model; blank uses the orchestrator.",
	"compaction.systemPrompt": "Path to a compaction prompt override; blank uses the built-in.",
	"delegation.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"delegation.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"delegation.defaults.permissionTimeoutMs": "How long a delegated permission ask may wait.",
	targets: "Inference targets available for chat and workers. Add one with `clio-coder targets add`.",
	keybindings: "Custom key overrides layered on the defaults.",
	"delegation.agents": "External ACP agents available to /delegate.",
} as const satisfies Record<EditableSettingId, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
const SETTINGS_HELP_BY_ID: Partial<Record<EditableSettingId, string>> = {
	autonomy:
		"read-only observes; suggest parks non-read calls; auto-edit edits, dispatches, and runs recognized commands; full-auto runs except command substitution and system-level changes. A confirmation marked exposure=outward parks for you at suggest and auto-edit.",
	"defaults.maxTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"compaction.threshold":
		"pressure = estimated tokens ÷ context window. Higher keeps more history but risks overflow before a summary runs.",
	"budget.concurrency": "auto sizes to your machine. A fixed number caps how many workers run at once.",
	"skills.trustProjectCompatRoots":
		"Project roots like .claude/skills and .codex/skills are untrusted by default; enabling exposes them to the model.",
	"workers.onPermission":
		"deny turns the ask into a tool denial and the run continues; fail stops the run as permission_required; escalate forwards the ask to you and falls back per workers.escalation on timeout.",
	"workers.agentBindings":
		"Bind base, custom, and shadow native agents such as scout, researcher, and provenance to profiles. ACP delegation agents cannot be bound.",
	"delegation.defaults.toolGovernance":
		"clio-policy gates the agent through Clio's safety net; agent-managed trusts the agent; deny-all blocks every tool.",
	scope: "Comma-separated target or target/model refs. Alt+J / Alt+K step the chat target through this list.",
	runtimePlugins: "Comma-separated package names, loaded at startup. Restart Clio after changing.",
	keybindings:
		"Renderer controls: Alt+O latest tool, Ctrl+Alt+O or Alt+Shift+O all tools, Alt+P live tool output, Alt+R latest reasoning, Ctrl+Alt+R or Alt+Shift+R all reasoning. Override these in settings.yaml or use /help.",
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
	"delegation.defaults.toolGovernance": {
		"clio-policy": "Clio's safety policy gates the delegated agent's tools",
		"agent-managed": "the external agent governs its own tools",
		"deny-all": "block every tool the delegated agent requests",
	},
	"compaction.auto": {
		true: "compact automatically before a turn crosses the threshold",
		false: "context is only compacted when you run /compact",
	},
	"retry.enabled": {
		true: "retry transient provider errors automatically",
		false: "surface transient errors immediately without retrying",
	},
	"skills.trustProjectCompatRoots": {
		true: "load skills from .claude/.codex/.github/etc. project roots",
		false: "ignore third-party project skill roots",
	},
	"terminal.showTerminalProgress": {
		true: "emit OSC 9;4 taskbar/tab progress badges during turns",
		false: "no terminal progress badges",
	},
	"terminal.outputVerbosity": {
		minimal: "quiet transcript; tools stay to one-line outcomes and reasoning stays folded",
		default: "balanced transcript; expand the latest tool or reasoning block on demand",
		verbose: "transparent transcript; reasoning, arguments, and live tool output stay visible",
	},
};

export type SettingSubmenuBuilder = NonNullable<SettingItem["submenu"]>;
type SettingsCenterLane = "sections" | "rows";

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
	id: EditableSettingId;
	label: string;
	description: string;
	section: SettingsSectionId;
	configPath: EditableSettingId;
	affordance: string;
	scope: SettingScope;
	readOnly: boolean;
	presentationKind: SettingsPresentationKind;
	valueSegments: readonly SettingsValueSegment[];
	help?: string;
	valueHelp?: Record<string, string>;
	defaultValue?: string;
}

export interface SettingsCenterSection {
	id: SettingsSectionId;
	label: string;
	items: SettingsCenterItem[];
}

export interface SettingsCenterSelection {
	lane: SettingsCenterLane;
	section: SettingsSectionId;
	rowIndex: number;
	rowId: EditableSettingId | null;
	submenuOpen: boolean;
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
}

type SubmenuTitle = string | ((width: number) => string);

export class SubmenuWrapper implements Component {
	constructor(
		private readonly title: SubmenuTitle,
		private readonly child: Component,
		private readonly hint: string = buildHint([{ key: "Enter", verb: "confirm" }], "back"),
		private readonly note?: string,
	) {}

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
		lines.push(...this.child.render(width).map((line) => `  ${line}`));
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

function editNumberSubmenu(title: string): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.setValue(currentValue);
		input.focused = true;
		input.onSubmit = (val) => {
			const num = Number(val);
			if (Number.isFinite(num) && num >= 0) {
				done(val);
			} else {
				done();
			}
		};
		input.onEscape = () => done();
		return new SubmenuWrapper(
			title,
			input,
			buildHint([{ key: "Enter", verb: "confirm" }], "back"),
			"Use a non-negative number.",
		);
	};
}

function selectListSubmenu(
	title: string,
	items: ReadonlyArray<{ value: string; label: string; presentationKind?: SettingsPresentationKind }>,
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
	if (!providers) return live().targets.map((target) => ({ value: target.id, label: target.id }));
	return providers
		.list()
		.filter((status) => status.runtime !== null && isDispatchEligibleRuntime(status.runtime))
		.map((status) => ({ value: status.target.id, label: `${status.target.id} (${status.target.url ?? "no url"})` }));
}

function profileNameChoices(live: () => Readonly<ClioSettings>): Array<{ value: string; label: string }> {
	const names = Object.keys(live().workers.profiles).sort();
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
		const runtime = providers?.list().find((entry) => entry.target.id === targetId)?.runtime ?? null;
		const chatEligible = !providers || (runtime !== null && isOrchestratorEligibleRuntime(runtime));
		const items = [
			...(chatEligible
				? [{ value: "use", label: "Use for chat and fleet dispatch", presentationKind: "action" as const }]
				: []),
			...(connectTarget
				? [{ value: "connect", label: "Connect (API key or OAuth), then probe", presentationKind: "action" as const }]
				: []),
			...(providers ? [{ value: "probe", label: "Probe health now", presentationKind: "action" as const }] : []),
			{ value: "remove", label: "Remove target", presentationKind: "destructive-action" as const },
		];
		const note = chatEligible ? undefined : "Not chat-eligible: its runtime is not HTTP/native.";
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
	if (isRoutingPath(id)) return undefined;
	const raw = getAtPath(DEFAULT_SETTINGS, id);
	if (raw === null || raw === undefined || typeof raw === "object") return undefined;
	return String(raw);
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
	},
): SettingsCenterItem {
	const item: SettingsCenterItem = {
		id,
		label: options.label ?? SETTINGS_LABELS_BY_ID[id as keyof typeof SETTINGS_LABELS_BY_ID],
		currentValue,
		description: options.description ?? SETTINGS_DESCRIPTIONS_BY_ID[id as keyof typeof SETTINGS_LABELS_BY_ID],
		section: sectionForSetting(id),
		configPath: id,
		affordance: options.affordance ?? (options.values ? cycleAffordance(options.values) : "opens picker"),
		scope: scopeForId(id),
		readOnly: options.readOnly ?? false,
		presentationKind: options.presentationKind ?? (options.readOnly ? "read-only-fact" : "setting"),
		valueSegments: options.valueSegments ?? [{ text: currentValue, tone: "neutral" }],
	};
	const help = SETTINGS_HELP_BY_ID[id];
	if (help) item.help = help;
	const valueHelp = SETTINGS_VALUE_HELP_BY_ID[id];
	if (valueHelp) item.valueHelp = valueHelp;
	const def = defaultValueFor(id);
	if (def !== undefined) item.defaultValue = def;
	if (options.values) item.values = [...options.values];
	if (options.submenu) item.submenu = options.submenu;
	return item;
}

function thinkingChoices(
	providers: ProvidersContract | undefined,
	target: string | null,
	model: string | null,
	level: ClioSettings["orchestrator"]["thinkingLevel"],
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
export function buildSettingItems(
	settings: Readonly<ClioSettings>,
	options?: BuildSettingItemsOptions,
): SettingsCenterItem[] {
	const live = options?.getSettings ?? ((): Readonly<ClioSettings> => settings);
	const scopeList = settings.scope ?? [];
	const scopeText = scopeList.length > 0 ? scopeList.join(", ") : "(empty)";
	const compaction = settings.compaction;
	const retry = settings.retry;
	const terminal = settings.terminal;
	const orchestratorThinking = thinkingChoices(
		options?.providers,
		settings.orchestrator.target,
		settings.orchestrator.model,
		settings.orchestrator.thinkingLevel,
	);
	const workerThinking = thinkingChoices(
		options?.providers,
		settings.workers.default.target,
		settings.workers.default.model,
		settings.workers.default.thinkingLevel,
	);
	const backgroundThinking = thinkingChoices(
		options?.providers,
		settings.background.target,
		settings.background.model,
		settings.background.thinkingLevel,
	);
	const profileCount = Object.keys(settings.workers.profiles ?? {}).length;
	const bindingCount = Object.keys(settings.workers.agentBindings ?? {}).length;
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
		? selectModelSubmenu(options.providers, () => live().orchestrator.target ?? undefined)
		: editTextSubmenu("Type model name");
	const workerModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().workers.default.target ?? undefined)
		: editTextSubmenu("Type model name");
	const backgroundTargetSubmenu = options?.providers
		? selectOptionalBackgroundTargetSubmenu(options.providers)
		: editTextSubmenu("Type memory target id", "Leave blank for rules-only memory.");
	const backgroundModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().background.target ?? undefined)
		: editTextSubmenu("Type memory model name");
	const favorites = settings.modelSelector?.favorites ?? [];
	const agents = settings.delegation?.agents ?? [];
	const keybindingCount = Object.keys(settings.keybindings ?? {}).length;
	return [
		settingItem("autonomy", settings.autonomy, {
			values: ["read-only", "suggest", "auto-edit", "full-auto"],
		}),
		settingItem("workers.onPermission", settings.workers.onPermission ?? "deny", {
			values: ["deny", "fail", "escalate"],
		}),
		settingItem("delegation.defaults.toolGovernance", settings.delegation.defaults.toolGovernance, {
			values: ["clio-policy", "agent-managed", "deny-all"],
		}),
		settingItem("skills.trustProjectCompatRoots", String(settings.skills.trustProjectCompatRoots), {
			values: ["false", "true"],
		}),
		settingItem("safetyNet", "always on", {
			affordance: "tuned in .clio-coder/safety.yaml",
			readOnly: true,
		}),
		settingItem("orchestrator.thinkingLevel", orchestratorThinking.display, {
			values: orchestratorThinking.values,
		}),
		settingItem("orchestrator.target", settings.orchestrator.target ?? "(unset)", {
			submenu: targetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("orchestrator.model", settings.orchestrator.model ?? "(unset)", {
			submenu: orchestratorModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("background.target", settings.background.target ?? "(unset — rules-only)", {
			submenu: backgroundTargetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("background.model", settings.background.model ?? "(unset)", {
			submenu: backgroundModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("background.thinkingLevel", backgroundThinking.display, {
			values: backgroundThinking.values,
		}),
		settingItem("memory.intervention.enabled", String(settings.memory.intervention.enabled), {
			values: ["true", "false"],
		}),
		settingItem("memory.intervention.everyNTools", String(settings.memory.intervention.everyNTools), {
			values: ["5", "10", "20", "30"],
		}),
		settingItem("memory.intervention.windowSteps", String(settings.memory.intervention.windowSteps), {
			values: ["4", "8", "12", "20"],
		}),
		settingItem("memory.intervention.maxTokens", String(settings.memory.intervention.maxTokens), {
			values: ["100", "200", "400", "800"],
		}),
		settingItem("memory.intervention.timeoutMs", String(settings.memory.intervention.timeoutMs), {
			values: ["5000", "10000", "20000", "30000", "60000"],
		}),
		settingItem("workers.default.target", settings.workers.default.target ?? "(unset)", {
			submenu: targetSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("workers.default.model", settings.workers.default.model ?? "(unset)", {
			submenu: workerModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("workers.default.thinkingLevel", workerThinking.display, {
			values: workerThinking.values,
		}),
		settingItem("workers.profiles", profileCount > 0 ? `${profileCount} profile(s)` : "(none)", {
			submenu: addProfileSubmenu,
			affordance: "Enter adds a profile",
			presentationKind: "action",
		}),
		...fleetProfileRows(settings, live, options),
		settingItem("workers.agentBindings", bindingCount > 0 ? `${bindingCount} binding(s)` : "(none)", {
			...(profileCount > 0 ? { submenu: addBindingSubmenu } : { readOnly: true }),
			affordance: profileCount > 0 ? "Enter binds an agent" : "create a profile first",
			presentationKind: profileCount > 0 ? "action" : "read-only-fact",
		}),
		...agentBindingRows(settings, live),
		settingItem("workers.maxRetries", String(settings.workers.maxRetries), {
			values: ["0", "1", "2", "3", "5", "8"],
		}),
		...fleetNodeRows(options?.getFleetNodes?.() ?? []),
		settingItem("targets", settings.targets.length > 0 ? `${settings.targets.length} configured` : "(none)", {
			affordance: "add with `clio-coder targets add`",
			readOnly: true,
			presentationKind: "group-header",
		}),
		...targetRows(settings, options),
		settingItem("scope", scopeText, {
			submenu: editTextSubmenu("Edit model cycle scope comma-separated list"),
			affordance: "free text",
		}),
		settingItem("modelSelector.recentLimit", String(settings.modelSelector.recentLimit), {
			values: ["6", "12", "20", "50"],
		}),
		settingItem("modelSelector.favorites", favorites.length > 0 ? `${favorites.length} pinned` : "(none)", {
			affordance: "manage in /models",
			readOnly: true,
		}),
		settingItem("budget.sessionCeilingUsd", String(settings.budget.sessionCeilingUsd), {
			submenu: editNumberSubmenu("Edit session cost ceiling USD"),
			affordance: "free text",
		}),
		settingItem("defaults.maxTokens", String(settings.defaults.maxTokens), {
			values: ["0", "4096", "8192", "16384", "32768", "65536", "131072"],
		}),
		settingItem("budget.concurrency", String(settings.budget.concurrency), {
			values: ["auto", "1", "2", "4", "8"],
		}),
		settingItem("compaction.auto", String(compaction.auto), {
			values: ["true", "false"],
		}),
		settingItem("compaction.threshold", formatThreshold(compaction.threshold), {
			values: ["0.7", "0.8", "0.85", "0.9"],
		}),
		settingItem("compaction.excludeLastTurns", String(compaction.excludeLastTurns), {
			values: ["3", "6", "10", "15"],
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
		settingItem("terminal.showTerminalProgress", String(terminal.showTerminalProgress), {
			values: ["false", "true"],
		}),
		settingItem("terminal.outputVerbosity", terminal.outputVerbosity, {
			values: ["minimal", "default", "verbose"],
		}),
		settingItem("theme", settings.theme, {
			affordance: "single clio-coder palette",
			readOnly: true,
		}),
		settingItem("identity", settings.identity, {
			submenu: editTextSubmenu("Edit identity name"),
			affordance: "free text",
		}),
		settingItem("runtimePlugins", settings.runtimePlugins.length > 0 ? settings.runtimePlugins.join(", ") : "(none)", {
			submenu: editTextSubmenu("Edit runtime plugins comma-separated list", "Restart Clio to load changes."),
			affordance: "free text",
		}),
		settingItem("compaction.model", compaction.model ?? "(orchestrator target)", {
			submenu: editTextSubmenu("Edit compaction model; blank uses the orchestrator"),
			affordance: "free text",
		}),
		settingItem("compaction.systemPrompt", compaction.systemPrompt ?? "(built-in)", {
			submenu: editTextSubmenu("Edit compaction prompt path; blank uses the built-in"),
			affordance: "free text",
		}),
		settingItem("delegation.defaults.connectTimeoutMs", String(settings.delegation.defaults.connectTimeoutMs), {
			submenu: editNumberSubmenu("Edit delegate connect timeout (ms)"),
			affordance: "free text",
		}),
		settingItem("delegation.defaults.turnTimeoutMs", String(settings.delegation.defaults.turnTimeoutMs), {
			submenu: editNumberSubmenu("Edit delegate turn timeout (ms)"),
			affordance: "free text",
		}),
		settingItem("delegation.defaults.permissionTimeoutMs", String(settings.delegation.defaults.permissionTimeoutMs), {
			submenu: editNumberSubmenu("Edit delegate permission timeout (ms)"),
			affordance: "free text",
		}),
		settingItem("keybindings", keybindingCount > 0 ? `${keybindingCount} override(s)` : "(defaults)", {
			affordance: "edit settings.yaml",
			readOnly: true,
		}),
		settingItem("delegation.agents", agents.length > 0 ? `${agents.length} agent(s)` : "(none)", {
			affordance: "edit settings.yaml",
			readOnly: true,
		}),
	];
}

function fleetProfileRows(
	settings: Readonly<ClioSettings>,
	live: () => Readonly<ClioSettings>,
	options: BuildSettingItemsOptions | undefined,
): SettingsCenterItem[] {
	const providers = options?.providers;
	return Object.entries(settings.workers.profiles)
		.sort(([a], [b]) => a.localeCompare(b))
		.flatMap(([name, profile]) => {
			const thinking = thinkingChoices(providers, profile.target, profile.model, profile.thinkingLevel);
			const targetSubmenu = selectListSubmenu(
				`Target for profile ${name}`,
				[
					...profileTargetChoices(live, providers),
					{ value: REMOVE_PROFILE_CHOICE, label: REMOVE_PROFILE_CHOICE, presentationKind: "destructive-action" as const },
				],
				"Changing the target rebases the model on that target's default. Removing the profile drops its agent bindings.",
			);
			const modelSubmenu = providers
				? selectModelSubmenu(providers, () => live().workers.profiles[name]?.target ?? undefined)
				: editTextSubmenu("Type model name");
			return [
				settingItem(`workers.profiles.${name}.target`, profile.target ?? "(unset)", {
					label: `${name} · target`,
					description: `Target that workers on profile ${name} dispatch to.`,
					submenu: targetSubmenu,
				}),
				settingItem(`workers.profiles.${name}.model`, profile.model ?? "(unset)", {
					label: `${name} · model`,
					description: `Wire model id for profile ${name}.`,
					submenu: modelSubmenu,
					affordance: providers ? "opens picker" : "free text",
				}),
				settingItem(`workers.profiles.${name}.thinkingLevel`, thinking.display, {
					label: `${name} · thinking`,
					description: `Reasoning budget for profile ${name}.`,
					values: thinking.values,
				}),
				settingItem(`workers.profiles.${name}.node`, profile.node ?? AUTO_PLACEMENT_CHOICE, {
					label: `${name} · node`,
					description: `Fleet node workers on profile ${name} are pinned to; auto placement picks per dispatch.`,
					submenu: selectListSubmenu(`Node for profile ${name}`, profileNodeChoices(settings, options)),
				}),
			];
		});
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
			return { value: node.id, label: `${node.id} (${node.host}${state ? `, ${state.state}` : ""})` };
		}),
	];
}

function agentBindingRows(settings: Readonly<ClioSettings>, live: () => Readonly<ClioSettings>): SettingsCenterItem[] {
	return Object.entries(settings.workers.agentBindings)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([agentId, profileName]) => {
			const missing = !settings.workers.profiles[profileName];
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
			settings.orchestrator.target === target.id ? "chat" : null,
			settings.workers.default.target === target.id ? "fleet" : null,
			settings.background.target === target.id ? "memory" : null,
		].filter((role) => role !== null);
		const health = status?.health.status ?? "unknown";
		const operation = options?.getTargetOperation?.(target.id) ?? null;
		// Roles lead: the value column shows about twelve cells at 120 columns.
		const roleText = roles.length > 0 ? `${roles.join("+")} · ` : "";
		const healthSegment = targetHealthSegment(health);
		const activitySegment: SettingsValueSegment | null = operation
			? { text: `${GLYPH.running} ${operation === "connect" ? "connecting" : "probing"}`, tone: "activity" }
			: null;
		const valueSegments = [
			...(roleText ? [{ text: roleText, tone: "neutral" as const }] : []),
			activitySegment ?? healthSegment,
		];
		const value = roles.length > 0 ? `${roles.join("+")} · ${health}` : health;
		return settingItem(`targets.${target.id}`, value, {
			label: target.id,
			description: `${target.runtime} · ${target.url ?? "no url"} · default model ${target.defaultModel ?? "(none)"}${status?.health.lastError ? ` · ${status.health.lastError}` : ""}`,
			submenu: targetActionsSubmenu(target.id, options),
			affordance: options?.connectTarget ? "Enter: use, connect, probe, remove" : "Enter: use, probe, remove",
			presentationKind: "status",
			valueSegments,
		});
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

export function buildSettingsSections(items: readonly SettingsCenterItem[]): SettingsCenterSection[] {
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

function formatThreshold(value: number): string {
	return Number.isFinite(value) ? String(value) : "0.8";
}

function applyNonNegativeInteger(value: string, set: (next: number) => void): void {
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed >= 0) set(Math.floor(parsed));
}

function applyPositiveInteger(value: string, set: (next: number) => void): void {
	const parsed = Number(value);
	if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_TIMER_DELAY_MS) set(parsed);
}

/**
 * Pure mutation applied in place for Settings Center editable rows.
 */
export function applySettingChange(settings: ClioSettings, id: string, value: string): void {
	if (applyEntrySettingChange(settings, id, value)) return;
	switch (id) {
		case "autonomy":
			if (value === "read-only" || value === "suggest" || value === "auto-edit" || value === "full-auto")
				settings.autonomy = value;
			return;
		case "workers.onPermission":
			if (value === "deny" || value === "fail" || value === "escalate") settings.workers.onPermission = value;
			return;
		case "delegation.defaults.toolGovernance":
			if (value === "clio-policy" || value === "agent-managed" || value === "deny-all")
				settings.delegation.defaults.toolGovernance = value;
			return;
		case "skills.trustProjectCompatRoots":
			if (value === "true" || value === "false") settings.skills.trustProjectCompatRoots = value === "true";
			return;
		case "orchestrator.thinkingLevel":
			settings.orchestrator.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.orchestrator.thinkingLevel;
			return;
		case "background.thinkingLevel":
			settings.background.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.background.thinkingLevel;
			return;
		case "memory.intervention.enabled":
			if (value === "true" || value === "false") settings.memory.intervention.enabled = value === "true";
			return;
		case "memory.intervention.everyNTools":
		case "memory.intervention.windowSteps":
		case "memory.intervention.maxTokens":
		case "memory.intervention.timeoutMs":
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) {
					const key = id.slice("memory.intervention.".length) as "everyNTools" | "windowSteps" | "maxTokens" | "timeoutMs";
					settings.memory.intervention[key] = next;
				}
			});
			return;
		case "workers.default.thinkingLevel":
			settings.workers.default.thinkingLevel =
				thinkingLevelFromChoiceLabel(value) ?? settings.workers.default.thinkingLevel;
			return;
		case "workers.maxRetries":
			applyNonNegativeInteger(value, (next) => {
				settings.workers.maxRetries = next;
			});
			return;
		case "modelSelector.recentLimit":
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) settings.modelSelector.recentLimit = next;
			});
			return;
		case "defaults.maxTokens":
			applyNonNegativeInteger(value, (next) => {
				settings.defaults.maxTokens = next;
			});
			return;
		case "budget.concurrency": {
			if (value === "auto") {
				settings.budget.concurrency = "auto";
				return;
			}
			applyNonNegativeInteger(value, (next) => {
				if (next >= 1) settings.budget.concurrency = next;
			});
			return;
		}
		case "compaction.auto":
			if (value === "true" || value === "false") settings.compaction.auto = value === "true";
			return;
		case "compaction.excludeLastTurns":
			applyNonNegativeInteger(value, (next) => {
				if (next > 0) settings.compaction.excludeLastTurns = next;
			});
			return;
		case "compaction.threshold": {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) settings.compaction.threshold = parsed;
			return;
		}
		case "compaction.model": {
			const trimmed = value.trim();
			if (trimmed) settings.compaction.model = trimmed;
			else delete settings.compaction.model;
			return;
		}
		case "compaction.systemPrompt": {
			const trimmed = value.trim();
			if (trimmed) settings.compaction.systemPrompt = trimmed;
			else delete settings.compaction.systemPrompt;
			return;
		}
		case "retry.enabled":
			if (value === "true" || value === "false") settings.retry.enabled = value === "true";
			return;
		case "retry.maxRetries":
			applyNonNegativeInteger(value, (next) => {
				settings.retry.maxRetries = next;
			});
			return;
		case "retry.baseDelayMs":
			applyNonNegativeInteger(value, (next) => {
				settings.retry.baseDelayMs = next;
			});
			return;
		case "retry.maxDelayMs":
			applyNonNegativeInteger(value, (next) => {
				settings.retry.maxDelayMs = next;
			});
			return;
		case "terminal.showTerminalProgress":
			if (value === "true" || value === "false") settings.terminal.showTerminalProgress = value === "true";
			return;
		case "terminal.outputVerbosity":
			if (value === "minimal" || value === "default" || value === "verbose") settings.terminal.outputVerbosity = value;
			return;
		case "identity": {
			const trimmed = value.trim();
			if (trimmed) settings.identity = trimmed;
			return;
		}
		case "runtimePlugins":
			settings.runtimePlugins = value
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean);
			return;
		case "delegation.defaults.connectTimeoutMs":
			applyPositiveInteger(value, (next) => {
				settings.delegation.defaults.connectTimeoutMs = next;
			});
			return;
		case "delegation.defaults.turnTimeoutMs":
			applyPositiveInteger(value, (next) => {
				settings.delegation.defaults.turnTimeoutMs = next;
			});
			return;
		case "delegation.defaults.permissionTimeoutMs":
			applyPositiveInteger(value, (next) => {
				settings.delegation.defaults.permissionTimeoutMs = next;
			});
			return;
		case "orchestrator.target": {
			const target = value === "(unset)" || value === "" ? null : value;
			// Switching targets re-bases the model on the new target default.
			if (target !== settings.orchestrator.target) {
				settings.orchestrator.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.orchestrator.target = target;
			return;
		}
		case "orchestrator.model":
			settings.orchestrator.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "background.target": {
			const target = value.startsWith("(unset") || value === "" ? null : value;
			if (target !== settings.background.target) {
				settings.background.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.background.target = target;
			return;
		}
		case "background.model":
			settings.background.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "workers.default.target": {
			const target = value === "(unset)" || value === "" ? null : value;
			if (target !== settings.workers.default.target) {
				settings.workers.default.model = target
					? (settings.targets.find((entry) => entry.id === target)?.defaultModel ?? null)
					: null;
			}
			settings.workers.default.target = target;
			return;
		}
		case "workers.default.model":
			settings.workers.default.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "scope":
			settings.scope = value
				.split(",")
				.map((v) => v.trim())
				.filter(Boolean);
			return;
		case "budget.sessionCeilingUsd": {
			const parsed = Number(value);
			if (Number.isFinite(parsed) && parsed >= 0) settings.budget.sessionCeilingUsd = parsed;
			return;
		}
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
		const segments = id.split(".");
		const field = segments.at(-1);
		const name = segments.slice(2, -1).join(".");
		const profile = settings.workers.profiles[name];
		if (!profile) return true;
		if (field === "target") {
			if (value === REMOVE_PROFILE_CHOICE) removeFleetProfileFromSettings(settings, name);
			else if (value !== profile.target) setFleetProfileInSettings(settings, name, value);
		} else if (field === "model") {
			profile.model = value === "(unset)" || value === "" ? null : value;
		} else if (field === "thinkingLevel") {
			profile.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? profile.thinkingLevel;
		} else if (field === "node") {
			if (value === AUTO_PLACEMENT_CHOICE || value === "") delete profile.node;
			else profile.node = value;
		}
		return true;
	}
	if (id.startsWith("workers.agentBindings.")) {
		const agentId = id.slice("workers.agentBindings.".length);
		if (value === UNBIND_CHOICE) delete settings.workers.agentBindings[agentId];
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
		const profileLeaf = path.startsWith("workers.profiles.") && path.split(".").length === 3;
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
	readonly propagation: readonly { readonly path: string; readonly timing: SettingsPropagationTiming }[];
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
		return path.startsWith("orchestrator.") ? "now" : "next-dispatch";
	}
	if (path.startsWith("workers.")) return "next-dispatch";
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

export function createSettingsChangePlan(
	settings: Readonly<ClioSettings>,
	item: Pick<SettingsCenterItem, "id" | "label" | "currentValue" | "scope">,
	selectedValue: string,
	sessionDestinationAvailable = true,
): SettingsChangePlan | null {
	const original = structuredClone(settings);
	const proposed = structuredClone(original);
	applySettingChange(proposed, item.id, selectedValue);
	const paths = changedLeafPaths(original, proposed);
	if (paths.length === 0) return null;
	const restartRequired = item.scope === "restart";
	const sessionCapable = !restartRequired && sessionDestinationAvailable;
	const leaves = paths.map((path) => ({ path, before: getAtPath(original, path), after: getAtPath(proposed, path) }));
	const propagation = paths.map((path) => ({
		path,
		timing: propagationTiming(item.id, selectedValue, path, restartRequired),
	}));
	return deepFreeze({
		rowId: item.id,
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

/** Keep the destination—the value the operator is about to commit—visible as confirmation titles narrow. */
function formatScopeConfirmTitle(plan: SettingsChangePlan, width: number): string {
	const full = `${plan.label}: ${plan.originalValue} → ${plan.selectedValue}`;
	if (visibleWidth(full) <= width) return full;
	const destinationFirst = `${plan.label}: → ${plan.selectedValue}`;
	if (visibleWidth(destinationFirst) <= width) return destinationFirst;
	return ellipsizeFromLeft(destinationFirst, width);
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
	if (id.startsWith("targets.")) return "use: chat now, workers at the next dispatch · remove: next dispatch";
	if (id.startsWith("workers.")) return "takes effect at the next dispatch";
	return null;
}

function fixedLines(lines: readonly string[], width: number, height: number): string[] {
	const out = lines.slice(0, height).map((line) => padAnsi(line, width, ELLIPSIS));
	while (out.length < height) out.push(" ".repeat(Math.max(0, width)));
	return out;
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
	const prefix = selected ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
	const labelText = padAnsi(item.label, columns.label, ELLIPSIS);
	const label = selected
		? theme.style("accent", labelText, { bold: true })
		: item.presentationKind === "group-header" || item.presentationKind === "action"
			? theme.style("accentDeep", labelText, { bold: true })
			: labelText;
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
			{ ...semantic, text: truncateToWidth(semantic.text, semanticWidth, ELLIPSIS, true) },
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
	private focusedLane: SettingsCenterLane = "rows";
	private selectedSectionIndex = 0;
	private readonly rowIndexBySection = new Map<SettingsSectionId, number>();
	private submenuComponent: Component | null = null;
	private narrowMode = false;
	/** Local cycle preview for the selected row; committed on Enter. */
	private pendingValue: string | null = null;

	constructor(
		private readonly items: SettingsCenterItem[],
		private readonly options: SettingsCenterOptions,
	) {}

	getSelection(): SettingsCenterSelection {
		const section = this.currentSection();
		const rowIndex = this.rowIndex(section.id);
		const row = section.items[rowIndex] ?? null;
		return {
			lane: this.focusedLane,
			section: section.id,
			rowIndex,
			rowId: row?.id ?? null,
			submenuOpen: this.submenuComponent !== null,
		};
	}

	setSelection(sectionId: SettingsSectionId, rowIndex: number, lane: SettingsCenterLane = "rows"): void {
		const sections = this.sections();
		const nextSectionIndex = sections.findIndex((section) => section.id === sectionId);
		if (nextSectionIndex >= 0) this.selectedSectionIndex = nextSectionIndex;
		const section = this.currentSection();
		this.rowIndexBySection.set(section.id, this.clampRowIndex(section, rowIndex));
		this.focusedLane = lane;
		this.submenuComponent = null;
		this.pendingValue = null;
	}

	refreshItems(): void {
		this.normalizeSelection();
	}

	render(width: number): string[] {
		const bodyHeight = Math.max(1, this.options.getBodyHeight());
		this.normalizeSelection();
		this.narrowMode = width < WIDE_LAYOUT_MIN_WIDTH;
		const lines = this.narrowMode
			? this.renderStacked(width, bodyHeight)
			: width >= ULTRAWIDE_LAYOUT_MIN_WIDTH
				? this.renderUltraWide(width, bodyHeight)
				: this.renderWide(width, bodyHeight);
		return fixedLines(lines, width, bodyHeight);
	}

	handleInput(data: string): void {
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}
		const kb = getKeybindings();
		if (matchesKey(data, "tab")) {
			this.toggleLane();
			return;
		}
		if (matchesKey(data, "left")) {
			this.focusedLane = "sections";
			this.pendingValue = null;
			return;
		}
		if (matchesKey(data, "right")) {
			this.focusedLane = "rows";
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
		if (data === " " && this.focusedLane === "rows") {
			this.cyclePreview();
			return;
		}
		if ((kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) && this.focusedLane === "rows") {
			this.activateSelectedItem();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.pendingValue !== null) {
				this.pendingValue = null;
				return;
			}
			this.options.onCancel();
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	private sections(): SettingsCenterSection[] {
		return buildSettingsSections(this.items);
	}

	private currentSection(): SettingsCenterSection {
		const sections = this.sections();
		const section = sections[this.selectedSectionIndex] ?? sections[0];
		if (!section) throw new Error("settings center requires sections");
		return section;
	}

	private rowIndex(sectionId: SettingsSectionId): number {
		const section = this.sections().find((entry) => entry.id === sectionId);
		if (!section) return 0;
		return this.clampRowIndex(section, this.rowIndexBySection.get(sectionId) ?? 0);
	}

	private clampRowIndex(section: SettingsCenterSection, rowIndex: number): number {
		return Math.max(0, Math.min(rowIndex, Math.max(0, section.items.length - 1)));
	}

	private normalizeSelection(): void {
		const sections = this.sections();
		this.selectedSectionIndex = Math.max(0, Math.min(this.selectedSectionIndex, Math.max(0, sections.length - 1)));
		for (const section of sections) {
			this.rowIndexBySection.set(section.id, this.clampRowIndex(section, this.rowIndexBySection.get(section.id) ?? 0));
		}
	}

	private selectedItem(): SettingsCenterItem | null {
		const section = this.currentSection();
		return section.items[this.rowIndex(section.id)] ?? null;
	}

	private toggleLane(): void {
		this.focusedLane = this.focusedLane === "sections" ? "rows" : "sections";
		this.pendingValue = null;
	}

	private moveSelection(delta: -1 | 1): void {
		this.pendingValue = null;
		if (this.focusedLane === "sections") {
			this.moveSection(delta);
			return;
		}
		if (this.narrowMode) {
			this.moveRowAcrossSections(delta);
			return;
		}
		const section = this.currentSection();
		const current = this.rowIndex(section.id);
		const total = section.items.length;
		if (total === 0) return;
		this.rowIndexBySection.set(section.id, (current + delta + total) % total);
	}

	private moveSection(delta: -1 | 1): void {
		const sections = this.sections();
		if (sections.length === 0) return;
		this.selectedSectionIndex = (this.selectedSectionIndex + delta + sections.length) % sections.length;
		this.normalizeSelection();
	}

	private moveRowAcrossSections(delta: -1 | 1): void {
		const flat = this.sections().flatMap((section) =>
			section.items.map((item, rowIndex) => ({ sectionId: section.id, rowIndex, id: item.id })),
		);
		if (flat.length === 0) return;
		const selected = this.selectedItem();
		const current = Math.max(
			0,
			flat.findIndex((entry) => entry.id === selected?.id),
		);
		const next = flat[(current + delta + flat.length) % flat.length];
		if (!next) return;
		const sectionIndex = this.sections().findIndex((section) => section.id === next.sectionId);
		if (sectionIndex >= 0) this.selectedSectionIndex = sectionIndex;
		this.rowIndexBySection.set(next.sectionId, next.rowIndex);
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
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue) => {
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
		const note = `Affects ${plan.leaves.map((leaf) => leaf.path).join(", ")} · ${plan.impact}`;
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
		const theme = clioTheme();
		const separator = barSep(theme);
		const separatorWidth = visibleWidth(" │ ");
		const leftWidth = Math.min(SECTION_LANE_WIDTH, Math.max(16, Math.floor(width * 0.28)));
		const detailWidth = Math.max(28, Math.min(44, Math.floor(width * 0.3)));
		const centerWidth = Math.max(1, width - leftWidth - detailWidth - separatorWidth * 2);
		const left = this.renderSectionLane(leftWidth, bodyHeight);
		const center = this.renderRightLane(centerWidth, bodyHeight);
		const right = this.renderDetailLane(detailWidth, bodyHeight);
		return Array.from({ length: bodyHeight }, (_, index) =>
			[
				padAnsi(left[index] ?? "", leftWidth, ELLIPSIS),
				padAnsi(center[index] ?? "", centerWidth, ELLIPSIS),
				padAnsi(right[index] ?? "", detailWidth, ELLIPSIS),
			].join(separator),
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
		if (this.focusedLane === "sections" || !item) {
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
		const footer = this.renderFooter(width, bodyHeight);
		const contentHeight = Math.max(1, bodyHeight - footer.length);
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
		return [...body, ...footer];
	}

	private renderSectionLane(width: number, height: number): string[] {
		const theme = clioTheme();
		const sections = this.sections();
		const rows = [
			theme.fg("dim", "Sections"),
			...sections.map((section, index) => {
				const selected = index === this.selectedSectionIndex;
				const cursor = selected && this.focusedLane === "sections" ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
				const modifiedCount = section.items.filter(
					(item) => !item.readOnly && item.defaultValue !== undefined && item.currentValue !== item.defaultValue,
				).length;
				const badge = modifiedCount > 0 ? theme.fg("accent", ` ${GLYPH.scoped}${modifiedCount}`) : "";
				const label = selected ? theme.style("accent", section.label, { bold: true }) : section.label;
				return `${cursor}${label}${badge}`;
			}),
		];
		const selectedLine = this.selectedSectionIndex + 1;
		const [start, end] = scrollWindow(rows.length, selectedLine, height);
		return fixedLines(rows.slice(start, end), width, height);
	}

	private renderRightLane(width: number, height: number): string[] {
		if (this.submenuComponent) {
			const lines = this.submenuComponent.render(width);
			return fixedLines(lines, width, height);
		}
		const theme = clioTheme();
		const section = this.currentSection();
		const rowBudget = Math.max(0, height - 1);
		const selected = this.rowIndex(section.id);
		const [start, end] = scrollWindow(section.items.length, selected, rowBudget);
		const columns = rowColumns(section.items, width, 0);
		const rows = section.items.slice(start, end).map((item, offset) => {
			const isSelected = start + offset === selected && this.focusedLane === "rows";
			const display = this.displayValueFor(item, isSelected);
			return formatSettingRow(item, width, isSelected, columns, 0, display.value, display.pending);
		});
		return fixedLines([screenTitle(theme, section.label), ...rows], width, height);
	}

	private renderStacked(width: number, bodyHeight: number): string[] {
		const footer = this.renderFooter(width, bodyHeight);
		const contentHeight = Math.max(1, bodyHeight - footer.length);
		if (this.submenuComponent) {
			return [...fixedLines(this.submenuComponent.render(width), width, contentHeight), ...footer];
		}
		const theme = clioTheme();
		const columns = rowColumns(this.items, width, 2);
		const rows: Array<{ line: string; selected: boolean }> = [];
		let selectedLine = 0;
		for (const [sectionIndex, section] of this.sections().entries()) {
			const sectionSelected = sectionIndex === this.selectedSectionIndex;
			const sectionFocused = sectionSelected && this.focusedLane === "sections";
			if (sectionFocused) selectedLine = rows.length;
			const cursor = sectionFocused ? theme.fg("accent", `${GLYPH.cursor} `) : "  ";
			const label = sectionSelected
				? theme.style("accent", section.label, { bold: true })
				: theme.fg("dim", section.label);
			rows.push({ line: `${cursor}${label}`, selected: sectionFocused });
			for (const [rowIndex, item] of section.items.entries()) {
				const rowSelected = sectionSelected && rowIndex === this.rowIndex(section.id) && this.focusedLane === "rows";
				if (rowSelected) selectedLine = rows.length;
				const display = this.displayValueFor(item, rowSelected);
				rows.push({
					line: formatSettingRow(item, width, rowSelected, columns, 2, display.value, display.pending),
					selected: rowSelected,
				});
			}
		}
		const [start, end] = scrollWindow(rows.length, selectedLine, contentHeight);
		return [
			...fixedLines(
				rows.slice(start, end).map((row) => row.line),
				width,
				contentHeight,
			),
			...footer,
		];
	}

	private renderFooter(width: number, bodyHeight: number): string[] {
		const theme = clioTheme();
		const maxFooterLines = Math.min(bodyHeight, bodyHeight >= 12 ? 6 : bodyHeight >= 8 ? 5 : bodyHeight >= 6 ? 4 : 3);
		if (maxFooterLines <= 0) return [];
		const safeWidth = Math.max(1, width);
		const separator = rule(theme, safeWidth);
		const sections = this.sections();
		const section = this.currentSection();
		const item = this.selectedItem();
		const positionText = theme.fg("dim", `section ${this.selectedSectionIndex + 1}/${sections.length}`);

		if (this.focusedLane === "sections") {
			const breadcrumb = `${screenTitle(theme, section.label)}  ${theme.fg("dim", "·")}  ${positionText}`;
			const body = wrapTextWithAnsi(theme.fg("muted", SETTINGS_SECTION_DESCRIPTIONS[section.id]), safeWidth);
			const note = theme.fg("dim", "Tab or → to edit its settings");
			return this.assembleFooter([separator, breadcrumb], body, note, maxFooterLines, safeWidth);
		}

		if (!item) {
			return this.assembleFooter([separator], [], theme.fg("muted", "No setting selected."), maxFooterLines, safeWidth);
		}

		const breadcrumb = `${screenTitle(theme, section.label)} ${theme.fg("dim", "›")} ${theme.style("accent", item.label, { bold: true })}  ${theme.fg("dim", "·")}  ${positionText}`;
		const contentLines: string[] = [];
		contentLines.push(...wrapTextWithAnsi(theme.fg("muted", item.description), safeWidth));
		if (item.help) contentLines.push(...wrapTextWithAnsi(theme.fg("dim", item.help), safeWidth));
		const detail = this.footerDetail(item, theme);
		if (detail) contentLines.push(...wrapTextWithAnsi(detail, safeWidth));
		const note = theme.fg("dim", truncateToWidth(this.footerScopeNote(item), safeWidth, ELLIPSIS, true));
		return this.assembleFooter([separator, breadcrumb], contentLines, note, maxFooterLines, safeWidth);
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
		note: string,
		maxFooterLines: number,
		width: number,
	): string[] {
		const fit = (line: string): string => truncateToWidth(line, width, ELLIPSIS, true);
		let out: string[];
		if (maxFooterLines <= top.length) {
			out = top.slice(0, maxFooterLines).map(fit);
		} else {
			const middleBudget = Math.max(0, maxFooterLines - top.length - 1);
			// The explanation is wrapped, so a short terminal drops whole lines off
			// its end rather than cutting one. At 40 columns the autonomy help
			// stopped at "read-only observes; suggest" and read as the whole
			// sentence, so the last line it keeps says that it is not.
			const kept = middle.slice(0, middleBudget);
			const last = kept.at(-1);
			const marked =
				middle.length > kept.length && last !== undefined ? [...kept.slice(0, -1), `${last}${ELLIPSIS}`] : kept;
			out = [...top.map(fit), ...marked.map(fit), fit(note)];
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
	getFleetNodes?: BuildSettingItemsOptions["getFleetNodes"];
	connectTarget?: BuildSettingItemsOptions["connectTarget"];
}

function formatSettingChangeNotice(id: string, value: string, scope: "session" | "global"): string {
	return `${id} set to ${value} (${scope === "global" ? "saved globally" : "this session"})`;
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
	if (deps.section) center.setSelection(deps.section, 0);
	const refreshRows = (): void => {
		refreshSettingItemsInPlace(items, buildSettingItems(deps.getSettings(), buildOptions));
		center.refreshItems();
		tui.requestRender();
	};
	const handle = showClioOverlayFrame(tui, center, {
		anchor: "top-left",
		width: SETTINGS_OVERLAY_WIDTH,
		maxHeight: SETTINGS_OVERLAY_MAX_HEIGHT,
		margin: SETTINGS_OVERLAY_MARGIN,
		title: "Settings",
		footerHint: buildHint([
			{ key: "Tab", verb: "switch lane" },
			{ key: "Space", verb: "preview" },
			{ key: "Enter", verb: "edit" },
		]),
	});
	return Object.assign(handle, { refreshRows });
}
