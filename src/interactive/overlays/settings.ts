import type { ClioSettings } from "../../core/config.js";
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
import { clioTheme } from "../theme/index.js";
import { modelsForEndpoint } from "./model-selector.js";

export const SETTINGS_OVERLAY_WIDTH = "100%";
export const SETTINGS_OVERLAY_MAX_HEIGHT = "100%";
export const SETTINGS_OVERLAY_MARGIN = { top: 1, right: 2, bottom: 1, left: 2 } as const;

const SECTION_LANE_WIDTH = 22;
const WIDE_LAYOUT_MIN_WIDTH = 96;
const FALLBACK_THINKING_VALUES = ["off", "minimal", "low", "medium", "high", "xhigh"];
const FOOTER_NOTE = "applies to this session and to new sessions";
const ROW_GAP = "  ";

export const SETTINGS_SECTIONS = [
	{ id: "safety", label: "Autonomy" },
	{ id: "orchestrator", label: "Orchestrator" },
	{ id: "fleet", label: "Fleet" },
	{ id: "budget", label: "Budget" },
	{ id: "compaction", label: "Compaction" },
	{ id: "retry", label: "Retry" },
	{ id: "terminal", label: "Terminal" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export const SETTINGS_LABELS_BY_ID = {
	safetyLevel: "Autonomy level",
	"orchestrator.thinkingLevel": "Thinking level",
	"orchestrator.endpoint": "Target",
	"orchestrator.model": "Model",
	"workers.default.endpoint": "Default target",
	"workers.default.model": "Default model",
	"budget.sessionCeilingUsd": "Session ceiling (USD)",
	scope: "Model cycle set",
	"compaction.auto": "Auto-compact",
	"compaction.excludeLastTurns": "Protected recent turns",
	"compaction.threshold": "Compaction threshold",
	"retry.enabled": "Retry transient errors",
	"retry.maxRetries": "Max retries",
	"retry.baseDelayMs": "Base delay (ms)",
	"retry.maxDelayMs": "Max delay (ms)",
	"terminal.showTerminalProgress": "Terminal progress badges",
} as const;

export type EditableSettingId = keyof typeof SETTINGS_LABELS_BY_ID;

export const SETTINGS_SECTION_ROWS = {
	safety: ["safetyLevel"],
	orchestrator: ["orchestrator.thinkingLevel", "orchestrator.endpoint", "orchestrator.model"],
	fleet: ["workers.default.endpoint", "workers.default.model"],
	budget: ["budget.sessionCeilingUsd", "scope"],
	compaction: ["compaction.auto", "compaction.excludeLastTurns", "compaction.threshold"],
	retry: ["retry.enabled", "retry.maxRetries", "retry.baseDelayMs", "retry.maxDelayMs"],
	terminal: ["terminal.showTerminalProgress"],
} as const satisfies Record<SettingsSectionId, readonly EditableSettingId[]>;

const SETTINGS_DESCRIPTIONS_BY_ID = {
	safetyLevel: "Model initiative guidance; safety gates apply at every level.",
	"orchestrator.thinkingLevel": "Reasoning budget for the chat loop.",
	"orchestrator.endpoint": "Active chat target id.",
	"orchestrator.model": "Active chat wire model id.",
	"workers.default.endpoint": "Default /run target id.",
	"workers.default.model": "Default /run wire model id.",
	"budget.sessionCeilingUsd": "Per-session cost cap.",
	scope: "Alt+J and Alt+K model cycle set.",
	"compaction.auto": "Auto-compact before a turn when context crosses the threshold.",
	"compaction.excludeLastTurns": "Recent user turns protected from observation masking.",
	"compaction.threshold": "Pressure at which compaction masks stale observations, then runs an LLM summary.",
	"retry.enabled": "Retry transient provider errors on the next submit.",
	"retry.maxRetries": "Retry attempts after the initial failure.",
	"retry.baseDelayMs": "Initial retry delay in milliseconds.",
	"retry.maxDelayMs": "Maximum retry delay in milliseconds.",
	"terminal.showTerminalProgress": "Emit OSC 9;4 progress badges during agent turns.",
} as const satisfies Record<EditableSettingId, string>;

type SettingSubmenuBuilder = NonNullable<SettingItem["submenu"]>;
type SettingsCenterLane = "sections" | "rows";

export interface SettingsCenterItem extends SettingItem {
	id: EditableSettingId;
	label: string;
	description: string;
	section: SettingsSectionId;
	configPath: EditableSettingId;
	affordance: string;
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
			lines.push(theme.fg("dim", `  ${this.note}`));
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

function selectEndpointSubmenu(providers: ProvidersContract): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const statuses = providers.list();
		if (statuses.length === 0) {
			return textInputSubmenu("Type target id")(currentValue, done);
		}
		const items = statuses.map((status) => ({
			value: status.endpoint.id,
			label: `${status.endpoint.id} (${status.endpoint.url ?? "no url"})`,
		}));
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper("Select target", list);
	};
}

function selectModelSubmenu(
	providers: ProvidersContract,
	getActiveEndpoint: () => string | undefined,
): SettingSubmenuBuilder {
	return (currentValue: string, done: (val?: string) => void) => {
		const endpointId = getActiveEndpoint();
		const status = providers.list().find((s) => s.endpoint.id === endpointId);
		const models = status ? modelsForEndpoint(status) : [];
		if (models.length === 0) {
			return textInputSubmenu("Type model name")(currentValue, done);
		}
		const items = models.map((m) => ({ value: m, label: m }));
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper(`Select model for ${endpointId}`, list);
	};
}

function editTextSubmenu(title: string): SettingSubmenuBuilder {
	return textInputSubmenu(title);
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

function settingItem(
	id: EditableSettingId,
	currentValue: string,
	options: {
		values?: readonly string[];
		submenu?: SettingSubmenuBuilder;
		affordance?: string;
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
	};
	if (options.values) item.values = [...options.values];
	if (options.submenu) item.submenu = options.submenu;
	return item;
}

/**
 * Surface the settings that the overlay can actually edit. Reference-only
 * diagnostics stay out of this list so the Center has no dead rows.
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
	const resolvedThinking = options?.providers
		? resolveModelRuntimeCapabilitiesForProviders(
				options.providers,
				settings.orchestrator.endpoint,
				settings.orchestrator.model,
				settings.orchestrator.thinkingLevel ?? "off",
			)?.thinking
		: null;
	const displayedThinkingLevel = resolvedThinking?.display ?? settings.orchestrator.thinkingLevel ?? "off";
	const thinkingValues = resolvedThinking
		? resolvedThinking.supportedLevels.map((level) => thinkingLevelChoiceLabel(resolvedThinking.mechanism, level))
		: FALLBACK_THINKING_VALUES;
	const endpointSubmenu = options?.providers
		? selectEndpointSubmenu(options.providers)
		: editTextSubmenu("Type target id");
	const orchestratorModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().orchestrator.endpoint ?? undefined)
		: editTextSubmenu("Type model name");
	const workerModelSubmenu = options?.providers
		? selectModelSubmenu(options.providers, () => live().workers.default.endpoint ?? undefined)
		: editTextSubmenu("Type model name");
	return [
		settingItem("safetyLevel", settings.safetyLevel, {
			values: ["suggest", "auto-edit", "full-auto"],
		}),
		settingItem("orchestrator.thinkingLevel", displayedThinkingLevel, {
			values: thinkingValues,
		}),
		settingItem("orchestrator.endpoint", settings.orchestrator.endpoint ?? "(unset)", {
			submenu: endpointSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("orchestrator.model", settings.orchestrator.model ?? "(unset)", {
			submenu: orchestratorModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("workers.default.endpoint", settings.workers.default.endpoint ?? "(unset)", {
			submenu: endpointSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("workers.default.model", settings.workers.default.model ?? "(unset)", {
			submenu: workerModelSubmenu,
			affordance: options?.providers ? "opens picker" : "free text",
		}),
		settingItem("budget.sessionCeilingUsd", String(settings.budget.sessionCeilingUsd), {
			submenu: editNumberSubmenu("Edit session cost ceiling USD"),
			affordance: "free text",
		}),
		settingItem("scope", scopeText, {
			submenu: editTextSubmenu("Edit model cycle scope comma-separated list"),
			affordance: "free text",
		}),
		settingItem("compaction.auto", String(compaction.auto), {
			values: ["true", "false"],
		}),
		settingItem("compaction.excludeLastTurns", String(compaction.excludeLastTurns), {
			values: ["3", "6", "10", "15"],
		}),
		settingItem("compaction.threshold", formatThreshold(compaction.threshold), {
			values: ["0.7", "0.8", "0.85", "0.9"],
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
		case "safetyLevel":
			if (value === "suggest" || value === "auto-edit" || value === "full-auto") settings.safetyLevel = value;
			return;
		case "orchestrator.thinkingLevel":
			settings.orchestrator.thinkingLevel = thinkingLevelFromChoiceLabel(value) ?? settings.orchestrator.thinkingLevel;
			return;
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
		case "orchestrator.endpoint": {
			const endpoint = value === "(unset)" || value === "" ? null : value;
			// Switching targets re-bases the model on the new target default.
			if (endpoint !== settings.orchestrator.endpoint) {
				settings.orchestrator.model = endpoint
					? (settings.endpoints.find((entry) => entry.id === endpoint)?.defaultModel ?? null)
					: null;
			}
			settings.orchestrator.endpoint = endpoint;
			return;
		}
		case "orchestrator.model":
			settings.orchestrator.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "workers.default.endpoint": {
			const endpoint = value === "(unset)" || value === "" ? null : value;
			if (endpoint !== settings.workers.default.endpoint) {
				settings.workers.default.model = endpoint
					? (settings.endpoints.find((entry) => entry.id === endpoint)?.defaultModel ?? null)
					: null;
			}
			settings.workers.default.endpoint = endpoint;
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
	const available = Math.max(1, safeWidth - prefixWidth - visibleWidth(ROW_GAP) * 2);
	const labelNatural = Math.max(8, ...items.map((item) => visibleWidth(item.label)));
	const pathNatural = Math.max(10, ...items.map((item) => visibleWidth(item.configPath)));
	let label = Math.min(labelNatural, 24, Math.max(8, Math.floor(available * 0.34)));
	let path = Math.min(pathNatural, 34, Math.max(8, Math.floor(available * 0.42)));
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
	indentWidth = 0,
): string {
	const theme = clioTheme();
	const indent = " ".repeat(Math.max(0, indentWidth));
	const prefix = selected ? theme.fg("accent", "▸ ") : "  ";
	const labelText = padAnsi(item.label, columns.label);
	const label = selected ? theme.style("accent", labelText, { bold: true }) : labelText;
	const path = theme.fg("dim", padAnsi(item.configPath, columns.path));
	const valueWidth =
		width - visibleWidth(indent) - 2 - columns.label - visibleWidth(ROW_GAP) - columns.path - visibleWidth(ROW_GAP);
	const valueText = truncateToWidth(item.currentValue, Math.max(1, valueWidth), "", true);
	const value = selected ? theme.fg("success", valueText) : theme.fg("muted", valueText);
	return truncateToWidth(`${indent}${prefix}${label}${ROW_GAP}${path}${ROW_GAP}${value}`, width, "", true);
}

export interface SettingsCenterOptions {
	getBodyHeight: () => number;
	onChange: (id: string, newValue: string) => void;
	onCancel: () => void;
	requestRender?: () => void;
}

export class SettingsCenter implements Component {
	private focusedLane: SettingsCenterLane = "rows";
	private selectedSectionIndex = 0;
	private readonly rowIndexBySection = new Map<SettingsSectionId, number>();
	private submenuComponent: Component | null = null;
	private narrowMode = false;

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
		if (
			(kb.matches(data, "tui.select.confirm") || data === " " || matchesKey(data, "enter")) &&
			this.focusedLane === "rows"
		) {
			this.activateSelectedItem();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
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
	}

	private moveSelection(delta: -1 | 1): void {
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

	private activateSelectedItem(): void {
		const item = this.selectedItem();
		if (!item) return;
		if (item.submenu) {
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.options.onChange(item.id, selectedValue);
				}
				this.submenuComponent = null;
				this.options.requestRender?.();
			});
			return;
		}
		if (item.values && item.values.length > 0) {
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			if (newValue === undefined) return;
			item.currentValue = newValue;
			this.options.onChange(item.id, newValue);
		}
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
		const rows = [
			theme.fg("dim", "Sections"),
			...this.sections().map((section, index) => {
				const selected = index === this.selectedSectionIndex;
				const cursor = selected && this.focusedLane === "sections" ? theme.fg("accent", "▸ ") : "  ";
				const label = selected ? theme.style("accent", section.label, { bold: true }) : section.label;
				return `${cursor}${label}`;
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
		const rows = section.items
			.slice(start, end)
			.map((item, offset) =>
				formatSettingRow(item, width, start + offset === selected && this.focusedLane === "rows", columns),
			);
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
		const allItems = this.items;
		const columns = rowColumns(allItems, width, 2);
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
				rows.push({ line: formatSettingRow(item, width, rowSelected, columns, 2), selected: rowSelected });
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
		const maxFooterLines = Math.min(bodyHeight, bodyHeight >= 8 ? 4 : 3);
		if (maxFooterLines <= 0) return [];
		const selected = this.selectedItem();
		const description = selected?.description ?? "No setting selected.";
		const affordance = selected?.affordance ?? "";
		const descriptionText = `${theme.fg("muted", description)} ${theme.fg("dim", affordance)}`.trim();
		const descriptionBudget = Math.max(1, maxFooterLines - 2);
		const wrappedDescription = wrapTextWithAnsi(descriptionText, Math.max(1, width)).slice(0, descriptionBudget);
		while (wrappedDescription.length < descriptionBudget) wrappedDescription.push("");
		const lines = [
			theme.fg("frame", "─".repeat(Math.max(0, width))),
			...wrappedDescription,
			theme.fg("dim", truncateToWidth(FOOTER_NOTE, width, "", true)),
		];
		return lines.slice(0, maxFooterLines);
	}
}

export type SettingsNoticeLevel = "info" | "success" | "warning" | "error";

export interface OpenSettingsOverlayDeps {
	getSettings: () => Readonly<ClioSettings>;
	providers?: ProvidersContract;
	writeSettings: (next: ClioSettings) => void;
	notice?: (level: SettingsNoticeLevel, text: string, key?: string) => void;
	onClose: () => void;
}

export function formatSettingChangeNotice(id: string, value: string): string {
	return `${id} set to ${value}`;
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
		onChange: (id: string, value: string) => {
			const current = structuredClone(deps.getSettings());
			applySettingChange(current, id, value);
			deps.writeSettings(current);
			deps.notice?.("success", formatSettingChangeNotice(id, value), `settings:${id}`);
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
			{ key: "Enter", verb: "edit" },
			{ key: "Space", verb: "cycle" },
		]),
	});
	return Object.assign(handle, { refreshRows });
}
