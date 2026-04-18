import type { ClioSettings } from "../../core/config.js";
import {
	Box,
	type OverlayHandle,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	type TUI,
} from "../../engine/tui.js";

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
 * Phase 11 exposes the subset of settings whose values are safe to cycle
 * inline. Free-text fields (orchestrator.provider/model, workers.default.*,
 * provider.scope) render for read-only reference because editing them in
 * place needs either a picker (/model, /scoped-models) or text input the
 * overlay does not yet host.
 */
export function buildSettingItems(settings: Readonly<ClioSettings>): SettingItem[] {
	const scopeText = (settings.provider.scope ?? []).join(", ") || "(empty)";
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
			values: ["off", "minimal", "low", "medium", "high", "xhigh"],
			description: "Reasoning budget for the chat loop.",
		},
		{
			id: "orchestrator.provider",
			label: "orchestrator.provider",
			currentValue: settings.orchestrator.provider ?? "(unset)",
			description: "Active provider. Edit via /model.",
		},
		{
			id: "orchestrator.model",
			label: "orchestrator.model",
			currentValue: settings.orchestrator.model ?? "(unset)",
			description: "Active model id. Edit via /model.",
		},
		{
			id: "workers.default.provider",
			label: "workers.default.provider",
			currentValue: settings.workers.default.provider ?? "(unset)",
			description: "/run provider. Edit settings.yaml.",
		},
		{
			id: "workers.default.model",
			label: "workers.default.model",
			currentValue: settings.workers.default.model ?? "(unset)",
			description: "/run model id. Edit settings.yaml.",
		},
		{
			id: "budget.sessionCeilingUsd",
			label: "budget.sessionCeilingUsd",
			currentValue: String(settings.budget.sessionCeilingUsd),
			description: "Per-session cost cap. Edit settings.yaml.",
		},
		{
			id: "provider.scope",
			label: "provider.scope",
			currentValue: scopeText,
			description: "Ctrl+P cycle set. Edit via /scoped-models.",
		},
	];
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
	const items = buildSettingItems(deps.getSettings());
	const visible = Math.min(VISIBLE_ROWS, Math.max(1, items.length));
	const list = new SettingsList(
		items,
		visible,
		SETTINGS_THEME,
		(id: string, value: string) => {
			const current = deps.getSettings();
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
