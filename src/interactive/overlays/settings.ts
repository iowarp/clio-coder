import type { ClioSettings } from "../../core/config.js";
import {
	availableThinkingLevels,
	type ProvidersContract,
	resolveModelCapabilities,
	type ThinkingLevel,
} from "../../domains/providers/index.js";
import {
	Box,
	type OverlayHandle,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	type TUI,
} from "../../engine/tui.js";
import type { ClioKeybindingManager } from "../keybinding-manager.js";

export const SETTINGS_OVERLAY_WIDTH = 84;
const VISIBLE_ROWS = 12;

const IDENTITY = (s: string): string => s;

const SETTINGS_THEME: SettingsListTheme = {
	label: IDENTITY,
	value: IDENTITY,
	description: IDENTITY,
	cursor: "▸",
	hint: IDENTITY,
};

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
	const status = options?.providers?.list().find((entry) => entry.endpoint.id === settings.orchestrator.endpoint);
	const availableThinking = status
		? availableThinkingLevels(
				resolveModelCapabilities(status, settings.orchestrator.model, options?.providers?.knowledgeBase ?? null),
				{
					runtimeId: status.runtime?.id ?? status.endpoint.runtime,
					...(settings.orchestrator.model ? { modelId: settings.orchestrator.model } : {}),
				},
			)
		: (["off"] as ReadonlyArray<ThinkingLevel>);
	return [
		{
			id: "defaultMode",
			label: "defaultMode",
			currentValue: settings.defaultMode,
			values: ["default", "advise", "super"],
			description: "Mode the TUI boots into.",
		},
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
			currentValue: settings.orchestrator.thinkingLevel ?? "off",
			values: Array.from(availableThinking),
			description: "Reasoning budget for the chat loop.",
		},
		{
			id: "orchestrator.endpoint",
			label: "orchestrator.target",
			currentValue: settings.orchestrator.endpoint ?? "(unset)",
			description: "Active target id. Edit via /model.",
		},
		{
			id: "orchestrator.model",
			label: "orchestrator.model",
			currentValue: settings.orchestrator.model ?? "(unset)",
			description: "Active wire model id. Edit via /model.",
		},
		{
			id: "workers.default.endpoint",
			label: "workers.default.target",
			currentValue: settings.workers.default.endpoint ?? "(unset)",
			description: "/run target id. Edit settings.yaml.",
		},
		{
			id: "workers.default.model",
			label: "workers.default.model",
			currentValue: settings.workers.default.model ?? "(unset)",
			description: "/run wire model id. Edit settings.yaml.",
		},
		{
			id: "workers.profiles",
			label: "workers.profiles",
			currentValue: `${profileEntries.length} (${profileSummary})`,
			description: "Named worker profiles. Edit via clio targets worker or settings.yaml.",
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
			description: "Per-session cost cap. Edit settings.yaml.",
		},
		{
			id: "scope",
			label: "scope",
			currentValue: scopeText,
			description: "Ctrl+P cycle set. Edit via /scoped-models.",
		},
		{
			id: "compaction.auto",
			label: "compaction.auto",
			currentValue: String(compaction.auto),
			values: ["true", "false"],
			description: "Auto-compact before a turn when context crosses threshold.",
		},
		{
			id: "compaction.threshold",
			label: "compaction.threshold",
			currentValue: formatThreshold(compaction.threshold),
			values: ["0.6", "0.7", "0.8", "0.9", "0.95"],
			description: "Fraction of context window that triggers auto-compaction.",
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
		case "defaultMode":
			if (value === "default" || value === "advise" || value === "super") settings.defaultMode = value;
			return;
		case "safetyLevel":
			if (value === "suggest" || value === "auto-edit" || value === "full-auto") settings.safetyLevel = value;
			return;
		case "orchestrator.thinkingLevel":
			if (
				value === "off" ||
				value === "minimal" ||
				value === "low" ||
				value === "medium" ||
				value === "high" ||
				value === "xhigh"
			) {
				settings.orchestrator.thinkingLevel = value;
			}
			return;
		case "compaction.auto":
			if (value === "true" || value === "false") settings.compaction.auto = value === "true";
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
	}
}

export interface OpenSettingsOverlayDeps {
	getSettings: () => Readonly<ClioSettings>;
	providers?: ProvidersContract;
	keybindings?: ClioKeybindingManager;
	writeSettings: (next: ClioSettings) => void;
	onClose: () => void;
}

class SettingsOverlayBox extends Box {
	constructor(private readonly list: SettingsList) {
		super(1, 0);
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}
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
		SETTINGS_THEME,
		(id: string, value: string) => {
			const current = structuredClone(deps.getSettings());
			applySettingChange(current, id, value);
			deps.writeSettings(current);
			list.updateValue(id, value);
		},
		() => deps.onClose(),
	);
	const box = new SettingsOverlayBox(list);
	box.addChild(list);
	return tui.showOverlay(box, { anchor: "center", width: SETTINGS_OVERLAY_WIDTH });
}
