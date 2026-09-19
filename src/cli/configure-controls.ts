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
	SETTING_CONTROLS,
	type SettingControl,
} from "../core/settings-controls.js";
import {
	SETTINGS_SECTIONS,
	type SettingsSectionId,
	settingsGroupForPath,
	settingsSectionForPath,
} from "../core/settings-navigation.js";
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

/** A searchable, grouped editor shared with the TUI catalog. No raw whole-file edits are needed for these controls. */
export async function runSectionControls(prompts: ConfigurePrompts, section: SettingsSectionId): Promise<void> {
	const controls = SETTING_CONTROLS.filter((control) => settingsSectionForPath(control.path) === section);
	const groups = [...new Set(controls.map((control) => settingsGroupForPath(control.path)))];
	const title = SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label ?? section;
	let group = groups[0] ?? "";
	for (;;) {
		try {
			prompts.clearScreen();
			const presenter = createLifecyclePresenter({ stream: prompts.output });
			presenter.header(`${title} · All controls`, "configure");
			presenter.note(
				"Choose a group, then a setting. Each edit explains its effect and is validated before saving globally.",
			);
			group = await prompts.choose("Settings group", [...groups, "Back"], group, true);
			if (group === "Back") return;
			if (!groups.includes(group)) {
				presenter.warn("Choose a group from the list.");
				continue;
			}
			for (;;) {
				const members = controls.filter((control) => settingsGroupForPath(control.path) === group);
				const labels = members.map((control) => `${control.label} · ${control.path}`);
				let chosen: string;
				try {
					chosen = await prompts.choose(group, [...labels, "Back"], labels[0] ?? "Back", true);
				} catch (error) {
					if (error instanceof ConfigureNavigation && error.kind === "back") break;
					throw error;
				}
				if (chosen === "Back") break;
				const control = members[labels.indexOf(chosen)];
				if (!control) {
					presenter.warn("Choose a setting from the list.");
					continue;
				}
				try {
					prompts.clearScreen();
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
						continue;
					}
					const values = control.choices ?? (control.kind === "boolean" ? ["true", "false"] : undefined);
					const value = values
						? await prompts.choose("New value", values, String(current))
						: await prompts.text("New value", prompts.interactive ? editText(control, current) : "");
					const proposed = readSettings();
					applyControlValue(proposed, control.path, value);
					if ((await prompts.choose(`Save ${control.label} globally?`, ["Save", "Cancel"], "Save")) === "Save") {
						saveControl(control.path, value);
						presenter.completedStep(`${control.label} saved`);
					}
				} catch (error) {
					if (error instanceof ConfigureNavigation) {
						if (error.kind === "quit") throw error;
					} else presenter.warn(`Not saved: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		} catch (error) {
			if (error instanceof ConfigureNavigation && error.kind === "back") return;
			throw error;
		}
	}
}
