import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { settingsPath, validateSettings, withSettingsLock } from "../core/config.js";
import { DEFAULT_SETTINGS, DEFAULT_SETTINGS_YAML, SETTINGS_FILE_MODE } from "../core/defaults.js";
import { editTextExternally, resolveExternalEditor } from "../core/external-editor.js";
import { clioProjectRoot } from "../core/project-root.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../core/workspace-trust.js";
import { diffSettings } from "../domains/config/classify.js";

export type SettingsFileScope = "user" | "project";

export interface SettingsFileEditDeps {
	cwd: string;
	/** Hands the terminal to the editor and takes it back. */
	suspendTerminal: <T>(run: () => T) => T;
	notice: (level: "info" | "success" | "warning" | "error", text: string) => void;
	resolveEditor?: () => string | null;
	editExternally?: typeof editTextExternally;
}

function settingsFileFor(scope: SettingsFileScope, cwd: string): string {
	if (scope === "user") return settingsPath();
	return join(clioProjectRoot(cwd, "settings.yaml", "settings.local.yaml"), ".clio-coder", "settings.yaml");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Records merge and everything else replaces, the way a project layer sits over the defaults. */
function overlay(base: unknown, top: unknown): unknown {
	if (!isRecord(base) || !isRecord(top)) return top === undefined ? base : top;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(top)) out[key] = overlay(base[key], value);
	return out;
}

type Checked = { ok: true; settings: ReturnType<typeof validateSettings>["settings"] } | { ok: false; problem: string };

function check(scope: SettingsFileScope, text: string | null): Checked {
	let raw: unknown;
	try {
		raw = text === null ? undefined : parse(text);
	} catch (error) {
		return { ok: false, problem: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error) };
	}
	if (raw == null) raw = scope === "user" ? structuredClone(DEFAULT_SETTINGS) : {};
	if (!isRecord(raw)) return { ok: false, problem: "the file must be a YAML mapping of settings" };
	const candidate = scope === "user" ? raw : overlay(structuredClone(DEFAULT_SETTINGS), raw);
	const validated = validateSettings(candidate);
	const first = validated.issues[0];
	if (first) return { ok: false, problem: `${first.path ? `${first.path}: ` : ""}${first.message}` };
	return { ok: true, settings: validated.settings };
}

/**
 * Open a settings file in the operator's editor, check the draft on return,
 * and write it only when it validates. The config watcher applies what can
 * apply live; the notice says which changes wait for a restart.
 */
export function editSettingsFile(scope: SettingsFileScope, deps: SettingsFileEditDeps): void {
	const file = settingsFileFor(scope, deps.cwd);
	const editor = (deps.resolveEditor ?? resolveExternalEditor)();
	if (!editor) {
		deps.notice("info", `No editor is set (VISUAL or EDITOR). The settings file is ${file}`);
		return;
	}
	// Project settings load only while their trust digest matches. An edit to an
	// untrusted file would never apply, and an edit to a trusted one must carry
	// the trust forward or the whole project layer drops out on the next read.
	const trustBefore = scope === "project" ? captureProjectSurface(deps.cwd, "settings") : null;
	// A project with neither settings file has nothing to review; the re-pin after the save trusts what the operator wrote.
	const bothAbsent = trustBefore?.files.every((file) => file.text === null && file.error === undefined) === true;
	if (trustBefore && trustBefore.verdict !== "trusted" && !bothAbsent) {
		deps.notice(
			"warning",
			`Project settings are ${trustBefore.verdict} here, so an edit would not apply. Review them with clio-coder config trust settings first.`,
		);
		return;
	}
	const original = existsSync(file) ? readFileSync(file, "utf8") : null;
	const draft = original ?? (scope === "user" ? DEFAULT_SETTINGS_YAML : "");
	const result = deps.suspendTerminal(() => (deps.editExternally ?? editTextExternally)(draft, editor, ".yaml"));
	if (!result.ok || result.text === undefined) {
		deps.notice("error", `Settings file not changed: ${result.error ?? "the editor returned nothing"}`);
		return;
	}
	const next = `${result.text}\n`;
	if (next === original || (original === null && result.text === draft.replace(/\n$/, ""))) {
		deps.notice("info", `Settings file unchanged: ${file}`);
		return;
	}
	const checked = check(scope, next);
	if (!checked.ok) {
		deps.notice("error", `Settings file not saved, settings stay as they were: ${checked.problem}`);
		return;
	}
	const before = check(scope, original);
	try {
		withSettingsLock(() => {
			const current = existsSync(file) ? readFileSync(file, "utf8") : null;
			if (current !== original) throw new Error("the file changed while the editor was open; edit it again");
			if (trustBefore && captureProjectSurface(deps.cwd, "settings").contentHash !== trustBefore.contentHash) {
				throw new Error("project settings changed while the editor was open; edit it again");
			}
			mkdirSync(dirname(file), { recursive: true });
			safeResourceWrite(file, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE, backup: original !== null });
			if (trustBefore) {
				const after = captureProjectSurface(deps.cwd, "settings");
				if (!after.contentHash) throw new Error("project settings could not be read back after saving");
				recordProjectSurfaceTrust(deps.cwd, "settings", after.contentHash);
			}
		});
	} catch (error) {
		deps.notice("error", `Settings file not saved: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const diff = before.ok ? diffSettings(before.settings, checked.settings) : null;
	const live = diff ? diff.hotReload.length + diff.nextTurn.length : 0;
	const restart = diff?.restartRequired ?? [];
	const parts = [`Saved ${file}`];
	if (diff) parts.push(`${live === 1 ? "1 change applies" : `${live} changes apply`} now`);
	if (restart.length > 0) parts.push(`restart to apply: ${restart.join(", ")}`);
	deps.notice("success", parts.join(". "));
}
