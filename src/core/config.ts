/**
 * Settings read/validate/write. The config domain wraps this module with
 * watcher, hot-reload, and event emission. Kept in core/ because multiple
 * domains (providers, modes, prompts) need settings access before the domain
 * loader has finished booting.
 *
 * There is exactly one schema: the file on disk and the in-memory shape use
 * the same key names (`targets`, `orchestrator.target`, ...). Validation is
 * strict: unknown keys and type violations are errors carrying the exact key
 * path; there are no legacy readers, aliases, or migrations. Missing keys take
 * DEFAULT_SETTINGS values, which is well-defined because the file is
 * machine-owned and written whole.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
	ACTIVE_AGENT_AUTOMATION_ROLES,
	ACTIVE_ROUTING_POSTURES,
	ACTIVE_ROUTING_ROLES,
	DEFAULT_SETTINGS,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./defaults.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import { MAX_TIMER_DELAY_MS } from "./timers.js";
import { clioConfigDir, resolveClioDirs } from "./xdg.js";

export type ClioSettings = typeof DEFAULT_SETTINGS;

export function settingsPath(): string {
	return join(clioConfigDir(), "settings.yaml");
}

/**
 * What kind of failure produced a {@link SettingsIssue}. `"schema"` (the
 * default when the field is absent) means a key violates the one schema, so
 * the issue path names the key at fault. `"unreadable"` and `"syntax"` are
 * whole-file failures where no key is at fault and remedies that talk about
 * keys do not apply; they are kept apart because a permission error announced
 * as invalid YAML sends the operator after the wrong problem.
 */
export type SettingsIssueKind = "unreadable" | "syntax" | "schema";

export interface SettingsIssue {
	/** Dotted key path, e.g. `orchestrator.target` or `targets[2].runtime`. */
	path: string;
	message: string;
	kind?: SettingsIssueKind;
}

/**
 * The failure kind of an issue list. Only the first issue can be a file-level
 * failure: a read or a parse that fails returns exactly one issue and never
 * reaches the schema walk, so a mixed list is always schema issues.
 */
function issuesKind(issues: ReadonlyArray<SettingsIssue>): SettingsIssueKind {
	return issues[0]?.kind ?? "schema";
}

/**
 * The one action that repairs each failure kind, followed by the two commands
 * that are true for all of them. `clio-coder doctor --fix` is deliberately not the
 * first line: `--fix` creates missing structure and repairs credential
 * permissions, and initialization never reads or rewrites an existing
 * settings.yaml, so on its own it leaves every one of these failures exactly
 * as it found them.
 */
function settingsRemedy(kind: SettingsIssueKind, path: string): string {
	if (kind === "unreadable") return `Restore read access to ${path}, then run \`clio-coder doctor\` to re-check.`;
	if (kind === "syntax") return `Fix the YAML in ${path}, then run \`clio-coder doctor\` to re-check.`;
	return `Fix the keys above in ${path}, then run \`clio-coder doctor\` to re-check.`;
}

/** The same repair as {@link settingsRemedy}, phrased to sit inside one line's parentheses. */
function settingsRemedyInline(kind: SettingsIssueKind, path: string): string {
	if (kind === "unreadable") return `restore read access to ${path}`;
	if (kind === "syntax") return `fix the YAML in ${path}`;
	return `edit the named keys in ${path}`;
}

export class SettingsValidationError extends Error {
	readonly issues: ReadonlyArray<SettingsIssue>;

	/**
	 * The headline and the remedy both follow the failure kind. A file that
	 * cannot be read has no key at fault, so telling its reader to "fix the keys
	 * above" named a repair that does not exist for the problem they have.
	 */
	constructor(issues: ReadonlyArray<SettingsIssue>) {
		const path = join(resolveClioDirs().config, "settings.yaml");
		const kind = issuesKind(issues);
		// File-level issues all carry the same `(root)` path, which says nothing;
		// their message already names what failed.
		const lines =
			kind === "schema"
				? issues.map((issue) => `  ${issue.path}: ${issue.message}`)
				: issues.map((issue) => `  ${issue.message}`);
		const headline = kind === "schema" ? "settings.yaml failed validation:" : "settings.yaml cannot be loaded:";
		super(
			`${headline}\n${lines.join("\n")}\n\n` +
				`${settingsRemedy(kind, path)}\n` +
				"`clio-coder doctor --fix` repairs directories and credential permissions; it never rewrites settings.\n" +
				"To discard these settings and start from defaults instead, run `clio-coder reset --config --force`.",
		);
		this.name = "SettingsValidationError";
		this.issues = issues;
	}
}

function foldToOneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ").trim();
}

/**
 * The summary line of a YAML parse error, without the source excerpt it carries.
 *
 * The `yaml` package formats an error as a summary, then a blank line, then the
 * offending source, then a caret diagram. Folding all of that into one line
 * dragged the raw fragment into the middle of the notice, so a settings file
 * containing `\t\t: : :` reported "at line 1, column 1: : : : ^^", where the
 * tail reads as corruption of the message rather than a quote of the file. The
 * summary already names the line and the column, which is what locates the
 * fault; the excerpt is the operator's own file and they are being sent to it.
 *
 * The summary ends on the colon that introduced the excerpt, so dropping the
 * excerpt leaves it dangling in front of whatever follows.
 */
function yamlErrorSummary(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	return (raw.split("\n")[0] ?? raw).trim().replace(/:$/u, "");
}

/** The failure in three words, for a line whose tail may not survive clamping. */
function settingsFailureHeadline(kind: SettingsIssueKind): string {
	if (kind === "unreadable") return "settings.yaml cannot be read";
	if (kind === "syntax") return "settings.yaml is not valid YAML";
	return "settings.yaml failed validation";
}

/**
 * One operator-facing line for a settings file that will not load, carrying
 * the exact key paths for a schema failure and the remedy that fits whatever
 * actually failed. Doctor renders it as its settings row and the runtime
 * reload path renders it as a TUI notice, so both speak with one voice.
 *
 * Order is load-bearing: kind, then remedy, then detail. Both live surfaces
 * clamp this to the frame width with no way to expand it, so a line that ended
 * with the remedy ended with the only part the operator could act on cut off,
 * and every notice read as a complaint with no fix attached. Detail is last
 * because it is the part a clamp can afford to lose: the remedy already names
 * the file to go and look at.
 */
export function formatSettingsIssues(issues: ReadonlyArray<SettingsIssue>): string {
	if (issues.length === 0) return "";
	const path = join(resolveClioDirs().config, "settings.yaml");
	const kind = issuesKind(issues);
	// A file-level issue message repeats the kind because the thrown multi-line
	// error has no headline of its own. Here the headline says it already.
	const detail =
		kind === "schema"
			? issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
			: issues.map((issue) => issue.message.replace(/^(?:invalid YAML|unreadable): /u, "")).join("; ");
	const discard = "`clio-coder reset --config --force` to start from defaults";
	return foldToOneLine(
		`${settingsFailureHeadline(kind)}: ${settingsRemedyInline(kind, path)}, or ${discard}. ${detail}`,
	);
}

/**
 * {@link formatSettingsIssues} for a caught error, for callers that hold the
 * throw rather than the issue list.
 *
 * Live surfaces render this instead of the error object. Handing an error to
 * `console.error` inside a running TUI prints a `util.inspect` dump: the
 * `issues` array with its `\n` escapes, a stack trace naming a dist chunk, and
 * a YAML excerpt whose newlines walk straight over the live frame.
 */
export function formatSettingsFailure(error: unknown): string {
	if (error instanceof SettingsValidationError && error.issues.length > 0) return formatSettingsIssues(error.issues);
	return foldToOneLine(error instanceof Error ? error.message : String(error));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

class Issues {
	readonly list: SettingsIssue[] = [];

	add(path: string, message: string): void {
		this.list.push({ path, message });
	}

	unknownKeys(path: string, raw: Record<string, unknown>, known: ReadonlyArray<string>): void {
		const knownSet = new Set(known);
		for (const key of Object.keys(raw)) {
			if (!knownSet.has(key)) this.add(path ? `${path}.${key}` : key, "unknown key");
		}
	}
}

function expectString(issues: Issues, path: string, value: unknown): string | undefined {
	if (typeof value !== "string") {
		issues.add(path, `expected a string, got ${describe(value)}`);
		return undefined;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		issues.add(path, "expected a non-empty string");
		return undefined;
	}
	return trimmed;
}

function expectBoolean(issues: Issues, path: string, value: unknown): boolean | undefined {
	if (typeof value !== "boolean") {
		issues.add(path, `expected a boolean, got ${describe(value)}`);
		return undefined;
	}
	return value;
}

function expectNumber(
	issues: Issues,
	path: string,
	value: unknown,
	opts?: { min?: number; max?: number },
): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		issues.add(path, `expected a number, got ${describe(value)}`);
		return undefined;
	}
	if (opts?.min !== undefined && value < opts.min) {
		issues.add(path, `expected a number >= ${opts.min}, got ${value}`);
		return undefined;
	}
	if (opts?.max !== undefined && value > opts.max) {
		issues.add(path, `expected a number <= ${opts.max}, got ${value}`);
		return undefined;
	}
	return value;
}

function expectInteger(
	issues: Issues,
	path: string,
	value: unknown,
	opts?: { min?: number; max?: number },
): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		issues.add(path, `expected an integer, got ${describe(value)}`);
		return undefined;
	}
	if (opts?.min !== undefined && value < opts.min) {
		issues.add(path, `expected an integer >= ${opts.min}, got ${value}`);
		return undefined;
	}
	if (opts?.max !== undefined && value > opts.max) {
		issues.add(path, `expected an integer <= ${opts.max}, got ${value}`);
		return undefined;
	}
	return value;
}

function expectEnum<T extends string>(
	issues: Issues,
	path: string,
	value: unknown,
	allowed: ReadonlyArray<T>,
): T | undefined {
	if (typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)) return value as T;
	issues.add(path, `expected one of ${allowed.join(" | ")}, got ${describe(value)}`);
	return undefined;
}

function expectStringArray(issues: Issues, path: string, value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		issues.add(path, `expected a list of strings, got ${describe(value)}`);
		return undefined;
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (let i = 0; i < value.length; i += 1) {
		const entry = expectString(issues, `${path}[${i}]`, value[i]);
		if (entry === undefined) continue;
		if (seen.has(entry)) continue;
		seen.add(entry);
		out.push(entry);
	}
	return out;
}

function expectStringRecord(issues: Issues, path: string, value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a string map, got ${describe(value)}`);
		return undefined;
	}
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const entry = expectString(issues, `${path}.${key}`, raw);
		if (entry !== undefined) out[key] = entry;
	}
	return out;
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "a list";
	if (typeof value === "object") return "a map";
	if (typeof value === "string") return value.trim().length === 0 ? "an empty string" : JSON.stringify(value);
	return String(value);
}

const TOOL_CALL_FORMATS = ["openai", "anthropic", "hermes", "llama3-json", "mistral", "qwen", "xml"] as const;
const THINKING_FORMATS = [
	"qwen-chat-template",
	"openrouter",
	"zai",
	"anthropic-extended",
	"deepseek-r1",
	"openai-codex",
	"harmony",
] as const;
const STRUCTURED_OUTPUTS = ["json-schema", "gbnf", "xgrammar", "none"] as const;
const AUTONOMY_LEVELS = ["read-only", "suggest", "auto-edit", "full-auto"] as const;
const TOOL_GOVERNANCE = ["clio-policy", "agent-managed", "deny-all"] as const;

type TargetCapabilities = NonNullable<ClioSettings["targets"][number]["capabilities"]>;

function validateCapabilities(issues: Issues, path: string, value: unknown): TargetCapabilities | undefined {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, [
		"chat",
		"tools",
		"toolCallFormat",
		"reasoning",
		"thinkingFormat",
		"structuredOutputs",
		"vision",
		"audio",
		"embeddings",
		"rerank",
		"fim",
		"contextWindow",
		"maxTokens",
	]);
	const out: TargetCapabilities = {};
	for (const key of ["chat", "tools", "reasoning", "vision", "audio", "embeddings", "rerank", "fim"] as const) {
		if (key in value) {
			const v = expectBoolean(issues, `${path}.${key}`, value[key]);
			if (v !== undefined) out[key] = v;
		}
	}
	if ("toolCallFormat" in value) {
		const v = expectEnum(issues, `${path}.toolCallFormat`, value.toolCallFormat, TOOL_CALL_FORMATS);
		if (v !== undefined) out.toolCallFormat = v;
	}
	if ("thinkingFormat" in value) {
		const v = expectEnum(issues, `${path}.thinkingFormat`, value.thinkingFormat, THINKING_FORMATS);
		if (v !== undefined) out.thinkingFormat = v;
	}
	if ("structuredOutputs" in value) {
		const v = expectEnum(issues, `${path}.structuredOutputs`, value.structuredOutputs, STRUCTURED_OUTPUTS);
		if (v !== undefined) out.structuredOutputs = v;
	}
	if ("contextWindow" in value) {
		const v = expectInteger(issues, `${path}.contextWindow`, value.contextWindow, { min: 0 });
		if (v !== undefined) out.contextWindow = v;
	}
	if ("maxTokens" in value) {
		const v = expectInteger(issues, `${path}.maxTokens`, value.maxTokens, { min: 0 });
		if (v !== undefined) out.maxTokens = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validateAuth(
	issues: Issues,
	path: string,
	value: unknown,
): ClioSettings["targets"][number]["auth"] | undefined {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["apiKeyEnvVar", "apiKeyRef", "oauthProfile", "headers"]);
	const out: NonNullable<ClioSettings["targets"][number]["auth"]> = {};
	for (const key of ["apiKeyEnvVar", "apiKeyRef", "oauthProfile"] as const) {
		if (key in value) {
			const v = expectString(issues, `${path}.${key}`, value[key]);
			if (v !== undefined) out[key] = v;
		}
	}
	if ("headers" in value) {
		const v = expectStringRecord(issues, `${path}.headers`, value.headers);
		if (v !== undefined && Object.keys(v).length > 0) out.headers = v;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validatePricing(
	issues: Issues,
	path: string,
	value: unknown,
): ClioSettings["targets"][number]["pricing"] | undefined {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["input", "output", "cacheRead", "cacheWrite"]);
	const input = expectNumber(issues, `${path}.input`, value.input, { min: 0 });
	const output = expectNumber(issues, `${path}.output`, value.output, { min: 0 });
	if (input === undefined || output === undefined) return undefined;
	const out: NonNullable<ClioSettings["targets"][number]["pricing"]> = { input, output };
	if ("cacheRead" in value) {
		const v = expectNumber(issues, `${path}.cacheRead`, value.cacheRead, { min: 0 });
		if (v !== undefined) out.cacheRead = v;
	}
	if ("cacheWrite" in value) {
		const v = expectNumber(issues, `${path}.cacheWrite`, value.cacheWrite, { min: 0 });
		if (v !== undefined) out.cacheWrite = v;
	}
	return out;
}

function validateTarget(issues: Issues, path: string, value: unknown): ClioSettings["targets"][number] | null {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return null;
	}
	issues.unknownKeys(path, value, [
		"id",
		"runtime",
		"url",
		"auth",
		"defaultModel",
		"wireModels",
		"capabilities",
		"lifecycle",
		"gateway",
		"pricing",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const runtime = "runtime" in value ? expectString(issues, `${path}.runtime`, value.runtime) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("runtime" in value)) issues.add(`${path}.runtime`, "required");
	if (id === undefined || runtime === undefined) return null;
	const target: ClioSettings["targets"][number] = { id, runtime };
	if ("url" in value) {
		const v = expectString(issues, `${path}.url`, value.url);
		if (v !== undefined) target.url = v;
	}
	if ("auth" in value) {
		const v = validateAuth(issues, `${path}.auth`, value.auth);
		if (v !== undefined) target.auth = v;
	}
	if ("wireModels" in value) {
		const v = expectStringArray(issues, `${path}.wireModels`, value.wireModels);
		if (v !== undefined && v.length > 0) target.wireModels = v;
	}
	if ("defaultModel" in value) {
		const v = expectString(issues, `${path}.defaultModel`, value.defaultModel);
		if (v !== undefined) target.defaultModel = v;
	} else if (target.wireModels?.[0]) {
		target.defaultModel = target.wireModels[0];
	}
	if ("capabilities" in value) {
		const v = validateCapabilities(issues, `${path}.capabilities`, value.capabilities);
		if (v !== undefined) target.capabilities = v;
	}
	if ("lifecycle" in value) {
		const v = expectEnum(issues, `${path}.lifecycle`, value.lifecycle, ["user-managed", "clio-managed"] as const);
		if (v !== undefined) target.lifecycle = v;
	}
	if ("gateway" in value) {
		const v = expectBoolean(issues, `${path}.gateway`, value.gateway);
		if (v !== undefined) target.gateway = v;
	}
	if ("pricing" in value) {
		const v = validatePricing(issues, `${path}.pricing`, value.pricing);
		if (v !== undefined) target.pricing = v;
	}
	return target;
}

/**
 * Routing references (orchestrator/worker targets, scope, favorites) must
 * point at a configured target id. Dangling references are normalized away
 * deterministically rather than rejected: deleting a target must not brick
 * every session that still mentions it. This is referential normalization,
 * not a legacy reader; the key names themselves are never aliased.
 */
function validateWorkerTarget(
	issues: Issues,
	path: string,
	value: unknown,
	defaults: ClioSettings["orchestrator"],
	targets: ReadonlyArray<ClioSettings["targets"][number]>,
	options?: { nodeIds?: ReadonlySet<string> },
): ClioSettings["orchestrator"] & { node?: string } {
	const out: ClioSettings["orchestrator"] & { node?: string } = cloneValue(defaults);
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return out;
	}
	const allowNode = options?.nodeIds !== undefined;
	issues.unknownKeys(
		path,
		value,
		allowNode ? ["target", "model", "thinkingLevel", "node"] : ["target", "model", "thinkingLevel"],
	);
	if ("target" in value && value.target !== null) {
		const v = expectString(issues, `${path}.target`, value.target);
		if (v !== undefined) out.target = targets.some((entry) => entry.id === v) ? v : null;
	}
	if ("thinkingLevel" in value) {
		const v = expectEnum(issues, `${path}.thinkingLevel`, value.thinkingLevel, THINKING_LEVELS);
		if (v !== undefined) out.thinkingLevel = v;
	}
	if ("model" in value && value.model !== null) {
		const v = expectString(issues, `${path}.model`, value.model);
		if (v !== undefined) out.model = v;
	}
	// Node pins follow the target idiom: a pin naming a node that is not
	// configured (and is not the implicit local node) is dropped, not fatal.
	if (allowNode && "node" in value && value.node !== null) {
		const v = expectString(issues, `${path}.node`, value.node);
		if (v !== undefined) {
			const id = v.trim();
			if (id.length > 0 && (id === "local" || options?.nodeIds?.has(id) === true)) out.node = id;
		}
	}
	if (!out.target) {
		out.model = null;
	} else if (out.model === null) {
		out.model = targets.find((entry) => entry.id === out.target)?.defaultModel ?? null;
	}
	return out;
}

/** `targetId/wireModelId` refs filtered to configured target ids. */
function normalizeModelRefs(
	refs: ReadonlyArray<string>,
	targets: ReadonlyArray<ClioSettings["targets"][number]>,
): string[] {
	const byId = new Set(targets.map((target) => target.id));
	const out: string[] = [];
	for (const ref of refs) {
		const [targetId, ...modelParts] = ref.split("/");
		if (!targetId || !byId.has(targetId) || modelParts.length === 0) continue;
		const model = modelParts.join("/").trim();
		if (!model) continue;
		const normalized = `${targetId}/${model}`;
		if (!out.includes(normalized)) out.push(normalized);
	}
	return out;
}

/**
 * Scope entries: `targetId` or `targetId/wireModelId`, deduplicated. A ref
 * whose target is not configured is kept, not dropped: a renamed or
 * temporarily removed target is the common staleness case, and silently
 * deleting the operator's cycle set at load destroys a preference they never
 * asked to change. Disclosure belongs to the presentation layer, which lists
 * unresolvable refs under "Unavailable"; the consumers that must resolve a ref
 * (advanceScopedTarget) filter it themselves.
 */
function normalizeScope(refs: ReadonlyArray<string>): string[] {
	const out: string[] = [];
	for (const ref of refs) {
		const trimmed = ref.trim();
		const [targetId] = trimmed.split("/");
		if (!targetId) continue;
		if (!out.includes(trimmed)) out.push(trimmed);
	}
	return out;
}

function validateDelegationAgent(
	issues: Issues,
	path: string,
	value: unknown,
	defaults: ClioSettings["delegation"]["defaults"],
	seen: Set<string>,
): ClioSettings["delegation"]["agents"][number] | null {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return null;
	}
	issues.unknownKeys(path, value, [
		"id",
		"command",
		"args",
		"cwd",
		"env",
		"connectTimeoutMs",
		"turnTimeoutMs",
		"permissionTimeoutMs",
		"stallTimeoutMs",
		"toolGovernance",
		"projectContext",
		"labels",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const command = "command" in value ? expectString(issues, `${path}.command`, value.command) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("command" in value)) issues.add(`${path}.command`, "required");
	if (id === undefined || command === undefined) return null;
	if (id === "auto") {
		issues.add(`${path}.id`, "'auto' is reserved for coordinator-owned agent selection");
		return null;
	}
	if (seen.has(id)) {
		issues.add(`${path}.id`, `duplicate delegation agent id '${id}'`);
		return null;
	}
	seen.add(id);
	const agent: ClioSettings["delegation"]["agents"][number] = {
		id,
		command,
		args: [],
		connectTimeoutMs: defaults.connectTimeoutMs,
		turnTimeoutMs: defaults.turnTimeoutMs,
		permissionTimeoutMs: defaults.permissionTimeoutMs,
		toolGovernance: defaults.toolGovernance,
	};
	if ("args" in value) {
		const v = expectStringArray(issues, `${path}.args`, value.args);
		if (v !== undefined) agent.args = v;
	}
	for (const key of ["connectTimeoutMs", "turnTimeoutMs", "permissionTimeoutMs"] as const) {
		if (key in value) {
			const v = expectInteger(issues, `${path}.${key}`, value[key], { min: 1, max: MAX_TIMER_DELAY_MS });
			if (v !== undefined) agent[key] = v;
		}
	}
	if ("stallTimeoutMs" in value) {
		const v = expectInteger(issues, `${path}.stallTimeoutMs`, value.stallTimeoutMs);
		if (v !== undefined) agent.stallTimeoutMs = v;
	}
	if ("toolGovernance" in value) {
		const v = expectEnum(issues, `${path}.toolGovernance`, value.toolGovernance, TOOL_GOVERNANCE);
		if (v !== undefined) agent.toolGovernance = v;
	}
	if ("projectContext" in value) {
		const v = expectEnum(issues, `${path}.projectContext`, value.projectContext, ["none", "bounded"] as const);
		if (v !== undefined) agent.projectContext = v;
	}
	if ("cwd" in value) {
		const v = expectString(issues, `${path}.cwd`, value.cwd);
		if (v !== undefined) agent.cwd = v;
	}
	if ("env" in value) {
		const v = expectStringRecord(issues, `${path}.env`, value.env);
		if (v !== undefined && Object.keys(v).length > 0) agent.env = v;
	}
	if ("labels" in value) {
		const v = expectStringRecord(issues, `${path}.labels`, value.labels);
		if (v !== undefined && Object.keys(v).length > 0) agent.labels = v;
	}
	return agent;
}

function validateDelegation(issues: Issues, value: unknown): ClioSettings["delegation"] {
	const out = cloneValue(DEFAULT_SETTINGS.delegation);
	if (!isPlainObject(value)) {
		issues.add("delegation", `expected a map, got ${describe(value)}`);
		return out;
	}
	issues.unknownKeys("delegation", value, ["agents", "defaults"]);
	if ("defaults" in value) {
		if (!isPlainObject(value.defaults)) {
			issues.add("delegation.defaults", `expected a map, got ${describe(value.defaults)}`);
		} else {
			issues.unknownKeys("delegation.defaults", value.defaults, [
				"connectTimeoutMs",
				"turnTimeoutMs",
				"permissionTimeoutMs",
				"toolGovernance",
			]);
			for (const key of ["connectTimeoutMs", "turnTimeoutMs", "permissionTimeoutMs"] as const) {
				if (key in value.defaults) {
					const v = expectInteger(issues, `delegation.defaults.${key}`, value.defaults[key], {
						min: 1,
						max: MAX_TIMER_DELAY_MS,
					});
					if (v !== undefined) out.defaults[key] = v;
				}
			}
			if ("toolGovernance" in value.defaults) {
				const v = expectEnum(issues, "delegation.defaults.toolGovernance", value.defaults.toolGovernance, TOOL_GOVERNANCE);
				if (v !== undefined) out.defaults.toolGovernance = v;
			}
		}
	}
	if ("agents" in value) {
		if (!Array.isArray(value.agents)) {
			issues.add("delegation.agents", `expected a list, got ${describe(value.agents)}`);
		} else {
			const seen = new Set<string>();
			out.agents = value.agents
				.map((entry, i) => validateDelegationAgent(issues, `delegation.agents[${i}]`, entry, out.defaults, seen))
				.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
		}
	}
	return out;
}

type FleetNodeConfig = ClioSettings["fleet"]["nodes"][number];

function validateFleetNode(issues: Issues, path: string, value: unknown, seen: Set<string>): FleetNodeConfig | null {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return null;
	}
	issues.unknownKeys(path, value, [
		"id",
		"host",
		"user",
		"port",
		"identityFile",
		"clioEntry",
		"labels",
		"maxWorkers",
		"residency",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const host = "host" in value ? expectString(issues, `${path}.host`, value.host) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("host" in value)) issues.add(`${path}.host`, "required");
	if (id === undefined || host === undefined) return null;
	const trimmedId = id.trim();
	if (trimmedId.length === 0) {
		issues.add(`${path}.id`, "must not be blank");
		return null;
	}
	if (trimmedId === "local") {
		issues.add(`${path}.id`, "'local' is reserved for the implicit local node");
		return null;
	}
	if (seen.has(trimmedId)) {
		issues.add(`${path}.id`, `duplicate fleet node id '${trimmedId}'`);
		return null;
	}
	seen.add(trimmedId);
	const node: FleetNodeConfig = { id: trimmedId, host, maxWorkers: 2 };
	if ("user" in value) {
		const v = expectString(issues, `${path}.user`, value.user);
		if (v !== undefined) node.user = v;
	}
	if ("port" in value) {
		const v = expectInteger(issues, `${path}.port`, value.port, { min: 1 });
		if (v !== undefined) node.port = v;
	}
	if ("identityFile" in value) {
		const v = expectString(issues, `${path}.identityFile`, value.identityFile);
		if (v !== undefined) node.identityFile = v;
	}
	if ("clioEntry" in value) {
		const v = expectString(issues, `${path}.clioEntry`, value.clioEntry);
		if (v !== undefined) node.clioEntry = v;
	}
	if ("labels" in value) {
		const v = expectStringArray(issues, `${path}.labels`, value.labels);
		if (v !== undefined) node.labels = v;
	}
	if ("maxWorkers" in value) {
		const v = expectInteger(issues, `${path}.maxWorkers`, value.maxWorkers, { min: 1 });
		if (v !== undefined) node.maxWorkers = v;
	}
	if ("residency" in value) {
		const v = expectEnum(issues, `${path}.residency`, value.residency, ["observe", "manage"] as const);
		if (v !== undefined) node.residency = v;
	}
	return node;
}

function validateFleet(issues: Issues, value: unknown): ClioSettings["fleet"] {
	const out = cloneValue(DEFAULT_SETTINGS.fleet);
	if (!isPlainObject(value)) {
		issues.add("fleet", `expected a map, got ${describe(value)}`);
		return out;
	}
	issues.unknownKeys("fleet", value, ["nodes"]);
	if ("nodes" in value) {
		if (!Array.isArray(value.nodes)) {
			issues.add("fleet.nodes", `expected a list, got ${describe(value.nodes)}`);
		} else {
			const seen = new Set<string>();
			out.nodes = value.nodes
				.map((entry, i) => validateFleetNode(issues, `fleet.nodes[${i}]`, entry, seen))
				.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
		}
	}
	return out;
}

function validateMemorySettings(issues: Issues, value: unknown): ClioSettings["memory"] {
	const out = cloneValue(DEFAULT_SETTINGS.memory);
	if (!isPlainObject(value)) {
		issues.add("memory", `expected a map, got ${describe(value)}`);
		return out;
	}
	issues.unknownKeys("memory", value, ["intervention"]);
	if (!("intervention" in value)) return out;
	if (!isPlainObject(value.intervention)) {
		issues.add("memory.intervention", `expected a map, got ${describe(value.intervention)}`);
		return out;
	}
	const raw = value.intervention;
	issues.unknownKeys("memory.intervention", raw, ["enabled", "everyNTools", "windowSteps", "maxTokens", "timeoutMs"]);
	if ("enabled" in raw) {
		const enabled = expectBoolean(issues, "memory.intervention.enabled", raw.enabled);
		if (enabled !== undefined) out.intervention.enabled = enabled;
	}
	for (const key of ["everyNTools", "windowSteps", "maxTokens", "timeoutMs"] as const) {
		if (!(key in raw)) continue;
		const parsed = expectInteger(issues, `memory.intervention.${key}`, raw[key], {
			min: key === "everyNTools" ? 2 : 1,
		});
		if (parsed !== undefined) out.intervention[key] = parsed;
	}
	return out;
}

function validateKeybindings(issues: Issues, value: unknown): ClioSettings["keybindings"] {
	if (!isPlainObject(value)) {
		issues.add("keybindings", `expected a map, got ${describe(value)}`);
		return {};
	}
	const next: Record<string, string | string[]> = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const id = rawKey.trim();
		if (!id) {
			issues.add("keybindings", "empty keybinding id");
			continue;
		}
		if (typeof rawValue === "string") {
			const v = expectString(issues, `keybindings.${id}`, rawValue);
			if (v !== undefined) next[id] = v;
			continue;
		}
		if (Array.isArray(rawValue)) {
			const v = expectStringArray(issues, `keybindings.${id}`, rawValue);
			if (v !== undefined && v.length > 0) next[id] = v;
			continue;
		}
		issues.add(`keybindings.${id}`, `expected a string or list of strings, got ${describe(rawValue)}`);
	}
	return next;
}

const TOP_LEVEL_KEYS = [
	"version",
	"identity",
	"autonomy",
	"targets",
	"runtimePlugins",
	"orchestrator",
	"background",
	"memory",
	"workers",
	"fleet",
	"routing",
	"scope",
	"modelSelector",
	"budget",
	"defaults",
	"theme",
	"terminal",
	"skills",
	"delegation",
	"keybindings",
	"compaction",
	"retry",
	"guardrails",
] as const;

export interface SettingsValidationResult {
	settings: ClioSettings;
	issues: SettingsIssue[];
}

/**
 * Validate a parsed settings document against the one schema. Returns the
 * settings built from valid fields (defaults fill missing keys) plus every
 * issue found, each carrying the exact key path. Callers that must not
 * proceed on bad input use `readSettings`, which throws when issues exist;
 * doctor reports the same issues read-only.
 */
export function validateSettings(raw: unknown): SettingsValidationResult {
	const issues = new Issues();
	const settings = cloneValue(DEFAULT_SETTINGS);
	// A genuinely missing settings file falls back to defaults before ever
	// reaching here (validateSettingsFile returns early when the file is absent).
	// So a null/undefined raw here means a present-but-empty or `null` document,
	// which is malformed and must be a root-shape issue, not silent defaults.
	if (!isPlainObject(raw)) {
		issues.add("(root)", `expected a map, got ${describe(raw)}`);
		return { settings, issues: issues.list };
	}
	issues.unknownKeys("", raw, TOP_LEVEL_KEYS);

	if ("version" in raw && raw.version !== 1) {
		issues.add("version", `expected 1, got ${describe(raw.version)}`);
	}
	if ("identity" in raw) {
		const v = expectString(issues, "identity", raw.identity);
		if (v !== undefined) settings.identity = v;
	}
	if ("autonomy" in raw) {
		const v = expectEnum(issues, "autonomy", raw.autonomy, AUTONOMY_LEVELS);
		if (v !== undefined) settings.autonomy = v;
	}

	if ("targets" in raw) {
		if (!Array.isArray(raw.targets)) {
			issues.add("targets", `expected a list, got ${describe(raw.targets)}`);
		} else {
			const seen = new Set<string>();
			const out: ClioSettings["targets"] = [];
			for (let i = 0; i < raw.targets.length; i += 1) {
				const target = validateTarget(issues, `targets[${i}]`, raw.targets[i]);
				if (!target) continue;
				if (seen.has(target.id)) {
					issues.add(`targets[${i}].id`, `duplicate target id '${target.id}'`);
					continue;
				}
				seen.add(target.id);
				out.push(target);
			}
			settings.targets = out;
		}
	}

	if ("runtimePlugins" in raw) {
		const v = expectStringArray(issues, "runtimePlugins", raw.runtimePlugins);
		if (v !== undefined) settings.runtimePlugins = v;
	}

	if ("orchestrator" in raw) {
		settings.orchestrator = validateWorkerTarget(
			issues,
			"orchestrator",
			raw.orchestrator,
			settings.orchestrator,
			settings.targets,
		);
	}
	if ("background" in raw) {
		settings.background = validateWorkerTarget(
			issues,
			"background",
			raw.background,
			settings.background,
			settings.targets,
		);
	}
	if ("memory" in raw) settings.memory = validateMemorySettings(issues, raw.memory);

	// Fleet nodes validate before workers so profile node pins can be checked
	// against the configured node ids.
	if ("fleet" in raw) {
		settings.fleet = validateFleet(issues, raw.fleet);
	}
	const fleetNodeIds = new Set(settings.fleet.nodes.map((node) => node.id));

	if ("routing" in raw) {
		if (!isPlainObject(raw.routing)) {
			issues.add("routing", `expected a map, got ${describe(raw.routing)}`);
		} else {
			issues.unknownKeys("routing", raw.routing, ["activeRoles", "activePostures", "agentAutomation"]);
			const activeRoles = expectStringArray(issues, "routing.activeRoles", raw.routing.activeRoles);
			if (activeRoles !== undefined) {
				const allowed = new Set<string>(ACTIVE_ROUTING_ROLES);
				const rawRoles = raw.routing.activeRoles as unknown[];
				const stringRoles = rawRoles.filter((role): role is string => typeof role === "string");
				const complete = activeRoles.length === rawRoles.length;
				for (const role of activeRoles) {
					if (!allowed.has(role)) issues.add("routing.activeRoles", `unsupported active role '${role}'`);
				}
				if (new Set(stringRoles).size !== stringRoles.length) {
					issues.add("routing.activeRoles", "expected unique roles");
				}
				if (complete && activeRoles.every((role) => allowed.has(role))) {
					settings.routing.activeRoles = activeRoles as typeof settings.routing.activeRoles;
				}
			}
			const activePostures = expectStringArray(issues, "routing.activePostures", raw.routing.activePostures);
			if (activePostures !== undefined) {
				const allowed = new Set<string>(ACTIVE_ROUTING_POSTURES);
				const rawPostures = raw.routing.activePostures as unknown[];
				const stringPostures = rawPostures.filter((posture): posture is string => typeof posture === "string");
				const complete = activePostures.length === rawPostures.length;
				for (const posture of activePostures) {
					if (!allowed.has(posture)) issues.add("routing.activePostures", `unsupported active posture '${posture}'`);
				}
				if (new Set(stringPostures).size !== stringPostures.length) {
					issues.add("routing.activePostures", "expected unique postures");
				}
				if (complete && activePostures.every((posture) => allowed.has(posture))) {
					settings.routing.activePostures = activePostures as typeof settings.routing.activePostures;
				}
			}
			if (!isPlainObject(raw.routing.agentAutomation)) {
				issues.add("routing.agentAutomation", "expected a map");
			} else {
				const automation = raw.routing.agentAutomation;
				issues.unknownKeys("routing.agentAutomation", automation, ["activeAgentRoles"]);
				if (!Array.isArray(automation.activeAgentRoles)) {
					issues.add("routing.agentAutomation.activeAgentRoles", "expected a list");
				} else {
					const pairs: typeof settings.routing.agentAutomation.activeAgentRoles = [];
					const seen = new Set<string>();
					for (const [index, value] of automation.activeAgentRoles.entries()) {
						const path = `routing.agentAutomation.activeAgentRoles[${index}]`;
						if (!isPlainObject(value)) {
							issues.add(path, "expected a map");
							continue;
						}
						issues.unknownKeys(path, value, ["agentId", "executionRole"]);
						const agentId = expectString(issues, `${path}.agentId`, value.agentId);
						const executionRole = expectEnum(
							issues,
							`${path}.executionRole`,
							value.executionRole,
							ACTIVE_AGENT_AUTOMATION_ROLES,
						);
						if (agentId === "auto") {
							issues.add(`${path}.agentId`, "'auto' is reserved for coordinator-owned agent selection");
						}
						if (agentId === undefined || agentId === "auto" || executionRole === undefined) continue;
						const key = `${agentId}\u0000${executionRole}`;
						if (seen.has(key)) {
							issues.add(path, "duplicate agent and execution-role pair");
							continue;
						}
						seen.add(key);
						pairs.push({ agentId, executionRole });
					}
					if (pairs.length === automation.activeAgentRoles.length) {
						settings.routing.agentAutomation.activeAgentRoles = pairs;
					}
				}
			}
		}
	}

	if ("workers" in raw) {
		if (!isPlainObject(raw.workers)) {
			issues.add("workers", `expected a map, got ${describe(raw.workers)}`);
		} else {
			issues.unknownKeys("workers", raw.workers, [
				"default",
				"profiles",
				"agentBindings",
				"maxRetries",
				"onPermission",
				"escalation",
				"resilienceCooldownMs",
			]);
			if ("default" in raw.workers) {
				settings.workers.default = validateWorkerTarget(
					issues,
					"workers.default",
					raw.workers.default,
					settings.workers.default,
					settings.targets,
					{ nodeIds: fleetNodeIds },
				);
			}
			if ("profiles" in raw.workers) {
				if (!isPlainObject(raw.workers.profiles)) {
					issues.add("workers.profiles", `expected a map, got ${describe(raw.workers.profiles)}`);
				} else {
					const profiles: ClioSettings["workers"]["profiles"] = {};
					for (const [rawName, rawProfile] of Object.entries(raw.workers.profiles)) {
						const name = rawName.trim();
						if (!name) {
							issues.add("workers.profiles", "empty profile name");
							continue;
						}
						const profile = validateWorkerTarget(
							issues,
							`workers.profiles.${name}`,
							rawProfile,
							DEFAULT_SETTINGS.workers.default,
							settings.targets,
							{ nodeIds: fleetNodeIds },
						);
						if (!profile.target) continue;
						profiles[name] = profile;
					}
					settings.workers.profiles = profiles;
				}
			}
			if ("agentBindings" in raw.workers) {
				if (!isPlainObject(raw.workers.agentBindings)) {
					issues.add("workers.agentBindings", `expected a map, got ${describe(raw.workers.agentBindings)}`);
				} else {
					const agentBindings: ClioSettings["workers"]["agentBindings"] = {};
					for (const [rawAgentId, rawProfileName] of Object.entries(raw.workers.agentBindings)) {
						const agentId = rawAgentId.trim();
						if (!agentId) {
							issues.add("workers.agentBindings", "empty agent id");
							continue;
						}
						if (agentId === "auto") {
							issues.add("workers.agentBindings", "'auto' is reserved for coordinator-owned agent selection");
							continue;
						}
						const profileName = expectString(issues, `workers.agentBindings.${agentId}`, rawProfileName);
						if (profileName !== undefined) agentBindings[agentId] = profileName;
					}
					settings.workers.agentBindings = agentBindings;
				}
			}
			if ("maxRetries" in raw.workers) {
				const v = expectInteger(issues, "workers.maxRetries", raw.workers.maxRetries, { min: 0 });
				if (v !== undefined) settings.workers.maxRetries = v;
			}
			if ("onPermission" in raw.workers) {
				const v = expectEnum(issues, "workers.onPermission", raw.workers.onPermission, [
					"deny",
					"fail",
					"escalate",
				] as const);
				if (v !== undefined) settings.workers.onPermission = v;
			}
			if ("escalation" in raw.workers) {
				if (!isPlainObject(raw.workers.escalation)) {
					issues.add("workers.escalation", `expected a map, got ${describe(raw.workers.escalation)}`);
				} else {
					const base = settings.workers.escalation ?? DEFAULT_SETTINGS.workers.escalation;
					const escalation = { timeoutMs: base?.timeoutMs ?? 120000, fallback: base?.fallback ?? "deny" };
					issues.unknownKeys("workers.escalation", raw.workers.escalation, ["timeoutMs", "fallback"]);
					if ("timeoutMs" in raw.workers.escalation) {
						const v = expectInteger(issues, "workers.escalation.timeoutMs", raw.workers.escalation.timeoutMs, {
							min: 1,
						});
						if (v !== undefined) escalation.timeoutMs = v;
					}
					if ("fallback" in raw.workers.escalation) {
						const v = expectEnum(issues, "workers.escalation.fallback", raw.workers.escalation.fallback, [
							"deny",
							"fail",
						] as const);
						if (v !== undefined) escalation.fallback = v;
					}
					settings.workers.escalation = escalation;
				}
			}
			if ("resilienceCooldownMs" in raw.workers) {
				const v = expectInteger(issues, "workers.resilienceCooldownMs", raw.workers.resilienceCooldownMs, { min: 0 });
				if (v !== undefined) settings.workers.resilienceCooldownMs = v;
			}
		}
	}

	if ("scope" in raw) {
		const v = expectStringArray(issues, "scope", raw.scope);
		if (v !== undefined) settings.scope = normalizeScope(v);
	}

	if ("modelSelector" in raw) {
		if (!isPlainObject(raw.modelSelector)) {
			issues.add("modelSelector", `expected a map, got ${describe(raw.modelSelector)}`);
		} else {
			issues.unknownKeys("modelSelector", raw.modelSelector, ["favorites", "recentLimit"]);
			if ("favorites" in raw.modelSelector) {
				const v = expectStringArray(issues, "modelSelector.favorites", raw.modelSelector.favorites);
				if (v !== undefined) settings.modelSelector.favorites = normalizeModelRefs(v, settings.targets);
			}
			if ("recentLimit" in raw.modelSelector) {
				const v = expectInteger(issues, "modelSelector.recentLimit", raw.modelSelector.recentLimit, { min: 1 });
				if (v !== undefined) settings.modelSelector.recentLimit = v;
			}
		}
	}

	if ("budget" in raw) {
		if (!isPlainObject(raw.budget)) {
			issues.add("budget", `expected a map, got ${describe(raw.budget)}`);
		} else {
			issues.unknownKeys("budget", raw.budget, ["sessionCeilingUsd", "concurrency"]);
			if ("sessionCeilingUsd" in raw.budget) {
				const v = expectNumber(issues, "budget.sessionCeilingUsd", raw.budget.sessionCeilingUsd, { min: 0 });
				if (v !== undefined) settings.budget.sessionCeilingUsd = v;
			}
			if ("concurrency" in raw.budget) {
				if (raw.budget.concurrency === "auto") {
					settings.budget.concurrency = "auto";
				} else {
					const v = expectInteger(issues, "budget.concurrency", raw.budget.concurrency, { min: 1 });
					if (v !== undefined) settings.budget.concurrency = v;
				}
			}
		}
	}

	if ("defaults" in raw) {
		if (!isPlainObject(raw.defaults)) {
			issues.add("defaults", `expected a map, got ${describe(raw.defaults)}`);
		} else {
			issues.unknownKeys("defaults", raw.defaults, ["maxTokens"]);
			if ("maxTokens" in raw.defaults) {
				const v = expectInteger(issues, "defaults.maxTokens", raw.defaults.maxTokens, { min: 0 });
				if (v !== undefined) settings.defaults.maxTokens = v;
			}
		}
	}

	if ("theme" in raw) {
		const v = expectString(issues, "theme", raw.theme);
		if (v !== undefined) settings.theme = v;
	}

	if ("terminal" in raw) {
		if (!isPlainObject(raw.terminal)) {
			issues.add("terminal", `expected a map, got ${describe(raw.terminal)}`);
		} else {
			issues.unknownKeys("terminal", raw.terminal, ["showTerminalProgress", "outputVerbosity"]);
			if ("showTerminalProgress" in raw.terminal) {
				const v = expectBoolean(issues, "terminal.showTerminalProgress", raw.terminal.showTerminalProgress);
				if (v !== undefined) settings.terminal.showTerminalProgress = v;
			}
			if ("outputVerbosity" in raw.terminal) {
				const v = expectString(issues, "terminal.outputVerbosity", raw.terminal.outputVerbosity);
				if (v === "minimal" || v === "default" || v === "verbose") settings.terminal.outputVerbosity = v;
				else if (v !== undefined) issues.add("terminal.outputVerbosity", "expected minimal, default, or verbose");
			}
		}
	}

	if ("skills" in raw) {
		if (!isPlainObject(raw.skills)) {
			issues.add("skills", `expected a map, got ${describe(raw.skills)}`);
		} else {
			issues.unknownKeys("skills", raw.skills, ["trustProjectCompatRoots"]);
			if ("trustProjectCompatRoots" in raw.skills) {
				const v = expectBoolean(issues, "skills.trustProjectCompatRoots", raw.skills.trustProjectCompatRoots);
				if (v !== undefined) settings.skills.trustProjectCompatRoots = v;
			}
		}
	}

	if ("delegation" in raw) {
		settings.delegation = validateDelegation(issues, raw.delegation);
	}

	if ("keybindings" in raw) {
		settings.keybindings = validateKeybindings(issues, raw.keybindings);
	}

	if ("compaction" in raw) {
		if (!isPlainObject(raw.compaction)) {
			issues.add("compaction", `expected a map, got ${describe(raw.compaction)}`);
		} else {
			issues.unknownKeys("compaction", raw.compaction, ["auto", "threshold", "excludeLastTurns", "model", "systemPrompt"]);
			if ("auto" in raw.compaction) {
				const v = expectBoolean(issues, "compaction.auto", raw.compaction.auto);
				if (v !== undefined) settings.compaction.auto = v;
			}
			if ("threshold" in raw.compaction) {
				const v = expectNumber(issues, "compaction.threshold", raw.compaction.threshold, { min: 0, max: 1 });
				if (v !== undefined) settings.compaction.threshold = v;
			}
			if ("excludeLastTurns" in raw.compaction) {
				const v = expectInteger(issues, "compaction.excludeLastTurns", raw.compaction.excludeLastTurns, { min: 1 });
				if (v !== undefined) settings.compaction.excludeLastTurns = v;
			}
			if ("model" in raw.compaction) {
				const v = expectString(issues, "compaction.model", raw.compaction.model);
				if (v !== undefined) settings.compaction.model = v;
			}
			if ("systemPrompt" in raw.compaction) {
				const v = expectString(issues, "compaction.systemPrompt", raw.compaction.systemPrompt);
				if (v !== undefined) settings.compaction.systemPrompt = v;
			}
		}
	}

	if ("retry" in raw) {
		if (!isPlainObject(raw.retry)) {
			issues.add("retry", `expected a map, got ${describe(raw.retry)}`);
		} else {
			issues.unknownKeys("retry", raw.retry, ["enabled", "maxRetries", "baseDelayMs", "maxDelayMs", "streamStallMs"]);
			if ("enabled" in raw.retry) {
				const v = expectBoolean(issues, "retry.enabled", raw.retry.enabled);
				if (v !== undefined) settings.retry.enabled = v;
			}
			for (const key of ["maxRetries", "baseDelayMs", "maxDelayMs", "streamStallMs"] as const) {
				if (key in raw.retry) {
					const v = expectInteger(issues, `retry.${key}`, raw.retry[key], { min: 0 });
					if (v !== undefined) settings.retry[key] = v;
				}
			}
		}
	}

	if ("guardrails" in raw) {
		if (!isPlainObject(raw.guardrails)) {
			issues.add("guardrails", `expected a map, got ${describe(raw.guardrails)}`);
		} else {
			const keys = [
				"turnToolCallBudget",
				"workerToolCallCap",
				"maxDispatchRuns",
				"readMaxBytes",
				"observationTurnBudgetBytes",
				"internalDispatchTimeoutMs",
			] as const;
			issues.unknownKeys("guardrails", raw.guardrails, keys);
			for (const key of keys) {
				if (key in raw.guardrails) {
					const v = expectInteger(issues, `guardrails.${key}`, raw.guardrails[key], { min: 1 });
					if (v !== undefined) settings.guardrails[key] = v;
				}
			}
		}
	}

	return { settings, issues: issues.list };
}

/**
 * Validate the settings file on disk without throwing. Missing file is valid.
 * Resolves the path without the clioConfigDir mkdir side effect so read-only
 * surfaces (plain `clio-coder doctor`, readSettings on a fresh machine) never
 * create directories.
 */
export function validateSettingsFile(): SettingsValidationResult {
	const path = join(resolveClioDirs().config, "settings.yaml");
	if (!existsSync(path)) return { settings: cloneValue(DEFAULT_SETTINGS), issues: [] };
	// The read and the parse are separate steps because they fail for separate
	// reasons: folding them into one try reported `chmod 000` as invalid YAML,
	// which is a false statement about the file and points at the wrong repair.
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		return {
			settings: cloneValue(DEFAULT_SETTINGS),
			issues: [
				{ path: "(root)", message: `unreadable: ${err instanceof Error ? err.message : String(err)}`, kind: "unreadable" },
			],
		};
	}
	let parsed: unknown;
	try {
		parsed = parseYaml(text);
	} catch (err) {
		return {
			settings: cloneValue(DEFAULT_SETTINGS),
			issues: [{ path: "(root)", message: `invalid YAML: ${yamlErrorSummary(err)}`, kind: "syntax" }],
		};
	}
	return validateSettings(parsed);
}

export function readSettings(): ClioSettings {
	const result = validateSettingsFile();
	if (result.issues.length > 0) throw new SettingsValidationError(result.issues);
	return result.settings;
}

/**
 * Whole-file settings write via temp-file + rename. The rename is atomic on
 * POSIX, so a concurrent readSettings never observes a partially written
 * YAML document and readers never need the settings lock. Module-internal:
 * every mutation goes through updateSettings so there is exactly one writer
 * path and it always holds the lock.
 */
function persistSettings(document: unknown): void {
	safeResourceWrite(settingsPath(), stringifyYaml(document), { encoding: "utf8", mode: 0o644 });
}

/**
 * The saved document exactly as YAML parsed it, before defaults are merged in.
 * updateSettings patches this instead of the normalized blob, so the file only
 * ever gains what a mutation actually touched.
 */
function readSavedDocument(): unknown {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	try {
		return parseYaml(readFileSync(path, "utf8")) ?? {};
	} catch {
		return {};
	}
}

/**
 * Write the `before` → `after` delta of two normalized settings blobs onto the
 * raw saved document. Keys the mutation did not change keep their saved form
 * (or stay absent), so materialized defaults such as `workers.profiles: {}`
 * never leak into a file that never had them.
 */
function applySettingsDelta(saved: unknown, before: unknown, after: unknown): unknown {
	if (!isPlainObject(before) || !isPlainObject(after)) return cloneValue(after);
	const out: Record<string, unknown> = isPlainObject(saved) ? { ...saved } : {};
	for (const [key, next] of Object.entries(after)) {
		// Untouched keys keep whatever the file said, including saying nothing.
		if (deepEquals(before[key], next)) continue;
		out[key] = applySettingsDelta(out[key], before[key], next);
	}
	// A key the mutation removed from a map (a deleted worker profile) goes too.
	for (const key of Object.keys(out)) {
		if (!(key in after)) delete out[key];
	}
	return out;
}

function deepEquals(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((entry, index) => deepEquals(entry, b[index]));
	}
	if (!isPlainObject(a) || !isPlainObject(b)) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((key) => key in b && deepEquals(a[key], b[key]));
}

/**
 * Mutation applied to the freshest saved settings under the settings lock.
 * Mutate in place (return nothing) or return a replacement blob.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: in-place mutators legitimately return nothing, including named functions typed `: void`
export type SettingsMutator = (settings: ClioSettings) => ClioSettings | undefined | void;

export interface SettingsUpdateOptions {
	/** Total time to wait for the lock before giving up. Default 10s. */
	timeoutMs?: number;
}

export function settingsLockPath(): string {
	return `${settingsPath()}.lock`;
}

/**
 * Run `fn` while holding the settings.yaml advisory lock. Factored out of
 * updateSettings so the one other sanctioned settings writer (lifecycle
 * migrations, which rewrite pre-schema files the strict reader would reject)
 * holds the same lock instead of racing updateSettings.
 */
export function withSettingsLock<T>(fn: () => T, options: SettingsUpdateOptions = {}): T {
	return withStateFileLockSync(settingsPath(), fn, { timeoutMs: options.timeoutMs ?? 10_000 });
}

/**
 * Cross-process read-modify-write of settings.yaml under an advisory lock
 * file. Two processes doing naive read → mutate → write can interleave and
 * silently drop one of the writes; this helper re-reads the file *inside*
 * the lock, so the mutation always lands on the freshest saved state.
 * Readers never touch the lock; they only ever see complete files thanks to
 * the rename-based writer.
 *
 * The mutator may modify the settings in place or return a replacement blob.
 * The result is re-validated through the schema before it is persisted, so a
 * mutator cannot write an invalid document. Returns the persisted settings.
 */
export function updateSettings(mutate: SettingsMutator, options: SettingsUpdateOptions = {}): ClioSettings {
	return withSettingsLock(() => {
		const saved = readSavedDocument();
		const current = readSettings();
		// Snapshot before the mutator runs: in-place mutators alias `current`.
		const before = cloneValue(current);
		const next = mutate(current) ?? current;
		const revalidated = validateSettings(JSON.parse(JSON.stringify(next)));
		if (revalidated.issues.length > 0) throw new SettingsValidationError(revalidated.issues);
		persistSettings(applySettingsDelta(saved, before, revalidated.settings));
		return revalidated.settings;
	}, options);
}

/**
 * Settings mutations shared by the `clio-coder targets …` CLI (inside
 * updateSettings) and the settings overlay's Fleet and Targets rows (on the
 * effective view, committed per leaf). Registry-backed eligibility checks stay with the caller.
 */
export interface UseTargetOptions {
	model?: string;
	orchestratorModel?: string;
	workerModel?: string;
	workerTargetId?: string;
	backgroundModel?: string;
}

/** Route chat (and fleet dispatch, unless split) to `targetId`. Null when a named target is missing. */
export function useTargetInSettings(
	settings: ClioSettings,
	targetId: string,
	options: UseTargetOptions = {},
): { workerTargetId: string } | null {
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) return null;
	// A worker target of its own is the split topology; its model defaults to that node's own default.
	const workerTarget =
		options.workerTargetId !== undefined && options.workerTargetId !== target.id
			? settings.targets.find((entry) => entry.id === options.workerTargetId)
			: target;
	if (!workerTarget) return null;
	const sharedModel = options.model ?? target.defaultModel ?? null;
	settings.orchestrator.target = target.id;
	settings.orchestrator.model = options.orchestratorModel ?? sharedModel;
	settings.workers.default.target = workerTarget.id;
	settings.workers.default.model =
		options.workerModel ?? (workerTarget === target ? sharedModel : (workerTarget.defaultModel ?? null));
	if (options.backgroundModel !== undefined) {
		settings.background.target = target.id;
		settings.background.model = options.backgroundModel;
	}
	return { workerTargetId: workerTarget.id };
}

/** Drop a target and every routing field, profile, and scope entry that named it. */
export function removeTargetFromSettings(settings: ClioSettings, id: string): boolean {
	if (!settings.targets.some((entry) => entry.id === id)) return false;
	settings.targets = settings.targets.filter((entry) => entry.id !== id);
	if (settings.orchestrator.target === id) {
		settings.orchestrator.target = null;
		settings.orchestrator.model = null;
	}
	if (settings.background.target === id) {
		settings.background.target = null;
		settings.background.model = null;
	}
	if (settings.workers.default.target === id) {
		settings.workers.default.target = null;
		settings.workers.default.model = null;
	}
	for (const [name, profile] of Object.entries(settings.workers.profiles)) {
		if (profile.target === id) delete settings.workers.profiles[name];
	}
	settings.scope = settings.scope.filter((entry) => entry.split("/")[0] !== id);
	return true;
}

/** Create or repoint a fleet profile; the model rebases on the target default unless given. */
export function setFleetProfileInSettings(
	settings: ClioSettings,
	name: string,
	targetId: string,
	options: { model?: string; thinkingLevel?: ThinkingLevel } = {},
): boolean {
	const target = settings.targets.find((entry) => entry.id === targetId);
	if (!target) return false;
	const existing = settings.workers.profiles[name];
	settings.workers.profiles[name] = {
		target: target.id,
		model: options.model ?? target.defaultModel ?? null,
		thinkingLevel: options.thinkingLevel ?? existing?.thinkingLevel ?? "off",
	};
	return true;
}

/** Remove a fleet profile and its agent bindings; returns how many bindings went with it. */
export function removeFleetProfileFromSettings(settings: ClioSettings, name: string): number {
	delete settings.workers.profiles[name];
	let removedBindings = 0;
	for (const [agentId, profileName] of Object.entries(settings.workers.agentBindings)) {
		if (profileName !== name) continue;
		delete settings.workers.agentBindings[agentId];
		removedBindings += 1;
	}
	return removedBindings;
}

/** Bind a native agent to a profile. False for an ACP delegation agent, which ignores native routing. */
export function bindAgentProfileInSettings(settings: ClioSettings, agentId: string, profileName: string): boolean {
	if (settings.delegation.agents.some((agent) => agent.id === agentId)) return false;
	settings.workers.agentBindings[agentId] = profileName;
	return true;
}
