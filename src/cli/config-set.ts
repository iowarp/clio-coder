/**
 * `config get|set|unset`: one setting by its dotted path (CLI lane L8).
 *
 * Writable paths are the editor controls in `src/core/settings-controls.ts`;
 * the user scope saves through `updateSettings` (settings lock, re-read,
 * re-validate) and the project scope through the trusted project-local writer,
 * which approves the bytes it writes. Routing paths are refused with a pointer
 * to `targets use` and `configure`, which own target selection.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
	readSettings,
	SettingsValidationError,
	settingsPath,
	updateSavedSettingsDocument,
	updateSettings,
	validateSettings,
} from "../core/config.js";
import { clioProjectRoot } from "../core/project-root.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { getAtPath } from "../core/session-routing.js";
import { applyControlValue, type SettingControl, settingControl } from "../core/settings-controls.js";
import {
	readLayeredSettings,
	readStrictLayeredSettings,
	type SettingsOrigin,
	settingsSourceFor,
	settingsValueFor,
	updateProjectLocalSettings,
} from "../core/settings-layers.js";
import { StateFileLockTimeoutError, withStateFileLockSync } from "../core/state-file-lock.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../core/workspace-trust.js";
import { renderYamlPreservingLayout } from "../core/yaml-preserve.js";
import { EXIT_CODES } from "./kit/exit-codes.js";
import { parseCommandFlags } from "./kit/flags.js";
import { jsonDocument, writeCliFailure, writeJson } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

type Verb = "get" | "set" | "unset";
type Source = "default" | "user" | "project" | "project.local" | "cli";

const PROJECT_SETTINGS_FILES = ["settings.yaml", "settings.local.yaml"] as const;

/** A caller's mistake or a refused value: exit 2, nothing written. */
class SettingUsageError extends Error {}
/** The scope's file does not set the path: exit 1. */
class SettingNotFoundError extends Error {}

/** Routing has its own commands, which validate targets and clear stale model overrides together (review H20). */
function routingPointer(path: string): string | null {
	if (path === "targets" || path.startsWith("targets."))
		return "targets are created and edited with clio-coder configure";
	if (path === "fleet" || path.startsWith("fleet."))
		return "fleet routing is set with clio-coder targets use --fleet-target, clio-coder targets profile, or clio-coder configure";
	if (
		path === "chat.target" ||
		path === "chat.model" ||
		path === "context.memory.target" ||
		path === "context.memory.model"
	)
		return "routing is set with clio-coder targets use or clio-coder configure";
	return null;
}

function controlFor(path: string): SettingControl {
	const control = settingControl(path);
	if (control === undefined)
		throw new SettingUsageError(`no setting named ${path}; clio-coder config inspect lists the settings in effect`);
	return control;
}

/** The value text applyControlValue accepts, after the spec's type rules (enum, boolean, number, text, null). */
function valueText(control: SettingControl, raw: string): string {
	if (control.readOnly) throw new SettingUsageError(`${control.path} is recorded by its own confirmation flow`);
	if (control.kind === "list" || control.kind === "json")
		throw new SettingUsageError(
			`${control.path} is a ${control.kind === "list" ? "list" : "structured"} setting; edit it with clio-coder configure --settings or in the settings file`,
		);
	if (raw === "null") {
		if (!control.optional) throw new SettingUsageError(`${control.path} cannot be null`);
		return "";
	}
	if (control.choices !== undefined && !control.choices.includes(raw))
		throw new SettingUsageError(`${control.path} takes one of: ${control.choices.join(", ")}`);
	if (control.kind === "boolean" && raw !== "true" && raw !== "false")
		throw new SettingUsageError(`${control.path} takes true or false`);
	if (control.kind === "number" && (raw.trim() === "" || !Number.isFinite(Number(raw))))
		throw new SettingUsageError(`${control.path} takes a number`);
	if (control.kind === "string" && raw.trim() === "" && !control.optional)
		throw new SettingUsageError(`${control.path} cannot be empty`);
	return raw;
}

/** applyControlValue's own refusals (cross-field rules, schema issues) are about the value, not the file. */
function applyValue(settings: Parameters<typeof applyControlValue>[0], path: string, text: string): void {
	try {
		applyControlValue(settings, path, text);
	} catch (error) {
		throw new SettingUsageError(describe(error));
	}
}

function describe(error: unknown): string {
	if (error instanceof SettingsValidationError)
		return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
	return error instanceof Error ? error.message : String(error);
}

function parseDocument(text: string | null, file: string): Record<string, unknown> {
	if (text === null) return {};
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (error) {
		throw new Error(`${file} cannot be parsed: ${describe(error)}`);
	}
	if (parsed === null || parsed === undefined) return {};
	if (typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} does not hold a settings map`);
	return parsed as Record<string, unknown>;
}

function readUserDocument(): { file: string; document: Record<string, unknown> } {
	const file = settingsPath();
	let text: string | null = null;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return { file, document: parseDocument(text, file) };
}

/** Delete one leaf and any parent map it leaves empty. */
function deleteLeaf(document: Record<string, unknown>, path: string): boolean {
	const keys = path.split(".");
	const parents: Array<Record<string, unknown>> = [document];
	for (const key of keys.slice(0, -1)) {
		const next = (parents.at(-1) as Record<string, unknown>)[key];
		if (next === null || typeof next !== "object" || Array.isArray(next)) return false;
		parents.push(next as Record<string, unknown>);
	}
	const leaf = keys.at(-1) as string;
	const owner = parents.at(-1) as Record<string, unknown>;
	if (!Object.hasOwn(owner, leaf)) return false;
	delete owner[leaf];
	for (let depth = parents.length - 1; depth > 0; depth -= 1) {
		if (Object.keys(parents[depth] as Record<string, unknown>).length > 0) break;
		delete (parents[depth - 1] as Record<string, unknown>)[keys[depth - 1] as string];
	}
	return true;
}

function sourceOf(origin: SettingsOrigin): Source {
	return origin === "built-in" ? "default" : origin;
}

interface Reading {
	path: string;
	scope: "effective" | "user" | "project";
	value: unknown;
	source: Source;
	file?: string;
	trusted?: boolean;
}

/**
 * A user settings.yaml that fails validation is refused whole, so a value read from it or from the defaults that
 * replace it would misstate what runs (FX-47). The refusal names the file and its issues.
 */
class UserSettingsInvalidError extends Error {}

function refuseInvalidUser(file: string, issues: ReadonlyArray<{ path: string; message: string }>): never {
	const listed = issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
	throw new UserSettingsInvalidError(`${file} failed validation, so CLIO Coder reads none of it: ${listed}`);
}

function getEffective(path: string, cwd: string): Reading {
	let layered: ReturnType<typeof readLayeredSettings>;
	try {
		layered = readStrictLayeredSettings(cwd);
	} catch (error) {
		if (error instanceof SettingsValidationError) refuseInvalidUser(settingsPath(), error.issues);
		throw error;
	}
	const source = sourceOf(settingsSourceFor(layered.sources, path));
	const file = layered.layers.find((layer) => layer.origin === source)?.path;
	return {
		path,
		scope: "effective",
		value: getAtPath(layered.settings, path) ?? null,
		source,
		...(file !== undefined ? { file } : {}),
	};
}

function getUser(path: string): Reading {
	const { file, document } = readUserDocument();
	const issues = validateSettings(document).issues;
	if (issues.length > 0) refuseInvalidUser(file, issues);
	const value = settingsValueFor(document, path);
	if (value === undefined) throw new SettingNotFoundError(`${path} is not set in ${file}`);
	return { path, scope: "user", value, source: "user", file };
}

/** The project's own value, local file first as the layers apply it; untrusted bytes are reported, not applied. */
function getProject(path: string, cwd: string): Reading {
	const snapshot = captureProjectSurface(cwd, "settings");
	const trusted = snapshot.verdict === "trusted";
	const layers: Array<{ source: Source; index: number }> = [
		{ source: "project.local", index: 1 },
		{ source: "project", index: 0 },
	];
	for (const { source, index } of layers) {
		const captured = snapshot.files[index];
		if (captured === undefined || captured.text === null) continue;
		const value = settingsValueFor(parseDocument(captured.text, captured.path), path);
		if (value !== undefined) return { path, scope: "project", value, source, file: captured.path, trusted };
	}
	throw new SettingNotFoundError(`${path} is not set in this project's settings files`);
}

function setUser(path: string, text: string): string {
	// A damaged settings.yaml is the file's problem, not the value's: report it before the writer does.
	readSettings();
	updateSettings(
		(current) => {
			applyValue(current, path, text);
			return current;
		},
		{ pin: path },
	);
	return settingsPath();
}

function setProject(path: string, text: string, cwd: string): string {
	updateProjectLocalSettings(
		cwd,
		(current) => {
			applyValue(current, path, text);
			return current;
		},
		{ pin: path },
	);
	return join(clioProjectRoot(cwd, ...PROJECT_SETTINGS_FILES), ".clio-coder", "settings.local.yaml");
}

function unsetUser(path: string): string {
	updateSavedSettingsDocument((saved) => {
		const document = saved !== null && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
		if (!deleteLeaf(document as Record<string, unknown>, path))
			throw new SettingNotFoundError(`${path} is not set in ${settingsPath()}`);
		const validation = validateSettings(document);
		if (validation.issues.length > 0) throw new SettingsValidationError(validation.issues);
		return document;
	});
	return settingsPath();
}

/**
 * Remove a key from the project-local file under the project writer's lock and
 * guards: no symlinked path, an already trusted surface, the team file
 * unchanged across the write, and the exact bytes written approved after.
 */
function unsetProject(path: string, cwd: string): string {
	const configDir = join(clioProjectRoot(cwd, ...PROJECT_SETTINGS_FILES), ".clio-coder");
	const localFile = join(configDir, "settings.local.yaml");
	return withStateFileLockSync(localFile, () => {
		for (const candidate of [configDir, join(configDir, "settings.yaml"), localFile]) {
			try {
				if (lstatSync(candidate).isSymbolicLink()) throw new Error(`project settings path is a symlink: ${candidate}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		const before = captureProjectSurface(cwd, "settings");
		const local = before.files[1];
		if (local?.error !== undefined) throw new Error(`${localFile} cannot be read: ${local.error}`);
		const localText = local?.text ?? null;
		const document = parseDocument(localText, localFile);
		if (localText === null || !deleteLeaf(document, path)) {
			const team = before.files[0]?.text ?? null;
			const inTeam = team !== null && settingsValueFor(parseDocument(team, configDir), path) !== undefined;
			throw new SettingNotFoundError(
				inTeam
					? `${path} is set by the shared .clio-coder/settings.yaml, not by ${localFile}; edit that file to change it`
					: `${path} is not set in ${localFile}`,
			);
		}
		if (before.verdict !== "trusted")
			throw new Error(
				`project settings are ${before.verdict}; review with clio-coder config trust settings before saving`,
			);
		const bytes = renderYamlPreservingLayout(localText, document);
		safeResourceWrite(localFile, bytes, { mode: 0o600 });
		const after = captureProjectSurface(cwd, "settings");
		if (after.files[0]?.hash !== before.files[0]?.hash || after.files[1]?.text !== bytes || !after.contentHash)
			throw new Error("project settings changed while saving; review with clio-coder config trust settings");
		recordProjectSurfaceTrust(cwd, "settings", after.contentHash);
		return localFile;
	});
}

function renderValue(value: unknown): string {
	return JSON.stringify(value);
}

function failureOf(error: unknown): { slug: ErrorSlug; code: number } {
	if (error instanceof SettingUsageError) return { slug: "usage", code: EXIT_CODES.notStarted };
	if (error instanceof SettingNotFoundError) return { slug: "not_found", code: EXIT_CODES.failed };
	if (error instanceof UserSettingsInvalidError) return { slug: "not_configured", code: EXIT_CODES.failed };
	if (error instanceof StateFileLockTimeoutError) return { slug: "busy", code: EXIT_CODES.notReady };
	return { slug: "io", code: EXIT_CODES.failed };
}

const SCOPES: Readonly<Record<Verb, readonly string[]>> = {
	get: ["effective", "user", "project"],
	set: ["user", "project"],
	unset: ["user", "project"],
};

const ARITY: Readonly<Record<Verb, number>> = { get: 1, set: 2, unset: 1 };

export function runConfigSettingCommand(verb: Verb, args: ReadonlyArray<string>, cwd = process.cwd()): number {
	// A verb named like an Object.prototype member (toString, constructor) is an unknown subcommand, refused as
	// `config bogus` is, not looked up through the prototype.
	if (!Object.hasOwn(SCOPES, verb)) {
		writeCliFailure({ path: ["config"], slug: "unknown_command", message: `unknown subcommand: ${verb}`, json: false });
		return EXIT_CODES.notStarted;
	}
	const commandPath = ["config", verb];
	const jsonAsked = args.includes("--json");
	const usage = (message: string, slug: ErrorSlug = "usage"): number => {
		writeCliFailure({ path: commandPath, slug, message, json: jsonAsked });
		return EXIT_CODES.notStarted;
	};
	const parsed = parseCommandFlags(args, { json: { kind: "boolean" }, scope: { kind: "value" } });
	if (!parsed.ok) return usage(parsed.message, parsed.slug);
	const scope = parsed.flags.scope ?? (verb === "get" ? "effective" : "user");
	if (!SCOPES[verb].includes(scope)) return usage(`--scope takes ${SCOPES[verb].join(" or ")}`);
	const arity = ARITY[verb];
	if (parsed.positional.length !== arity) return usage(verb === "set" ? "expects <path> <value>" : "expects one <path>");
	const path = parsed.positional[0] as string;
	const json = parsed.flags.json === true;
	try {
		const control = controlFor(path);
		if (verb === "get") {
			const reading =
				scope === "user" ? getUser(path) : scope === "project" ? getProject(path, cwd) : getEffective(path, cwd);
			if (json) writeJson(process.stdout, jsonDocument(reading));
			else {
				const where = reading.file !== undefined ? `${reading.source}: ${reading.file}` : reading.source;
				const untrusted = reading.trusted === false ? ", untrusted and not applied" : "";
				process.stdout.write(`${path} = ${renderValue(reading.value)}  [${where}${untrusted}]\n`);
			}
			return EXIT_CODES.success;
		}
		const pointer = routingPointer(path);
		if (pointer !== null) throw new SettingUsageError(`${path} is routing; ${pointer}`);
		if (verb === "set") {
			const text = valueText(control, parsed.positional[1] as string);
			const file = scope === "project" ? setProject(path, text, cwd) : setUser(path, text);
			const value = getAtPath(scope === "project" ? readLayeredSettings(cwd).settings : readSettings(), path) ?? null;
			if (json) writeJson(process.stdout, jsonDocument({ path, scope, value, file }));
			else process.stdout.write(`Saved ${path} = ${renderValue(value)} in ${file}.\n`);
			return EXIT_CODES.success;
		}
		const file = scope === "project" ? unsetProject(path, cwd) : unsetUser(path);
		if (json) writeJson(process.stdout, jsonDocument({ path, scope, removed: true, file }));
		else process.stdout.write(`Removed ${path} from ${file}.\n`);
		return EXIT_CODES.success;
	} catch (error) {
		const failure = failureOf(error);
		writeCliFailure({ path: commandPath, slug: failure.slug, message: describe(error), json });
		return failure.code;
	}
}
