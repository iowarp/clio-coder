import type { ClioSettings } from "../../core/config.js";
import {
	type ProvidersContract,
	resolveModelRuntimeCapabilitiesForProviders,
	thinkingLevelChoiceLabel,
	thinkingLevelFromChoiceLabel,
} from "../../domains/providers/index.js";
import {
	type Component,
	Input,
	type OverlayHandle,
	SelectList,
	type SettingItem,
	SettingsList,
	type TUI,
} from "../../engine/tui.js";
import type { ClioKeybindingManager } from "../keybinding-manager.js";
import { DEFAULT_SELECT_THEME, DEFAULT_SETTINGS_THEME, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme } from "../theme/index.js";
import { modelsForEndpoint } from "./model-selector.js";

class SubmenuWrapper implements Component {
	constructor(
		private readonly title: string,
		private readonly child: Component,
		private readonly hint: string = "[Enter] confirm    [Esc] cancel",
	) {}

	render(width: number): string[] {
		const theme = clioTheme();
		const lines: string[] = [];
		lines.push(theme.style("title", `  ${this.title}`, { bold: true }));
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

function selectEndpointSubmenu(providers: ProvidersContract) {
	return (_currentValue: string, done: (val?: string) => void) => {
		const statuses = providers.list();
		const items = statuses.map((status) => ({
			value: status.endpoint.id,
			label: `${status.endpoint.id} (${status.endpoint.url ?? "no url"})`,
		}));
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper("Select target endpoint", list);
	};
}

function selectModelSubmenu(providers: ProvidersContract, getActiveEndpoint: () => string | undefined) {
	return (currentValue: string, done: (val?: string) => void) => {
		const endpointId = getActiveEndpoint();
		const status = providers.list().find((s) => s.endpoint.id === endpointId);
		const models = status ? modelsForEndpoint(status) : [];
		if (models.length === 0) {
			const input = new Input();
			input.setValue(currentValue);
			input.focused = true;
			input.onSubmit = (val) => done(val);
			input.onEscape = () => done();
			return new SubmenuWrapper("Type model name", input);
		}
		const items = models.map((m) => ({ value: m, label: m }));
		const list = new SelectList(items, Math.min(10, items.length), DEFAULT_SELECT_THEME);
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done();
		return new SubmenuWrapper(`Select model for ${endpointId}`, list);
	};
}

function editTextSubmenu(title: string) {
	return (currentValue: string, done: (val?: string) => void) => {
		const input = new Input();
		input.setValue(currentValue);
		input.focused = true;
		input.onSubmit = (val) => done(val);
		input.onEscape = () => done();
		return new SubmenuWrapper(title, input);
	};
}

function editNumberSubmenu(title: string) {
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
		return new SubmenuWrapper(title, input, "[Enter] confirm    [Esc] cancel    (positive numbers only)");
	};
}

export const SETTINGS_OVERLAY_WIDTH = 84;
const VISIBLE_ROWS = 12;

/**
 * Surface the endpoint-schema settings that are safe to inspect or cycle
 * inline. Free-text fields (orchestrator.endpoint/model, workers.default.*,
 * scope) render for read-only reference because editing them in place needs
 * either a picker (/model, /scoped-models) or text input the overlay does
 * not yet host.
 */
export function buildSettingItems(
	settings: Readonly<ClioSettings>,
	options?: { providers?: ProvidersContract; keybindings?: ClioKeybindingManager },
): SettingItem[] {
	const scopeList = settings.scope ?? [];
	const scopeText = scopeList.length > 0 ? scopeList.join(", ") : "(empty)";
	const endpointCount = settings.endpoints?.length ?? 0;
	const profileEntries = Object.entries(settings.workers?.profiles ?? {});
	const profileSummary =
		profileEntries.length === 0
			? "(none)"
			: profileEntries.map(([name, profile]) => `${name}->${profile.endpoint ?? "(unset)"}`).join(", ");
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
		: (["off"] as string[]);
	return [
		{
			id: "safetyLevel",
			label: "safetyLevel",
			currentValue: settings.safetyLevel,
			values: ["suggest", "auto-edit", "full-auto"],
			description: "Default write-gate posture.",
		},
		{
			id: "orchestrator.thinkingLevel",
			label: "orchestrator.thinkingLevel",
			currentValue: displayedThinkingLevel,
			values: thinkingValues,
			description: "Reasoning budget for the chat loop.",
		},
		{
			id: "orchestrator.endpoint",
			label: "orchestrator.target",
			currentValue: settings.orchestrator.endpoint ?? "(unset)",
			description: "Active target id.",
			...(options?.providers ? { submenu: selectEndpointSubmenu(options.providers) } : {}),
		},
		{
			id: "orchestrator.model",
			label: "orchestrator.model",
			currentValue: settings.orchestrator.model ?? "(unset)",
			description: "Active wire model id.",
			...(options?.providers
				? { submenu: selectModelSubmenu(options.providers, () => settings.orchestrator.endpoint ?? undefined) }
				: {}),
		},
		{
			id: "workers.default.endpoint",
			label: "fleet.default.target",
			currentValue: settings.workers.default.endpoint ?? "(unset)",
			description: "/run target id.",
			...(options?.providers ? { submenu: selectEndpointSubmenu(options.providers) } : {}),
		},
		{
			id: "workers.default.model",
			label: "fleet.default.model",
			currentValue: settings.workers.default.model ?? "(unset)",
			description: "/run wire model id.",
			...(options?.providers
				? { submenu: selectModelSubmenu(options.providers, () => settings.workers.default.endpoint ?? undefined) }
				: {}),
		},
		{
			id: "workers.profiles",
			label: "fleet.profiles",
			currentValue: `${profileEntries.length} (${profileSummary})`,
			description: "Named fleet profiles. Edit via clio targets profile or settings.yaml.",
		},
		{
			id: "endpoints.count",
			label: "endpoints",
			currentValue: String(endpointCount),
			description: "Configured targets. Edit settings.yaml or run /targets.",
		},
		{
			id: "budget.sessionCeilingUsd",
			label: "budget.sessionCeilingUsd",
			currentValue: String(settings.budget.sessionCeilingUsd),
			description: "Per-session cost cap.",
			submenu: editNumberSubmenu("Edit session cost ceiling USD"),
		},
		{
			id: "scope",
			label: "scope",
			currentValue: scopeText,
			description: "Ctrl+P cycle set.",
			submenu: editTextSubmenu("Edit model cycle scope (comma-separated list)"),
		},
		{
			id: "compaction.auto",
			label: "compaction.auto",
			currentValue: String(compaction.auto),
			values: ["true", "false"],
			description: "Auto-compact before a turn when context crosses threshold.",
		},
		{
			id: "compaction.excludeLastTurns",
			label: "compaction.excludeLastTurns",
			currentValue: String(compaction.excludeLastTurns),
			values: ["3", "6", "10", "15"],
			description: "Recent user turns protected from observation masking.",
		},
		{
			id: "compaction.threshold",
			label: "compaction.threshold",
			currentValue: formatThreshold(compaction.threshold),
			values: ["0.7", "0.8", "0.85", "0.9"],
			description: "Pressure at which compaction acts: mask stale observations, then LLM summary.",
		},
		{
			id: "retry.enabled",
			label: "retry.enabled",
			currentValue: String(retry.enabled),
			values: ["true", "false"],
			description: "Retry transient provider errors on the next submit.",
		},
		{
			id: "retry.maxRetries",
			label: "retry.maxRetries",
			currentValue: String(retry.maxRetries),
			values: ["0", "1", "2", "3", "5", "8"],
			description: "Retry attempts after the initial failure.",
		},
		{
			id: "retry.baseDelayMs",
			label: "retry.baseDelayMs",
			currentValue: String(retry.baseDelayMs),
			values: ["500", "1000", "2000", "5000", "10000"],
			description: "Initial retry delay in milliseconds.",
		},
		{
			id: "retry.maxDelayMs",
			label: "retry.maxDelayMs",
			currentValue: String(retry.maxDelayMs),
			values: ["10000", "30000", "60000", "120000", "300000"],
			description: "Maximum retry delay in milliseconds.",
		},
		{
			id: "terminal.showTerminalProgress",
			label: "terminal.showTerminalProgress",
			currentValue: String(terminal.showTerminalProgress),
			values: ["false", "true"],
			description: "Emit OSC 9;4 progress badges during agent turns.",
		},
		{
			id: "keybindings",
			label: "keybindings",
			currentValue: formatKeybindingsSummary(options?.keybindings),
			description: "Open /hotkeys to see bindings; edit settings.yaml > keybindings to override.",
		},
	];
}

function formatThreshold(value: number): string {
	return Number.isFinite(value) ? String(value) : "0.8";
}

function formatKeybindingsSummary(manager?: ClioKeybindingManager): string {
	if (!manager) return "(unavailable)";
	const overrides = manager.overrideCount();
	const conflicts = manager.getConflicts().length;
	const invalid = manager.invalidCount();
	if (overrides === 0 && conflicts === 0 && invalid === 0) return "defaults (no overrides)";
	const parts = [`${overrides} override${overrides === 1 ? "" : "s"}`];
	parts.push(`${invalid} invalid`);
	parts.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
	return parts.join(", ");
}

function applyNonNegativeInteger(value: string, set: (next: number) => void): void {
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed >= 0) set(Math.floor(parsed));
}

/**
 * Pure mutation applied in-place for overlay-editable rows. Every other id is
 * a read-only reference row today.
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
		case "orchestrator.endpoint":
			settings.orchestrator.endpoint = value === "(unset)" || value === "" ? null : value;
			return;
		case "orchestrator.model":
			settings.orchestrator.model = value === "(unset)" || value === "" ? null : value;
			return;
		case "workers.default.endpoint":
			settings.workers.default.endpoint = value === "(unset)" || value === "" ? null : value;
			return;
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

export interface OpenSettingsOverlayDeps {
	getSettings: () => Readonly<ClioSettings>;
	providers?: ProvidersContract;
	keybindings?: ClioKeybindingManager;
	writeSettings: (next: ClioSettings) => void;
	onClose: () => void;
}

export function openSettingsOverlay(tui: TUI, deps: OpenSettingsOverlayDeps): OverlayHandle {
	const buildOptions: { providers?: ProvidersContract; keybindings?: ClioKeybindingManager } = {};
	if (deps.providers) buildOptions.providers = deps.providers;
	if (deps.keybindings) buildOptions.keybindings = deps.keybindings;
	const items = buildSettingItems(deps.getSettings(), buildOptions);
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SettingsList(
		items,
		visible,
		DEFAULT_SETTINGS_THEME,
		(id: string, value: string) => {
			const current = structuredClone(deps.getSettings());
			applySettingChange(current, id, value);
			deps.writeSettings(current);
			list.updateValue(id, value);
		},
		() => deps.onClose(),
	);
	const box = new FocusBox(list);
	return showClioOverlayFrame(tui, box, {
		anchor: "center",
		width: SETTINGS_OVERLAY_WIDTH,
		title: "Settings",
		footerHint: "[Enter/Space] edit/cycle    [Esc] cancel",
	});
}
