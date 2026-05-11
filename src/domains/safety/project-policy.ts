import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActionClass } from "./action-classifier.js";

export type ShellOperatorPolicy = "deny" | "allow";
export type EnvironmentPolicyMode = "none" | "allowlist";

export interface ProjectEnvironmentPolicy {
	mode: EnvironmentPolicyMode;
	allow: ReadonlyArray<string>;
}

export interface ProjectCommandPolicy {
	id: string;
	command: string;
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	actionClass: ActionClass;
	shellOperators: ShellOperatorPolicy;
	env: ProjectEnvironmentPolicy;
	requireConfirmation: boolean;
	rationale?: string;
	owner?: string;
	comment?: string;
}

export interface LoadedProjectSafetyPolicy {
	path: string | null;
	hash: string | null;
	valid: boolean;
	errors: ReadonlyArray<string>;
	commands: ReadonlyArray<ProjectCommandPolicy>;
}

const POLICY_RELATIVE_PATH = path.join(".clio", "safety.yaml");
const ACTION_CLASSES = new Set<ActionClass>([
	"read",
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
	"unknown",
]);
const ROOT_KEYS = new Set(["version", "commands", "tasks"]);
const COMMAND_KEYS = new Set([
	"id",
	"command",
	"cwd",
	"timeoutMs",
	"maxOutputBytes",
	"actionClass",
	"shellOperators",
	"env",
	"requireConfirmation",
	"rationale",
	"owner",
	"comment",
]);
const ENV_KEYS = new Set(["mode", "allow"]);
const ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/;

export function projectSafetyPolicyPath(cwd: string = process.cwd()): string | null {
	let cursor = path.resolve(cwd);
	while (true) {
		const candidate = path.join(cursor, POLICY_RELATIVE_PATH);
		if (existsSync(candidate)) return candidate;
		const parent = path.dirname(cursor);
		if (parent === cursor) return null;
		cursor = parent;
	}
}

export function loadProjectSafetyPolicy(cwd: string = process.cwd()): LoadedProjectSafetyPolicy {
	const policyPath = projectSafetyPolicyPath(cwd);
	if (policyPath === null) {
		return { path: null, hash: null, valid: true, errors: [], commands: [] };
	}
	let raw: string;
	try {
		raw = readFileSync(policyPath, "utf8");
	} catch (err) {
		return {
			path: policyPath,
			hash: null,
			valid: false,
			errors: [`cannot read project safety policy: ${err instanceof Error ? err.message : String(err)}`],
			commands: [],
		};
	}
	const hash = sha256(raw);
	try {
		const parsed = parseYaml(raw) as unknown;
		return validateProjectSafetyPolicy(parsed, policyPath, hash);
	} catch (err) {
		return {
			path: policyPath,
			hash,
			valid: false,
			errors: [`cannot parse project safety policy: ${err instanceof Error ? err.message : String(err)}`],
			commands: [],
		};
	}
}

function validateProjectSafetyPolicy(value: unknown, policyPath: string, hash: string): LoadedProjectSafetyPolicy {
	const errors: string[] = [];
	const commands: ProjectCommandPolicy[] = [];
	if (!isPlainRecord(value)) {
		return { path: policyPath, hash, valid: false, errors: ["policy root must be a mapping"], commands: [] };
	}
	for (const key of Object.keys(value)) {
		if (!ROOT_KEYS.has(key)) errors.push(`unknown root key '${key}'`);
	}
	if (value.version !== 1) errors.push("version must be 1");
	appendCommandPolicies(commands, errors, value.commands, "commands");
	appendCommandPolicies(commands, errors, value.tasks, "tasks");

	const ids = new Set<string>();
	for (const command of commands) {
		if (ids.has(command.id)) errors.push(`duplicate command id '${command.id}'`);
		ids.add(command.id);
	}

	return {
		path: policyPath,
		hash,
		valid: errors.length === 0,
		errors,
		commands: errors.length === 0 ? commands : [],
	};
}

function appendCommandPolicies(
	out: ProjectCommandPolicy[],
	errors: string[],
	value: unknown,
	field: "commands" | "tasks",
): void {
	if (value === undefined) return;
	if (!Array.isArray(value)) {
		errors.push(`${field} must be an array`);
		return;
	}
	for (let index = 0; index < value.length; index += 1) {
		const parsed = parseCommandPolicy(value[index], `${field}[${index}]`);
		if (parsed.errors.length > 0) {
			errors.push(...parsed.errors);
			continue;
		}
		if (parsed.command !== undefined) out.push(parsed.command);
	}
}

function parseCommandPolicy(
	value: unknown,
	label: string,
): { command: ProjectCommandPolicy; errors: [] } | { command?: undefined; errors: string[] } {
	const errors: string[] = [];
	if (!isPlainRecord(value)) return { errors: [`${label} must be a mapping`] };
	for (const key of Object.keys(value)) {
		if (!COMMAND_KEYS.has(key)) errors.push(`${label}: unknown key '${key}'`);
	}

	const id = stringField(value, "id", label, errors);
	const command = stringField(value, "command", label, errors);
	const cwd = optionalStringField(value, "cwd", label, errors);
	const timeoutMs = optionalPositiveInt(value, "timeoutMs", label, errors);
	const maxOutputBytes = optionalPositiveInt(value, "maxOutputBytes", label, errors);
	const actionClass = parseActionClass(value.actionClass, label, errors);
	const shellOperators = parseShellOperators(value.shellOperators, label, errors);
	const env = parseEnvPolicy(value.env, label, errors);
	const requireConfirmation =
		value.requireConfirmation === undefined ? false : booleanField(value, "requireConfirmation", label, errors);
	const rationale = optionalStringField(value, "rationale", label, errors);
	const owner = optionalStringField(value, "owner", label, errors);
	const comment = optionalStringField(value, "comment", label, errors);

	if (id && !ID_RE.test(id)) errors.push(`${label}.id must match ${ID_RE}`);
	if (command && command.trim().length === 0) errors.push(`${label}.command must not be empty`);
	if (cwd !== undefined && path.isAbsolute(cwd)) errors.push(`${label}.cwd must be relative to the policy root`);

	if (errors.length > 0 || id === undefined || command === undefined || actionClass === undefined || env === undefined) {
		return { errors };
	}

	const parsed: ProjectCommandPolicy = {
		id,
		command,
		actionClass,
		shellOperators,
		env,
		requireConfirmation,
	};
	if (cwd !== undefined) parsed.cwd = cwd;
	if (timeoutMs !== undefined) parsed.timeoutMs = timeoutMs;
	if (maxOutputBytes !== undefined) parsed.maxOutputBytes = maxOutputBytes;
	if (rationale !== undefined) parsed.rationale = rationale;
	if (owner !== undefined) parsed.owner = owner;
	if (comment !== undefined) parsed.comment = comment;
	return { command: parsed, errors: [] };
}

function parseActionClass(value: unknown, label: string, errors: string[]): ActionClass | undefined {
	if (typeof value !== "string") {
		errors.push(`${label}.actionClass must be a string`);
		return undefined;
	}
	if (!ACTION_CLASSES.has(value as ActionClass)) {
		errors.push(`${label}.actionClass is not supported: ${value}`);
		return undefined;
	}
	return value as ActionClass;
}

function parseShellOperators(value: unknown, label: string, errors: string[]): ShellOperatorPolicy {
	if (value === undefined) return "deny";
	if (value === "deny" || value === "allow") return value;
	errors.push(`${label}.shellOperators must be 'deny' or 'allow'`);
	return "deny";
}

function parseEnvPolicy(value: unknown, label: string, errors: string[]): ProjectEnvironmentPolicy | undefined {
	if (value === undefined) return { mode: "none", allow: [] };
	if (!isPlainRecord(value)) {
		errors.push(`${label}.env must be a mapping`);
		return undefined;
	}
	for (const key of Object.keys(value)) {
		if (!ENV_KEYS.has(key)) errors.push(`${label}.env: unknown key '${key}'`);
	}
	const mode = value.mode;
	if (mode !== "none" && mode !== "allowlist") {
		errors.push(`${label}.env.mode must be 'none' or 'allowlist'`);
		return undefined;
	}
	const allow = value.allow;
	if (allow === undefined) return { mode, allow: [] };
	if (!Array.isArray(allow) || allow.some((entry) => typeof entry !== "string" || entry.length === 0)) {
		errors.push(`${label}.env.allow must be an array of non-empty strings`);
		return undefined;
	}
	if (mode === "none" && allow.length > 0) {
		errors.push(`${label}.env.allow requires env.mode='allowlist'`);
		return undefined;
	}
	return { mode, allow: [...allow] };
}

function stringField(
	record: Record<string, unknown>,
	key: string,
	label: string,
	errors: string[],
): string | undefined {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		errors.push(`${label}.${key} must be a non-empty string`);
		return undefined;
	}
	return value;
}

function optionalStringField(
	record: Record<string, unknown>,
	key: string,
	label: string,
	errors: string[],
): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) {
		errors.push(`${label}.${key} must be a non-empty string when present`);
		return undefined;
	}
	return value;
}

function optionalPositiveInt(
	record: Record<string, unknown>,
	key: string,
	label: string,
	errors: string[],
): number | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		errors.push(`${label}.${key} must be a positive integer`);
		return undefined;
	}
	return value;
}

function booleanField(record: Record<string, unknown>, key: string, label: string, errors: string[]): boolean {
	const value = record[key];
	if (typeof value === "boolean") return value;
	errors.push(`${label}.${key} must be a boolean`);
	return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}
