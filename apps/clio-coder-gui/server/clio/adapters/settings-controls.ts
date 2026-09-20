import { SettingsValidationError } from "../../../../../src/core/config.js";
import {
	applyControlValue,
	type SettingControl as RootControl,
	SETTING_CONTROLS,
	SETTINGS_LABELS_BY_ID,
	SETTINGS_VALUE_HELP_BY_ID,
	settingsV2PathForRow,
} from "../../../../../src/core/settings-controls.js";
import { readLayeredSettings, updateLayeredSettings } from "../../../../../src/core/settings-layers.js";
import {
	SETTINGS_SECTIONS,
	settingsGroupForPath,
	settingsSectionForPath,
} from "../../../../../src/core/settings-navigation.js";
import { settingsChangeKind } from "../../../../../src/domains/config/classify.js";
import { getRuntimeRegistry } from "../../../../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../../../../src/domains/providers/runtimes/builtins.js";
import type {
	SettingControl,
	SettingsControls,
	SettingWrite,
	SettingWritten,
} from "../../../contracts/settings-controls.js";
import { AppProblem } from "../../services/problem.js";

/**
 * The policy overlay on the engine's generated registry. Paths come from SETTING_CONTROLS, never from
 * this file, so a leaf added to the schema appears here on its own. This file only says which leaves
 * a browser must not show, must not edit, or may edit only after a named confirmation.
 */
const HIDDEN = [
	"interface.smoothStreaming",
	"interface.mode",
	"interface.fullscreenScrollbar",
	"interface.terminalProgress",
	"interface.panes.workers.ratio",
	"interface.panes.files.ratio",
	"interface.keybindings",
];
const READ_ONLY: Array<[prefix: string, reason: string]> = [
	[
		"context.compaction.systemPrompt",
		"This is a file path. It stays a terminal setting until the app has a file picker bounded to the workspace.",
	],
	[
		"integrations.library.catalog",
		"This is a file path. It stays a terminal setting until the app has a file picker bounded to the workspace.",
	],
	[
		"integrations.library.confirmedRemote",
		"Recorded only by the confirmation flow. Run clio-coder library remote confirm <url> in a terminal.",
	],
	[
		"interface.desktopNotifications",
		"This is the terminal's notification setting. The app keeps its own notification preference.",
	],
	[
		"interface.panes",
		"Terminal panes belong to the terminal session. The app shows the value and cannot observe the pane host.",
	],
];
const NOTES: Record<string, string> = {
	"safety.review.enabled":
		"Conversations in this app run over ACP, and headless and ACP runs never fire the review. This setting changes terminal sessions only.",
	"safety.review.target": "Used by terminal sessions only; ACP runs never fire the review.",
	"safety.review.cadenceToolCalls": "Used by terminal sessions only; ACP runs never fire the review.",
	"safety.autonomy":
		"This is the default for new sessions. A conversation that is already open keeps the autonomy it was bound to.",
	"safety.limits.sessionCostUsd": "The alert is informational. It never rejects a request.",
	"fleet.history.journal": "Turning this off blinds the run journal views in this app.",
	"chat.prewarm": "Applies to local native connections and interactive sessions only.",
	"integrations.library.remote":
		"Setting a remote does not enable sync. The remote must also be confirmed in a terminal.",
	"integrations.library.sync": "While this is off, library sync and push refuse before touching the network.",
};
const CONFIRM: Record<string, string> = {
	"fleet.history.maxRuns":
		"Runs that leave the history ring also lose their event journal directory. Lowering this deletes journals this app renders.",
	"integrations.projectResources.trustProjectImports":
		"Enabling this exposes this project's .claude/skills, .codex/skills and .github resource roots to the model.",
	"integrations.runtimePlugins":
		"These package names are loaded as code when the next session starts. Only name packages you trust.",
};
const STRUCTURED_REASON =
	"A structured collection. It needs a guided editor this app does not have yet; edit it with /settings in a terminal session.";

const hidden = (path: string) => HIDDEN.includes(path);
const readOnlyReason = (control: RootControl): string | undefined => {
	if (control.kind === "json") return STRUCTURED_REASON;
	return READ_ONLY.find(([prefix]) => control.path === prefix || control.path.startsWith(`${prefix}.`))?.[1];
};
const VALUE_HELP = new Map(
	Object.keys(SETTINGS_LABELS_BY_ID).map((id) => [settingsV2PathForRow(id), SETTINGS_VALUE_HELP_BY_ID[id] ?? {}]),
);

function at(root: unknown, path: string): unknown {
	let cursor = root;
	for (const part of path.split(".")) {
		if (!cursor || typeof cursor !== "object") return undefined;
		cursor = (cursor as Record<string, unknown>)[part];
	}
	return cursor;
}
/** The text form the engine parses. Structured collections cross as a size, never as content. */
function text(control: RootControl, value: unknown): string {
	if (value === undefined || value === null) return "";
	if (control.kind === "json") {
		const size = Array.isArray(value) ? value.length : Object.keys(value as object).length;
		return `${size} ${size === 1 ? "entry" : "entries"}`;
	}
	if (Array.isArray(value)) return value.map(String).join(", ");
	return String(value).slice(0, 4096);
}
function runtimes() {
	const registry = getRuntimeRegistry();
	if (registry.list().length === 0) registerBuiltinRuntimes(registry);
}

export function readSettingsControls(cwd: string): SettingsControls {
	const layered = readLayeredSettings(cwd);
	const targets = layered.settings.targets.map((target) => target.id);
	const controls = SETTING_CONTROLS.filter((control) => !hidden(control.path)).map((control): SettingControl => {
		// Exact leaf only: a parent object is also recorded as a source, and it does not set absent children.
		const source = layered.sources[control.path] ?? "built-in";
		// The write lands in the user layer, which a project or command-line value would silently override.
		const overridden =
			source === "project" || source === "project.local" || source === "cli"
				? `Set by the ${source} layer, which outranks your user settings. Change it there.`
				: undefined;
		const reason = readOnlyReason(control) ?? overridden;
		const suggestions = control.path.endsWith(".target")
			? targets
			: control.path === "fleet.default.node"
				? ["local", ...layered.settings.fleet.nodes.map((node) => node.id)]
				: undefined;
		return {
			path: control.path,
			section: settingsSectionForPath(control.path),
			group: settingsGroupForPath(control.path),
			label: control.label,
			description: control.description,
			...(control.help ? { help: control.help } : {}),
			valueHelp: VALUE_HELP.get(control.path) ?? {},
			kind: control.kind,
			...(control.choices ? { choices: [...control.choices] } : {}),
			...(suggestions ? { suggestions } : {}),
			optional: control.optional,
			timing: settingsChangeKind(control.path),
			value: text(control, at(layered.settings, control.path)),
			source,
			access: reason ? "read-only" : "writable",
			...(reason ? { reason } : {}),
			...(NOTES[control.path] ? { note: NOTES[control.path] } : {}),
			...(CONFIRM[control.path] && !reason ? { confirm: CONFIRM[control.path] } : {}),
		};
	});
	return {
		sections: SETTINGS_SECTIONS.filter((section) => controls.some((control) => control.section === section.id)).map(
			({ id, label, description }) => ({ id, label, description }),
		),
		controls,
		userFile: layered.layers.find((layer) => layer.origin === "user")?.path ?? "",
	};
}

export function writeSettingControl(cwd: string, write: SettingWrite): SettingWritten {
	runtimes();
	const before = readSettingsControls(cwd);
	const control = before.controls.find((candidate) => candidate.path === write.path);
	if (!control) throw new AppProblem("not_found", "This setting is not part of the app's settings surface.");
	if (control.access === "read-only")
		throw new AppProblem("unsupported", control.reason ?? "This setting is read-only here.");
	if (control.confirm && write.confirmed !== true)
		throw new AppProblem("validation", `This change needs confirmation. ${control.confirm}`);
	try {
		updateLayeredSettings(cwd, (settings) => applyControlValue(settings, write.path, write.value));
	} catch (error) {
		if (error instanceof SettingsValidationError)
			throw new AppProblem(
				"validation",
				error.issues
					.slice(0, 4)
					.map((issue) => `${issue.path}: ${issue.message}`)
					.join(" "),
			);
		const detail = error instanceof Error ? error.message : String(error);
		throw new AppProblem(/higher-precedence/.test(detail) ? "conflict" : "validation", detail.slice(0, 600));
	}
	const after = readSettingsControls(cwd);
	const previous = new Map(before.controls.map((candidate) => [candidate.path, candidate.value]));
	const changed = after.controls
		.filter((candidate) => previous.get(candidate.path) !== candidate.value)
		.map(({ path, value }) => ({ path, value }))
		.sort((a, b) => Number(b.path === write.path) - Number(a.path === write.path));
	return { changed, timing: control.timing, controls: after };
}
