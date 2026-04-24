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
			id: "keybindings",
			label: "keybindings",
			currentValue: formatKeybindingsSummary(options?.keybindings),
			description: "Open /hotkeys to see bindings; edit settings.yaml > keybindings to override.",
		},
	];
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

/**
 * Pure mutation applied in-place. Only handles cycled enum values; every
 * other id is a read-only reference row today.
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
