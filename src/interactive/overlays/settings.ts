import type { ClioSettings } from "../../core/config.js";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { getAtPath, isRoutingPath } from "../../core/session-routing.js";
import {
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	thinkingLevelChoiceLabel,
	thinkingLevelFromChoiceLabel,
} from "../../domains/providers/index.js";
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
import { buildHint, DEFAULT_SELECT_THEME, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import { modelsForTarget } from "./model-selector.js";

export const SETTINGS_OVERLAY_WIDTH = "100%";
export const SETTINGS_OVERLAY_MAX_HEIGHT = "100%";
export const SETTINGS_OVERLAY_MARGIN = { top: 1, right: 2, bottom: 1, left: 2 } as const;

const SECTION_LANE_WIDTH = 24;
const WIDE_LAYOUT_MIN_WIDTH = 96;
const DROP_PATH_COLUMN_WIDTH = 52;
const FALLBACK_THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"];
const ROW_GAP = "  ";

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
	orchestrator: "The target and model that drive the interactive chat loop.",
	fleet: "Defaults applied to dispatched workers (/run, clio run).",
	models: "The /models picker, favorites, and Alt+J / Alt+K cycling.",
	budget: "Cost ceiling, per-turn output budget, and worker concurrency.",
	compaction: "When and how the context window is summarized under pressure.",
	retry: "Automatic recovery from transient provider and network errors.",
	terminal: "Terminal integration and the Clio color palette.",
	advanced: "Identity, runtime plugins, delegation timeouts, and links to other surfaces.",
} as const satisfies Record<SettingsSectionId, string>;

export const SETTINGS_LABELS_BY_ID = {
	autonomy: "Autonomy level",
	"workers.onPermission": "Worker permission asks",
	"delegation.defaults.toolGovernance": "Delegation governance",
	"skills.trustProjectCompatRoots": "Trust project skill roots",
	safetyNet: "Safety net",
	"orchestrator.thinkingLevel": "Thinking level",
	"orchestrator.target": "Target",
	"orchestrator.model": "Model",
	"workers.default.target": "Default target",
	"workers.default.model": "Default model",
	"workers.default.thinkingLevel": "Default thinking level",
	"workers.maxRetries": "Worker retries",
	scope: "Model cycle set",
	"modelSelector.recentLimit": "Recent models kept",
	"modelSelector.favorites": "Pinned favorites",
	"budget.sessionCeilingUsd": "Session ceiling (USD)",
	"defaults.maxTokens": "Output budget (tokens)",
	"budget.concurrency": "Worker concurrency",
	"compaction.auto": "Auto-compact",
	"compaction.excludeLastTurns": "Protected recent turns",
	"compaction.threshold": "Compaction threshold",
	"retry.enabled": "Retry transient errors",
	"retry.maxRetries": "Max retries",
	"retry.baseDelayMs": "Base delay (ms)",
	"retry.maxDelayMs": "Max delay (ms)",
	"terminal.showTerminalProgress": "Terminal progress badges",
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

export type EditableSettingId = keyof typeof SETTINGS_LABELS_BY_ID;

export const SETTINGS_SECTION_ROWS = {
	safety: [
		"autonomy",
		"workers.onPermission",
		"delegation.defaults.toolGovernance",
		"skills.trustProjectCompatRoots",
		"safetyNet",
	],
	orchestrator: ["orchestrator.thinkingLevel", "orchestrator.target", "orchestrator.model"],
	fleet: ["workers.default.target", "workers.default.model", "workers.default.thinkingLevel", "workers.maxRetries"],
	models: ["scope", "modelSelector.recentLimit", "modelSelector.favorites"],
	budget: ["budget.sessionCeilingUsd", "defaults.maxTokens", "budget.concurrency"],
	compaction: ["compaction.auto", "compaction.threshold", "compaction.excludeLastTurns"],
	retry: ["retry.enabled", "retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs"],
	terminal: ["terminal.showTerminalProgress", "theme"],
	advanced: [
		"identity",
		"runtimePlugins",
		"compaction.model",
		"compaction.systemPrompt",
		"delegation.defaults.connectTimeoutMs",
		"delegation.defaults.turnTimeoutMs",
		"delegation.defaults.permissionTimeoutMs",
		"targets",
		"keybindings",
		"delegation.agents",
	],
} as const satisfies Record<SettingsSectionId, readonly EditableSettingId[]>;

const SETTINGS_DESCRIPTIONS_BY_ID = {
	autonomy: "How freely Clio acts; the safety net always applies.",
	"workers.onPermission": "What a worker permission ask does when it cannot prompt.",
	"delegation.defaults.toolGovernance": "Tool policy for delegated external agents.",
	"skills.trustProjectCompatRoots": "Whether third-party project skill roots are loaded.",
	safetyNet: "Always-on rails; tuned in .clio/safety.yaml.",
	"orchestrator.thinkingLevel": "Reasoning budget for the chat loop.",
	"orchestrator.target": "Active chat target id.",
	"orchestrator.model": "Active chat wire model id.",
	"workers.default.target": "Default /run target id.",
	"workers.default.model": "Default /run wire model id.",
	"workers.default.thinkingLevel": "Reasoning budget for dispatched workers.",
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
	theme: "Color palette. Clio ships a single tuned palette.",
	identity: "Name Clio uses for itself in the system prompt.",
	runtimePlugins: "npm packages exporting clioRuntimes: RuntimeDescriptor[].",
	"compaction.model": "Dedicated summarization model; blank uses the orchestrator.",
	"compaction.systemPrompt": "Path to a compaction prompt override; blank uses the built-in.",
	"delegation.defaults.connectTimeoutMs": "How long to wait for a delegated agent to connect.",
	"delegation.defaults.turnTimeoutMs": "How long a single delegated turn may run.",
	"delegation.defaults.permissionTimeoutMs": "How long a delegated permission ask may wait.",
	targets: "Inference targets available for chat and workers.",
	keybindings: "Custom key overrides layered on the defaults.",
	"delegation.agents": "External ACP agents available to /delegate.",
} as const satisfies Record<EditableSettingId, string>;

/** Longer, optional guidance shown beneath the one-line description when there is room. */
const SETTINGS_HELP_BY_ID: Partial<Record<EditableSettingId, string>> = {
	autonomy: "read-only observes; suggest proposes; auto-edit edits but asks before commands; full-auto runs unattended.",
	"defaults.maxTokens":
		"Clamped down to each model's max-output cap and the remaining context window. Set 0 to use per-model caps only.",
	"compaction.threshold":
		"pressure = estimated tokens ÷ context window. Higher keeps more history but risks overflow before a summary runs.",
	"budget.concurrency": "auto sizes to your machine. A fixed number caps how many workers run at once.",
	"skills.trustProjectCompatRoots":
		"Project roots like .claude/skills and .codex/skills are untrusted by default; enabling exposes them to the model.",
	"workers.onPermission":
		"deny keeps the run going by turning the ask into a tool denial; fail stops the run as permission_required.",
	"delegation.defaults.toolGovernance":
		"clio-policy gates the agent through Clio's safety net; agent-managed trusts the agent; deny-all blocks every tool.",
	scope: "Comma-separated target or target/model refs. Alt+J / Alt+K step the chat target through this list.",
	runtimePlugins: "Comma-separated package names, loaded at startup. Restart Clio after changing.",
};

/** Per-value meaning, surfaced for the current value of an enum knob. */
const SETTINGS_VALUE_HELP_BY_ID: Partial<Record<EditableSettingId, Record<string, string>>> = {
	autonomy: {
		"read-only": "observe and answer only; never edits files or runs commands",
		suggest: "propose every edit and command for your approval",
		"auto-edit": "edit files freely, but ask before running commands",
		"full-auto": "edit and run without prompts (the safety net still applies)",
	},
	"workers.onPermission": {
		deny: "a worker permission ask becomes a tool denial; the run continues",
		fail: "the run ends immediately as permission_required",
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
};

type SettingSubmenuBuilder = NonNullable<SettingItem["submenu"]>;
type SettingsCenterLane = "sections" | "rows";

export interface SettingsCenterItem extends SettingItem {
	id: EditableSettingId;
	label: string;
	description: string;
	section: SettingsSectionId;
	configPath: EditableSettingId;
	affordance: string;
	scope: SettingScope;
	readOnly: boolean;
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
}

class SubmenuWrapper implements Component {
	constructor(
		private readonly title: string,
		private readonly child: Component,
		private readonly hint: string = buildHint("commit", [{ key: "Enter", verb: "confirm" }]),
		private readonly note?: string,
	) {}

	render(width: number): string[] {
		const theme = clioTheme();
		const lines: string[] = [];
		lines.push(theme.style("title", `  ${this.title}`, { bold: true }));
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
		return new SubmenuWrapper(title, input, buildHint("commit", [{ key: "Enter", verb: "confirm" }]), note);
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
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper("Select target", list);
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
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper(`Select model for ${targetId}`, list);
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
			buildHint("commit", [{ key: "Enter", verb: "confirm" }]),
			"Use a non-negative number.",
		);
	};
}

function sectionForSetting(id: EditableSettingId): SettingsSectionId {
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
	},
): SettingsCenterItem {
	const item: SettingsCenterItem = {
		id,
		label: SETTINGS_LABELS_BY_ID[id],
		currentValue,
		description: SETTINGS_DESCRIPTIONS_BY_ID[id],
		section: sectionForSetting(id),
		configPath: id,
		affordance: options.affordance ?? (options.values ? cycleAffordance(options.values) : "opens picker"),
		scope: scopeForId(id),
		readOnly: options.readOnly ?? false,
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
	const targetSubmenu = options?.providers ? selectTargetSubmenu(options.providers) : editTextSubmenu("Type target id");
	const orchestratorModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().orchestrator.target ?? undefined)
		: editTextSubmenu("Type model name");
	const workerModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().workers.default.target ?? undefined)
		: editTextSubmenu("Type model name");
	const favorites = settings.modelSelector?.favorites ?? [];
	const agents = settings.delegation?.agents ?? [];
	const keybindingCount = Object.keys(settings.keybindings ?? {}).length;
	return [
		settingItem("autonomy", settings.autonomy, {
			values: ["read-only", "suggest", "auto-edit", "full-auto"],
		}),
		settingItem("workers.onPermission", settings.workers.onPermission ?? "deny", {
			values: ["deny", "fail"],
		}),
		settingItem("delegation.defaults.toolGovernance", settings.delegation.defaults.toolGovernance, {
			values: ["clio-policy", "agent-managed", "deny-all"],
		}),
		settingItem("skills.trustProjectCompatRoots", String(settings.skills.trustProjectCompatRoots), {
			values: ["false", "true"],
		}),
		settingItem("safetyNet", "always on", {
			affordance: "tuned in .clio/safety.yaml",
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
		settingItem("workers.maxRetries", String(settings.workers.maxRetries), {
			values: ["0", "1", "2", "3", "5", "8"],
		}),
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
		settingItem("theme", settings.theme, {
			affordance: "single clio palette",
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
		settingItem("targets", settings.targets.length > 0 ? `${settings.targets.length} configured` : "(none)", {
			affordance: "manage in /providers",
			readOnly: true,
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

export function buildSettingsSections(items: readonly SettingsCenterItem[]): SettingsCenterSection[] {
	return SETTINGS_SECTIONS.map((section) => ({
		id: section.id,
		label: section.label,
		items: items.filter((item) => item.section === section.id),
	}));
}

export function refreshSettingItemsInPlace(items: SettingsCenterItem[], next: readonly SettingsCenterItem[]): void {
	const byId = new Map(next.map((item) => [item.id, item] as const));
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

/**
 * Pure mutation applied in place for Settings Center editable rows.
 */
export function applySettingChange(settings: ClioSettings, id: string, value: string): void {
	switch (id) {
		case "autonomy":
			if (value === "read-only" || value === "suggest" || value === "auto-edit" || value === "full-auto")
				settings.autonomy = value;
			return;
		case "workers.onPermission":
			if (value === "deny" || value === "fail") settings.workers.onPermission = value;
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
			applyNonNegativeInteger(value, (next) => {
				settings.delegation.defaults.connectTimeoutMs = next;
			});
			return;
		case "delegation.defaults.turnTimeoutMs":
			applyNonNegativeInteger(value, (next) => {
				settings.delegation.defaults.turnTimeoutMs = next;
			});
			return;
		case "delegation.defaults.permissionTimeoutMs":
			applyNonNegativeInteger(value, (next) => {
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

interface RowColumns {
	label: number;
	path: number;
}

function padAnsi(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "", true);
	return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
}

function fixedLines(lines: readonly string[], width: number, height: number): string[] {
	const out = lines.slice(0, height).map((line) => padAnsi(line, width));
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
	const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
	const labelText = padAnsi(item.label, columns.label);
	const label = selected ? theme.style("accent", labelText, { bold: true }) : labelText;
	const modified = !item.readOnly && item.defaultValue !== undefined && item.currentValue !== item.defaultValue;
	const marker = pending
		? theme.fg("warning", `${GLYPH.running} `)
		: modified
			? theme.fg("accent", `${GLYPH.running} `)
			: "  ";
	let used = visibleWidth(indent) + 2 + columns.label + visibleWidth(ROW_GAP);
	let pathSegment = "";
	if (columns.path > 0) {
		pathSegment = `${theme.fg("dim", padAnsi(item.configPath, columns.path))}${ROW_GAP}`;
		used += columns.path + visibleWidth(ROW_GAP);
	}
	const valueWidth = Math.max(1, width - used - 2);
	const valueText = truncateToWidth(displayValue, valueWidth, "", true);
	const value = pending
		? theme.fg("warning", valueText)
		: item.readOnly
			? theme.fg("dim", valueText)
			: selected
				? theme.fg("success", valueText)
				: theme.fg("muted", valueText);
	return truncateToWidth(`${indent}${prefix}${label}${ROW_GAP}${pathSegment}${marker}${value}`, width, "", true);
}

export interface SettingsCenterOptions {
	getBodyHeight: () => number;
	onCommit: (id: string, newValue: string, scope: "session" | "global") => void;
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
		const lines = this.narrowMode ? this.renderStacked(width, bodyHeight) : this.renderWide(width, bodyHeight);
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
				if (selectedValue !== undefined) this.openScopeConfirm(item, selectedValue);
				this.options.requestRender?.();
			});
			return;
		}
		if (item.values && item.values.length > 0) {
			let value = this.pendingValue;
			if (value === null) {
				const currentIndex = item.values.indexOf(item.currentValue);
				value = item.values[(currentIndex + 1) % item.values.length] ?? item.currentValue;
			}
			this.openScopeConfirm(item, value);
		}
	}

	/**
	 * After a value is chosen, apply it to the live session immediately (for
	 * live-capable knobs) and ask whether to also save it as the global default.
	 * Restart-required knobs cannot apply live, so they only offer a global save.
	 */
	private openScopeConfirm(item: SettingsCenterItem, value: string): void {
		const restart = item.scope === "restart";
		if (!restart) this.options.onCommit(item.id, value, "session");
		const options = restart
			? [
					{ value: "global", label: "Save globally — restart Clio to apply" },
					{ value: "cancel", label: "Cancel" },
				]
			: [
					{ value: "global", label: "Save as the global default (new sessions too)" },
					{ value: "session", label: "Keep it for this session only" },
				];
		const list = new SelectList(options, options.length, DEFAULT_SELECT_THEME);
		const finish = (chosen: string | null): void => {
			if (chosen === "global") this.options.onCommit(item.id, value, "global");
			this.submenuComponent = null;
			this.pendingValue = null;
			this.options.requestRender?.();
		};
		list.onSelect = (opt) => finish(opt.value);
		// Esc keeps the live change session-only; for restart knobs nothing was applied.
		list.onCancel = () => finish(restart ? "cancel" : "session");
		const title = restart ? `${item.label} → ${value}` : `${item.label} = ${value} · applied to this session`;
		const note = restart
			? "This knob only takes effect on the next start. Save it to settings.yaml?"
			: "Also save it to settings.yaml as the default for new sessions?";
		this.submenuComponent = new SubmenuWrapper(
			title,
			list,
			buildHint("commit", [{ key: "Enter", verb: "choose" }]),
			note,
		);
	}

	private displayValueFor(item: SettingsCenterItem, selected: boolean): { value: string; pending: boolean } {
		if (selected && this.pendingValue !== null && this.pendingValue !== item.currentValue) {
			return { value: this.pendingValue, pending: true };
		}
		return { value: item.currentValue, pending: false };
	}

	private renderWide(width: number, bodyHeight: number): string[] {
		const footer = this.renderFooter(width, bodyHeight);
		const contentHeight = Math.max(1, bodyHeight - footer.length);
		const leftWidth = Math.min(SECTION_LANE_WIDTH, Math.max(16, Math.floor(width * 0.28)));
		const separator = clioTheme().fg("frame", " │ ");
		const separatorWidth = visibleWidth(" │ ");
		const rightWidth = Math.max(1, width - leftWidth - separatorWidth);
		const left = this.renderSectionLane(leftWidth, contentHeight);
		const right = this.renderRightLane(rightWidth, contentHeight);
		const body = Array.from(
			{ length: contentHeight },
			(_, index) => `${padAnsi(left[index] ?? "", leftWidth)}${separator}${padAnsi(right[index] ?? "", rightWidth)}`,
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
				const cursor = selected && this.focusedLane === "sections" ? theme.fg("accent", "▸ ") : "  ";
				const modifiedCount = section.items.filter(
					(item) => !item.readOnly && item.defaultValue !== undefined && item.currentValue !== item.defaultValue,
				).length;
				const badge = modifiedCount > 0 ? theme.fg("dim", ` ${GLYPH.running}${modifiedCount}`) : "";
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
		const header = theme.style("title", section.label, { bold: true });
		return fixedLines([header, ...rows], width, height);
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
			const cursor = sectionFocused ? theme.fg("accent", "▸ ") : "  ";
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
		const separator = theme.fg("frame", "─".repeat(safeWidth));
		const sections = this.sections();
		const section = this.currentSection();
		const item = this.selectedItem();
		const positionText = theme.fg("dim", `section ${this.selectedSectionIndex + 1}/${sections.length}`);

		if (this.focusedLane === "sections") {
			const breadcrumb = `${theme.style("title", section.label, { bold: true })}  ${theme.fg("dim", "·")}  ${positionText}`;
			const body = wrapTextWithAnsi(theme.fg("muted", SETTINGS_SECTION_DESCRIPTIONS[section.id]), safeWidth);
			const note = theme.fg("dim", "Tab or → to edit its settings");
			return this.assembleFooter([separator, breadcrumb], body, note, maxFooterLines, safeWidth);
		}

		if (!item) {
			return this.assembleFooter([separator], [], theme.fg("muted", "No setting selected."), maxFooterLines, safeWidth);
		}

		const breadcrumb = `${theme.style("title", section.label, { bold: true })} ${theme.fg("dim", "›")} ${theme.style("accent", item.label, { bold: true })}  ${theme.fg("dim", "·")}  ${positionText}`;
		const contentLines: string[] = [];
		contentLines.push(...wrapTextWithAnsi(theme.fg("muted", item.description), safeWidth));
		if (item.help) contentLines.push(...wrapTextWithAnsi(theme.fg("dim", item.help), safeWidth));
		const detail = this.footerDetail(item, theme);
		if (detail) contentLines.push(...wrapTextWithAnsi(detail, safeWidth));
		const note = theme.fg("dim", truncateToWidth(this.footerScopeNote(item), safeWidth, "", true));
		return this.assembleFooter([separator, breadcrumb], contentLines, note, maxFooterLines, safeWidth);
	}

	private footerDetail(item: SettingsCenterItem, theme: ReturnType<typeof clioTheme>): string {
		const parts: string[] = [theme.fg("dim", item.affordance)];
		if (!item.readOnly && item.defaultValue !== undefined) {
			const modified = item.currentValue !== item.defaultValue;
			parts.push(
				modified
					? theme.fg("accent", `${GLYPH.running} changed (default: ${item.defaultValue})`)
					: theme.fg("dim", `default: ${item.defaultValue}`),
			);
		}
		const valueMeaning = item.valueHelp?.[item.currentValue];
		if (!item.readOnly && valueMeaning) parts.push(theme.fg("muted", valueMeaning));
		return parts.join(theme.fg("frame", "  ·  "));
	}

	private footerScopeNote(item: SettingsCenterItem): string {
		if (item.readOnly) return "Read-only here · managed on the surface above";
		if (item.scope === "restart") return "Saved to settings.yaml · restart Clio to apply";
		return "Enter applies to this session now · then choose to also save it as the global default";
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
		const fit = (line: string): string => truncateToWidth(line, width, "", true);
		let out: string[];
		if (maxFooterLines <= top.length) {
			out = top.slice(0, maxFooterLines).map(fit);
		} else {
			const middleBudget = Math.max(0, maxFooterLines - top.length - 1);
			out = [...top.map(fit), ...middle.slice(0, middleBudget).map(fit), fit(note)];
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
}

export function formatSettingChangeNotice(id: string, value: string, scope: "session" | "global"): string {
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
	const buildOptions: BuildSettingItemsOptions = { getSettings: deps.getSettings };
	if (deps.providers) buildOptions.providers = deps.providers;
	const items = buildSettingItems(deps.getSettings(), buildOptions);
	const center = new SettingsCenter(items, {
		getBodyHeight: () => settingsBodyHeight(tui),
		onCommit: (id: string, value: string, scope: "session" | "global") => {
			const current = structuredClone(deps.getSettings());
			applySettingChange(current, id, value);
			if (deps.commitSetting) deps.commitSetting(id, current, scope);
			else deps.writeSettings(current);
			deps.notice?.("success", formatSettingChangeNotice(id, value, scope), `settings:${id}`);
			refreshRows();
		},
		onCancel: () => deps.onClose(),
		requestRender: () => tui.requestRender(),
	});
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
		footerHint: buildHint("commit", [
			{ key: "Tab", verb: "switch lane" },
			{ key: "Space", verb: "preview" },
			{ key: "Enter", verb: "edit" },
		]),
	});
	return Object.assign(handle, { refreshRows });
}
