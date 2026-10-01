import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { ActionClass } from "./action-classifier.js";
import type { FlowSourceRuleInput, FlowTargetBinding, InformationFlowPolicyInput } from "./information-flow.js";
import { EMPTY_INFORMATION_FLOW_INPUT, flowEndpointIdentity, isFlowRecipientRef } from "./information-flow.js";
import type { PathPolicyInput } from "./path-policy.js";

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
	trustVerdict?: "trusted" | "untrusted" | "changed";
	path: string | null;
	hash: string | null;
	valid: boolean;
	errors: ReadonlyArray<string>;
	commands: ReadonlyArray<ProjectCommandPolicy>;
	pathPolicy: PathPolicyInput;
	disableDefaultPathPolicy: boolean;
	/** Source rules and recipient groups; empty without the `informationFlow` section. */
	informationFlow: InformationFlowPolicyInput;
}

const POLICY_RELATIVE_PATH = path.join(".clio-coder", "safety.yaml");
// Includes "unknown" because safety.yaml policy schema parsing accepts unclassified commands as valid policy targets.
const ACTION_CLASSES = new Set<ActionClass>([
	"read",
	"write",
	"execute",
	"dispatch",
	"system_modify",
	"git_destructive",
	"unknown",
]);
const PATH_POLICY_KEYS = ["zeroAccessPaths", "readOnlyPaths", "noWritePaths", "noDeletePaths"] as const;
const ROOT_KEYS = new Set([
	"version",
	"commands",
	"tasks",
	"disableDefaultPathPolicy",
	"informationFlow",
	...PATH_POLICY_KEYS,
]);
const INFORMATION_FLOW_KEYS = new Set(["recipients", "targets", "sources"]);
const FLOW_TARGET_KEYS = new Set(["runtime", "endpoint"]);
const FLOW_SOURCE_KEYS = new Set(["id", "paths", "tools", "recipients"]);
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

function projectSafetyPolicyPath(cwd: string = process.cwd()): string | null {
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
	let policyPath = projectSafetyPolicyPath(cwd);
	if (policyPath === null) {
		return {
			path: null,
			hash: null,
			valid: true,
			errors: [],
			commands: [],
			pathPolicy: {},
			disableDefaultPathPolicy: false,
			informationFlow: EMPTY_INFORMATION_FLOW_INPUT,
		};
	}
	let raw: string;
	try {
		// Relative entries are interpreted against this source directory. Pin its
		// canonical identity before reading; downstream trust and compilation use
		// the captured path, not a symlink that may move after admission.
		policyPath = realpathSync(policyPath);
		raw = readFileSync(policyPath, "utf8");
	} catch (err) {
		return {
			path: policyPath,
			hash: null,
			valid: false,
			errors: [`cannot read project safety policy: ${err instanceof Error ? err.message : String(err)}`],
			commands: [],
			pathPolicy: {},
			disableDefaultPathPolicy: false,
			informationFlow: EMPTY_INFORMATION_FLOW_INPUT,
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
			pathPolicy: {},
			disableDefaultPathPolicy: false,
			informationFlow: EMPTY_INFORMATION_FLOW_INPUT,
		};
	}
}

function validateProjectSafetyPolicy(value: unknown, policyPath: string, hash: string): LoadedProjectSafetyPolicy {
	const errors: string[] = [];
	const commands: ProjectCommandPolicy[] = [];
	if (!isPlainRecord(value)) {
		return {
			path: policyPath,
			hash,
			valid: false,
			errors: ["policy root must be a mapping"],
			commands: [],
			pathPolicy: {},
			disableDefaultPathPolicy: false,
			informationFlow: EMPTY_INFORMATION_FLOW_INPUT,
		};
	}
	for (const key of Object.keys(value)) {
		if (!ROOT_KEYS.has(key)) errors.push(`unknown root key '${key}'`);
	}
	if (value.version !== 1) errors.push("version must be 1");
	appendCommandPolicies(commands, errors, value.commands, "commands");
	appendCommandPolicies(commands, errors, value.tasks, "tasks");
	const pathPolicy = parsePathPolicy(value, errors);
	const disableDefaultPathPolicy =
		value.disableDefaultPathPolicy === undefined
			? false
			: booleanField(value, "disableDefaultPathPolicy", "policy", errors);
	const informationFlow = parseInformationFlow(value.informationFlow, errors);

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
		pathPolicy: errors.length === 0 ? pathPolicy : {},
		disableDefaultPathPolicy: errors.length === 0 ? disableDefaultPathPolicy : false,
		informationFlow: errors.length === 0 ? informationFlow : EMPTY_INFORMATION_FLOW_INPUT,
	};
}

/**
 * `informationFlow.targets` pins each approvable inference target to one
 * runtime and one endpoint; `informationFlow.recipients` names groups of
 * exact destinations; `informationFlow.sources` lists the restricted sources
 * and who may receive their content. Paths follow the path-policy rules
 * (relative to the policy root, no escape, `*` patterns).
 */
function parseInformationFlow(value: unknown, errors: string[]): InformationFlowPolicyInput {
	if (value === undefined) return EMPTY_INFORMATION_FLOW_INPUT;
	if (!isPlainRecord(value)) {
		errors.push("informationFlow must be a mapping");
		return EMPTY_INFORMATION_FLOW_INPUT;
	}
	for (const key of Object.keys(value)) {
		if (!INFORMATION_FLOW_KEYS.has(key)) errors.push(`informationFlow: unknown key '${key}'`);
	}
	const groups: Record<string, string[]> = {};
	if (value.recipients !== undefined) {
		if (!isPlainRecord(value.recipients)) {
			errors.push("informationFlow.recipients must be a mapping of group name to recipient list");
		} else {
			for (const [name, members] of Object.entries(value.recipients)) {
				if (!ID_RE.test(name)) {
					errors.push(`informationFlow.recipients group '${name}' must match ${ID_RE}`);
					continue;
				}
				const parsed = parseRecipientList(members, `informationFlow.recipients.${name}`, errors);
				if (parsed !== undefined) groups[name] = parsed;
			}
		}
	}
	const targets: Record<string, FlowTargetBinding> = {};
	if (value.targets !== undefined) {
		if (!isPlainRecord(value.targets)) {
			errors.push("informationFlow.targets must be a mapping of target id to { runtime, endpoint }");
		} else {
			for (const [id, raw] of Object.entries(value.targets)) {
				const label = `informationFlow.targets.${id}`;
				if (!ID_RE.test(id)) {
					errors.push(`${label}: target id must match ${ID_RE}`);
					continue;
				}
				if (!isPlainRecord(raw)) {
					errors.push(`${label} must be a mapping`);
					continue;
				}
				for (const key of Object.keys(raw)) {
					if (!FLOW_TARGET_KEYS.has(key)) errors.push(`${label}: unknown key '${key}'`);
				}
				const runtime = stringField(raw, "runtime", label, errors);
				const endpoint = stringField(raw, "endpoint", label, errors);
				if (endpoint !== undefined && endpoint !== "none" && flowEndpointIdentity(endpoint) === null) {
					errors.push(`${label}.endpoint must be an absolute http(s) URL or 'none'`);
					continue;
				}
				if (runtime !== undefined && endpoint !== undefined) targets[id] = { runtime, endpoint };
			}
		}
	}
	const sources: FlowSourceRuleInput[] = [];
	if (value.sources !== undefined) {
		if (!Array.isArray(value.sources)) {
			errors.push("informationFlow.sources must be an array");
		} else {
			const ids = new Set<string>();
			for (let index = 0; index < value.sources.length; index += 1) {
				const rule = parseFlowSource(value.sources[index], `informationFlow.sources[${index}]`, errors);
				if (rule === undefined) continue;
				if (ids.has(rule.id)) errors.push(`duplicate informationFlow source id '${rule.id}'`);
				ids.add(rule.id);
				sources.push(rule);
			}
		}
	}
	const checkRefs = (refs: ReadonlyArray<string>, owner: string): void => {
		for (const ref of refs) {
			if (ref.startsWith("group:") && groups[ref.slice("group:".length)] === undefined) {
				errors.push(`${owner} names unknown recipient group '${ref}'`);
			}
			if (ref.startsWith("target:") && targets[ref.slice("target:".length)] === undefined) {
				errors.push(`${owner} names '${ref}' without an informationFlow.targets binding`);
			}
		}
	};
	for (const [name, members] of Object.entries(groups)) checkRefs(members, `informationFlow.recipients.${name}`);
	for (const rule of sources) checkRefs(rule.recipients, `informationFlow source '${rule.id}'`);
	return { groups, targets, sources };
}

function parseRecipientList(value: unknown, label: string, errors: string[]): string[] | undefined {
	if (!Array.isArray(value)) {
		errors.push(`${label} must be an array of recipient references`);
		return undefined;
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || !isFlowRecipientRef(item.trim())) {
			errors.push(
				`${label}[${index}] must be one of target:<id>, endpoint:<url>, origin:<scheme://host[:port]>, group:<name>`,
			);
			continue;
		}
		out.push(item.trim());
	}
	return out;
}

function parseFlowSource(value: unknown, label: string, errors: string[]): FlowSourceRuleInput | undefined {
	if (!isPlainRecord(value)) {
		errors.push(`${label} must be a mapping`);
		return undefined;
	}
	const before = errors.length;
	for (const key of Object.keys(value)) {
		if (!FLOW_SOURCE_KEYS.has(key)) errors.push(`${label}: unknown key '${key}'`);
	}
	const id = stringField(value, "id", label, errors);
	if (id !== undefined && !ID_RE.test(id)) errors.push(`${label}.id must match ${ID_RE}`);
	const paths = value.paths === undefined ? [] : parseRelativePathList(value.paths, `${label}.paths`, errors);
	const tools = value.tools === undefined ? [] : parseToolRefList(value.tools, `${label}.tools`, errors);
	if (value.recipients === undefined) errors.push(`${label}.recipients is required; use [] to forbid every transfer`);
	const recipients = value.recipients === undefined ? [] : parseRecipientList(value.recipients, `${label}.recipients`, errors);
	if (paths.length === 0 && tools.length === 0) errors.push(`${label} must name at least one path or tool`);
	if (errors.length > before || id === undefined || recipients === undefined) return undefined;
	return { id, paths, tools, recipients };
}

function parseRelativePathList(value: unknown, label: string, errors: string[]): string[] {
	if (!Array.isArray(value)) {
		errors.push(`${label} must be an array`);
		return [];
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		const entry = `${label}[${index}]`;
		if (typeof item !== "string" || item.trim().length === 0) {
			errors.push(`${entry} must be a non-empty string`);
			continue;
		}
		const trimmed = item.trim();
		if (path.isAbsolute(trimmed)) {
			errors.push(`${entry} must be relative to the policy root`);
			continue;
		}
		const segments = path.normalize(trimmed).split(path.sep).filter((segment) => segment.length > 0);
		if (segments.some((segment) => segment === "..")) {
			errors.push(`${entry} must not escape the policy root with '..'`);
			continue;
		}
		out.push(trimmed);
	}
	return out;
}

const TOOL_REF_RE = /^(?:[a-z][a-z0-9_]*|mcp:[a-z0-9][a-z0-9_-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)?)$/;

function parseToolRefList(value: unknown, label: string, errors: string[]): string[] {
	if (!Array.isArray(value)) {
		errors.push(`${label} must be an array`);
		return [];
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string" || !TOOL_REF_RE.test(item.trim())) {
			errors.push(`${label}[${index}] must be a tool name, mcp:<server>, or mcp:<server>/<tool>`);
			continue;
		}
		out.push(item.trim());
	}
	return out;
}

function parsePathPolicy(value: Record<string, unknown>, errors: string[]): PathPolicyInput {
	const out: PathPolicyInput = {};
	for (const key of PATH_POLICY_KEYS) {
		const parsed = parsePathList(value[key], key, errors);
		if (parsed !== undefined) out[key] = parsed;
	}
	return out;
}

function parsePathList(value: unknown, key: (typeof PATH_POLICY_KEYS)[number], errors: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		errors.push(`${key} must be an array`);
		return undefined;
	}
	const out: string[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		const label = `${key}[${index}]`;
		if (typeof item !== "string" || item.trim().length === 0) {
			errors.push(`${label} must be a non-empty string`);
			continue;
		}
		const trimmed = item.trim();
		if (path.isAbsolute(trimmed)) {
			errors.push(`${label} must be relative to the policy root`);
			continue;
		}
		const normalized = path.normalize(trimmed);
		const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);
		if (segments.some((segment) => segment === "..")) {
			errors.push(`${label} must not escape the policy root with '..'`);
			continue;
		}
		out.push(trimmed);
	}
	return out;
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
	if (cwd !== undefined) {
		if (path.isAbsolute(cwd)) {
			errors.push(`${label}.cwd must be relative to the policy root`);
		} else {
			const normalized = path.normalize(cwd);
			const segments = normalized.split(path.sep).filter((segment) => segment.length > 0);
			if (segments.some((segment) => segment === "..")) {
				errors.push(`${label}.cwd must not escape the policy root with '..'`);
			}
		}
	}

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
