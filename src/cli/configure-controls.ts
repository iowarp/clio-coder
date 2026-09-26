import {
	readSettings,
	SettingsValidationError,
	updateSavedSettingsDocument,
	validateSettings,
} from "../core/config.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { getAtPath } from "../core/session-routing.js";
import {
	applyControlValue,
	controlInstructions,
	formatControlValue,
	orderedSectionControls,
	type SettingControl,
} from "../core/settings-controls.js";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../core/settings-navigation.js";
import { diffSettings } from "../domains/config/classify.js";
import { ConfigureNavigation, type ConfigurePrompts } from "./configure-prompts.js";
import { createLifecyclePresenter } from "./lifecycle-presenter.js";

function editText(control: SettingControl, value: unknown): string {
	if (value === null || value === undefined) return "";
	return control.kind === "list"
		? (value as string[]).join(", ")
		: control.kind === "json"
			? JSON.stringify(value)
			: String(value);
}

/** Patch under the settings lock; route changes also clear their previous model override. */
export function saveControl(path: string, input: string): void {
	updateSavedSettingsDocument((saved) => {
		const before = validateSettings(saved).settings;
		const preview = structuredClone(before);
		applyControlValue(preview, path, input);
		const diff = diffSettings(before, preview);
		// Keep the explicit value even if it equals the resolved default, especially null inheritance.
		const paths = new Set([path, ...diff.hotReload, ...diff.nextTurn, ...diff.restartRequired]);
		// A whole-collection edit already contains its changed leaves.
		for (const changed of paths) {
			if (changed !== path && changed.startsWith(`${path}.`)) continue;
			let cursor = saved as Record<string, unknown>;
			const keys = changed.split(".");
			for (const key of keys.slice(0, -1)) {
				if (!cursor[key] || typeof cursor[key] !== "object") cursor[key] = {};
				cursor = cursor[key] as Record<string, unknown>;
			}
			const leaf = keys.at(-1) as string;
			const value = getAtPath(preview, changed);
			if (value === undefined) delete cursor[leaf];
			else cursor[leaf] = value;
		}
		const validation = validateSettings(saved);
		if (validation.issues.length) throw new SettingsValidationError(validation.issues);
		return saved;
	});
}

export { orderedSectionControls } from "../core/settings-controls.js";

/** Open one fully explained, validated global setting edit. */
export async function editSettingControl(prompts: ConfigurePrompts, control: SettingControl): Promise<boolean> {
	prompts.clearScreen();
	const presenter = createLifecyclePresenter({ stream: prompts.output });
	presenter.header(control.label, "configure");
	for (const line of controlInstructions(control).split("\n")) presenter.note(line);
	const current = getAtPath(readSettings(), control.path);
	presenter.fields([
		["Setting", control.path],
		["Current", formatControlValue(current)],
		["Shipped default", formatControlValue(getAtPath(DEFAULT_SETTINGS, control.path))],
		["Save scope", "Global default; current sessions follow their reload rules"],
	]);
	if (control.readOnly) {
		await prompts.text("Press Enter to return");
		return false;
	}
	const values = control.choices ?? (control.kind === "boolean" ? ["true", "false"] : undefined);
	const value = values
		? await prompts.choose("New value", values, String(current))
		: await prompts.text("New value", prompts.interactive ? editText(control, current) : "");
	const proposed = readSettings();
	applyControlValue(proposed, control.path, value);
	if ((await prompts.choose(`Save ${control.label} globally?`, ["Save", "Cancel"], "Save")) !== "Save") return false;
	saveControl(control.path, value);
	return true;
}

/** Legacy direct entry retained for callers; it now uses one complete list instead of a group drill-down. */
export async function runSectionControls(prompts: ConfigurePrompts, section: SettingsSectionId): Promise<void> {
	const entries = orderedSectionControls(section);
	const title = SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label ?? section;
	for (;;) {
		try {
			prompts.clearScreen();
			const presenter = createLifecyclePresenter({ stream: prompts.output });
			presenter.header(title, "configure");
			presenter.note("Every setting in this area is listed here. Choose one to see its meaning, default, and timing.");
			const labels = entries.map(({ group, control }) => `${group} · ${control.label}`);
			const chosen = await prompts.choose("Setting", [...labels, "Back"], labels[0] ?? "Back", true);
			if (chosen === "Back") return;
			const entry = entries[labels.indexOf(chosen)];
			if (!entry) continue;
			try {
				await editSettingControl(prompts, entry.control);
			} catch (error) {
				if (error instanceof ConfigureNavigation) {
					if (error.kind === "quit") throw error;
				} else presenter.warn(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
			}
		} catch (error) {
			if (error instanceof ConfigureNavigation && error.kind === "back") return;
			throw error;
		}
	}
}
