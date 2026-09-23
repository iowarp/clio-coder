// Wording and grouping for the settings write surface. Pure, so it is testable without a browser.

import type { SettingControl } from "../../contracts/settings-controls.js";

/** The engine's own three sentences (`controlInstructions`), so the terminal and the app say the same words. */
export const TIMING_SENTENCE: Record<SettingControl["timing"], string> = {
	hotReload: "A running session can apply this immediately.",
	nextTurn: "Used by the next relevant request, dispatch, or explicit open.",
	restartRequired: "Takes effect in the next session.",
};
export const TIMING_LABEL: Record<SettingControl["timing"], string> = {
	hotReload: "Applies now",
	nextTurn: "Next request",
	restartRequired: "Next session",
};
const SOURCE: Record<SettingControl["source"], string> = {
	"built-in": "Default",
	user: "Your settings",
	project: "Project file",
	"project.local": "Local project file",
	cli: "Command line",
};
export const sourceLabel = (source: SettingControl["source"]) => SOURCE[source];

export function matchesControl(control: SettingControl, query: string): boolean {
	const needle = query.trim().toLocaleLowerCase("en-US");
	return (
		!needle ||
		[control.path, control.label, control.description, control.group]
			.join(" ")
			.toLocaleLowerCase("en-US")
			.includes(needle)
	);
}

/** Groups in first-seen order, which is the engine's registry order. */
export function groupControls(controls: SettingControl[]): Array<{ group: string; controls: SettingControl[] }> {
	const groups = new Map<string, SettingControl[]>();
	for (const control of controls) groups.set(control.group, [...(groups.get(control.group) ?? []), control]);
	return [...groups].map(([group, rows]) => ({ group, controls: rows }));
}

/** What an empty value means for this control, in the operator's words. */
export function emptyMeaning(control: SettingControl): string {
	if (control.kind === "list") return "None";
	return control.optional ? "Automatic" : "Not set";
}

/** The options of a select, or null when the control is free text. An optional select leads with its automatic choice. */
export function selectOptions(control: SettingControl): Array<{ value: string; label: string }> | null {
	if (control.kind === "boolean")
		return [
			{ value: "true", label: "On" },
			{ value: "false", label: "Off" },
		];
	const values = control.choices ?? (control.kind === "string" ? control.suggestions : undefined);
	if (!values) return null;
	const options = values.map((value) => ({ value, label: value }));
	// A saved value outside the known set stays selectable, so opening the page never rewrites it.
	if (control.value && !values.includes(control.value)) options.unshift({ value: control.value, label: control.value });
	return control.optional ? [{ value: "", label: emptyMeaning(control) }, ...options] : options;
}

/**
 * Controls whose value is one of a few words or an exact value only the operator knows. The engine
 * accepts these words (`src/core/settings-controls.ts`: `parseControlInput` for concurrency, the help
 * text for worktrees) but does not yet publish them as choices, so they are named here until it does.
 */
export interface OpenChoice {
	readonly words: readonly string[];
	/** The select's escape to an exact value, and the field it opens. */
	readonly other: { readonly label: string; readonly field: "whole-number" | "folder" };
}
export const OPEN_CHOICES: Readonly<Record<string, OpenChoice>> = {
	"fleet.concurrency": { words: ["auto"], other: { label: "A fixed number…", field: "whole-number" } },
	"fleet.worktrees.root": {
		words: ["auto", "disk", "tmpfs"],
		other: { label: "A folder you choose…", field: "folder" },
	},
};

/** Sentences for a completed write: the requested change first, then every side effect the engine applied. */
export function writtenSentences(
	changed: Array<{ path: string; value: string }>,
	controls: SettingControl[],
	requested: string,
): string[] {
	const label = (path: string) => controls.find((control) => control.path === path)?.label ?? path;
	if (!changed.length) return ["Nothing changed; the value was already in effect."];
	return changed.map(({ path, value }) =>
		path === requested
			? `Saved ${label(path)}.`
			: value
				? `This also set ${label(path)} to ${value}.`
				: `This also cleared ${label(path)}.`,
	);
}

/** The engine writes per-value help as fragments; the page shows them as sentences. */
export function sentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed) return "";
	const capital = `${trimmed[0]?.toLocaleUpperCase("en-US")}${trimmed.slice(1)}`;
	return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
