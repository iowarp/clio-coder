/**
 * Settings read/validate/write. The config domain wraps this module with
 * watcher, hot-reload, and event emission. Kept in core/ because multiple
 * domains (providers, modes, prompts) need settings access before the domain
 * loader has finished booting.
 *
 * There is exactly one schema: the file on disk and the in-memory shape use
 * the same version-2 key names (`targets`, `chat.target`, ...). Validation is
 * strict: unknown keys and type violations are errors carrying the exact key
 * path. Version-1 paths are non-executing tombstones with migration hints;
 * lifecycle owns the one-time file migration. Missing keys take
 * DEFAULT_SETTINGS values.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
	ACTIVE_AGENT_AUTOMATION_ROLES,
	ACTIVE_ROUTING_POSTURES,
	ACTIVE_ROUTING_ROLES,
	COUNCIL_MEMBER_LABEL_PATTERN,
	DEFAULT_SETTINGS,
	THEME_NAMED_COLORS,
	THINKING_LEVELS,
	type ThinkingLevel,
} from "./defaults.js";
import { warnLegacyNaming } from "./naming-compat.js";
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
	/** Dotted key path, e.g. `chat.target` or `targets[2].runtime`. */
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

	/**
	 * A key that used to be honored and is not any more. `unknown key` is the
	 * true answer for a typo and the wrong one here: the operator wrote a real
	 * key that a real release read, and the useful thing to tell them is what
	 * replaced it, not that the schema has never heard of it. The keys stay
	 * listed as known at their {@link unknownKeys} call so this message is the
	 * one that lands.
	 */
	retiredKeys(path: string, raw: Record<string, unknown>, retired: Readonly<Record<string, string>>): void {
		for (const [key, because] of Object.entries(retired)) {
			if (key in raw) this.add(path ? `${path}.${key}` : key, `retired: ${because}. Remove this key.`);
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
const TOOL_GOVERNANCE = ["clio-coder-policy", "agent-managed", "deny-all"] as const;

function normalizeLegacyNamingValue(value: unknown, legacy: string, canonical: string): unknown {
	if (value !== legacy) return value;
	warnLegacyNaming(legacy, canonical);
	return canonical;
}

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

function validateLmStudioSettings(
	issues: Issues,
	path: string,
	value: unknown,
): ClioSettings["targets"][number]["lmstudio"] | undefined {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["load", "request"]);
	const out: NonNullable<ClioSettings["targets"][number]["lmstudio"]> = {};
	if ("load" in value) {
		if (!isPlainObject(value.load)) {
			issues.add(`${path}.load`, `expected a map, got ${describe(value.load)}`);
		} else {
			issues.unknownKeys(`${path}.load`, value.load, [
				"contextLength",
				"flashAttention",
				"evalBatchSize",
				"numExperts",
				"offloadKvCacheToGpu",
			]);
			const load: NonNullable<typeof out.load> = {};
			for (const key of ["contextLength", "evalBatchSize", "numExperts"] as const) {
				if (key in value.load) {
					const parsed = expectInteger(issues, `${path}.load.${key}`, value.load[key], { min: 1 });
					if (parsed !== undefined) load[key] = parsed;
				}
			}
			for (const key of ["flashAttention", "offloadKvCacheToGpu"] as const) {
				if (key in value.load) {
					const parsed = expectBoolean(issues, `${path}.load.${key}`, value.load[key]);
					if (parsed !== undefined) load[key] = parsed;
				}
			}
			if (Object.keys(load).length > 0) out.load = load;
		}
	}
	if ("request" in value) {
		if (!isPlainObject(value.request)) {
			issues.add(`${path}.request`, `expected a map, got ${describe(value.request)}`);
		} else {
			issues.unknownKeys(`${path}.request`, value.request, ["ttlSeconds", "draftModel", "reasoning"]);
			const request: NonNullable<typeof out.request> = {};
			if ("ttlSeconds" in value.request) {
				const parsed = expectInteger(issues, `${path}.request.ttlSeconds`, value.request.ttlSeconds, { min: 1 });
				if (parsed !== undefined) request.ttlSeconds = parsed;
			}
			if ("draftModel" in value.request) {
				const parsed = expectString(issues, `${path}.request.draftModel`, value.request.draftModel);
				if (parsed !== undefined) request.draftModel = parsed;
			}
			if ("reasoning" in value.request) {
				const parsed = expectEnum(issues, `${path}.request.reasoning`, value.request.reasoning, [
					"auto",
					"off",
					"on",
					"low",
					"medium",
					"high",
				] as const);
				if (parsed !== undefined) request.reasoning = parsed;
			}
			if (Object.keys(request).length > 0) out.request = request;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function validateLiteLLMSettings(
	issues: Issues,
	path: string,
	value: unknown,
): ClioSettings["targets"][number]["litellm"] | undefined {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return undefined;
	}
	issues.unknownKeys(path, value, ["request"]);
	const out: NonNullable<ClioSettings["targets"][number]["litellm"]> = {};
	if ("request" in value) {
		if (!isPlainObject(value.request)) {
			issues.add(`${path}.request`, `expected a map, got ${describe(value.request)}`);
		} else {
			issues.unknownKeys(`${path}.request`, value.request, [
				"tags",
				"sendSessionId",
				"timeoutSeconds",
				"streamTimeoutSeconds",
				"numRetries",
			]);
			const request: NonNullable<typeof out.request> = {};
			if ("tags" in value.request) {
				const parsed = expectStringArray(issues, `${path}.request.tags`, value.request.tags);
				if (parsed !== undefined) {
					const invalidTag = parsed.find((tag) => tag.includes(","));
					if (invalidTag) issues.add(`${path}.request.tags`, "tags may not contain commas");
					else if (parsed.length > 0) request.tags = [...new Set(parsed)];
				}
			}
			if ("sendSessionId" in value.request) {
				const parsed = expectBoolean(issues, `${path}.request.sendSessionId`, value.request.sendSessionId);
				if (parsed !== undefined) request.sendSessionId = parsed;
			}
			for (const key of ["timeoutSeconds", "streamTimeoutSeconds"] as const) {
				if (key in value.request) {
					const parsed = expectNumber(issues, `${path}.request.${key}`, value.request[key], { min: 0.001, max: 86_400 });
					if (parsed !== undefined) request[key] = parsed;
				}
			}
			if ("numRetries" in value.request) {
				const parsed = expectInteger(issues, `${path}.request.numRetries`, value.request.numRetries, { min: 0, max: 100 });
				if (parsed !== undefined) request.numRetries = parsed;
			}
			if (Object.keys(request).length > 0) out.request = request;
		}
	}
	return Object.keys(out).length > 0 ? out : undefined;
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
		"lmstudio",
		"litellm",
		"maxConcurrentRequests",
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
		const v = expectEnum(
			issues,
			`${path}.lifecycle`,
			normalizeLegacyNamingValue(value.lifecycle, "clio-managed", "clio-coder-managed"),
			["user-managed", "clio-coder-managed"] as const,
		);
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
	if ("lmstudio" in value) {
		const v = validateLmStudioSettings(issues, `${path}.lmstudio`, value.lmstudio);
		if (v !== undefined) target.lmstudio = v;
	}
	if ("litellm" in value) {
		const v = validateLiteLLMSettings(issues, `${path}.litellm`, value.litellm);
		if (v !== undefined) target.litellm = v;
	}
	if ("maxConcurrentRequests" in value) {
		const v = expectInteger(issues, `${path}.maxConcurrentRequests`, value.maxConcurrentRequests, { min: 1 });
		if (v !== undefined) target.maxConcurrentRequests = v;
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
type FleetRoute = ClioSettings["fleet"]["default"];
type ExternalAgentDefaults = ClioSettings["integrations"]["externalAgents"]["defaults"];
type ExternalAgent = ClioSettings["integrations"]["externalAgents"]["entries"][number];
type FleetNodeConfig = ClioSettings["fleet"]["nodes"][number];

/**
 * Complete durable path manifest for the settings-v1 to settings-v2 rename.
 * `*` denotes a map key and `[]` denotes a list element. Values are copied
 * without reinterpretation unless a separate retired-path entry says they are
 * deliberately dropped.
 */
export const SETTINGS_V1_PATH_MOVES = Object.freeze([
	["autonomy", "safety.autonomy"],
	["orchestrator.target", "chat.target"],
	["orchestrator.model", "chat.model"],
	["orchestrator.thinkingLevel", "chat.thinkingLevel"],
	["scope[]", "chat.modelPicker.cycleSet[]"],
	["modelSelector.favorites[]", "chat.modelPicker.favorites[]"],
	["modelSelector.recentLimit", "chat.modelPicker.recentLimit"],
	["defaults.maxTokens", "chat.maxOutputTokens"],
	["prewarm.enabled", "chat.prewarm"],
	["retry.enabled", "chat.retry.enabled"],
	["retry.maxRetries", "chat.retry.maxRetries"],
	["retry.baseDelayMs", "chat.retry.baseDelayMs"],
	["retry.maxDelayMs", "chat.retry.maxDelayMs"],
	["retry.streamStallMs", "chat.retry.streamStallMs"],
	["workers.default.target", "fleet.default.target"],
	["workers.default.model", "fleet.default.model"],
	["workers.default.thinkingLevel", "fleet.default.thinkingLevel"],
	["workers.default.node", "fleet.default.node"],
	["workers.profiles.*.target", "fleet.profiles.*.target"],
	["workers.profiles.*.model", "fleet.profiles.*.model"],
	["workers.profiles.*.thinkingLevel", "fleet.profiles.*.thinkingLevel"],
	["workers.profiles.*.node", "fleet.profiles.*.node"],
	["workers.rosters.*.members[].label", "fleet.rosters.*.members[].label"],
	["workers.rosters.*.members[].target", "fleet.rosters.*.members[].target"],
	["workers.rosters.*.members[].model", "fleet.rosters.*.members[].model"],
	["workers.rosters.*.members[].thinking", "fleet.rosters.*.members[].thinkingLevel"],
	["workers.rosters.*.members[].color", "fleet.rosters.*.members[].color"],
	["workers.agentBindings.*", "fleet.agentProfiles.*"],
	["routing.activeRoles[]", "fleet.adaptiveRouting.roles[]"],
	["routing.activePostures[]", "fleet.adaptiveRouting.postures[]"],
	["routing.agentAutomation.activeAgentRoles[].agentId", "fleet.adaptiveRouting.agentRoles[].agentId"],
	["routing.agentAutomation.activeAgentRoles[].executionRole", "fleet.adaptiveRouting.agentRoles[].executionRole"],
	["budget.concurrency", "fleet.concurrency"],
	["workers.maxRetries", "fleet.retry.maxRetries"],
	["workers.resilienceCooldownMs", "fleet.retry.routeCooldownMs"],
	["workers.onPermission", "fleet.permissions.mode"],
	["workers.escalation.timeoutMs", "fleet.permissions.escalation.timeoutMs"],
	["workers.escalation.fallback", "fleet.permissions.escalation.fallback"],
	["guardrails.workerToolCallCap", "fleet.limits.toolCallsPerRun"],
	["guardrails.internalDispatchTimeoutMs", "fleet.limits.internalRunTimeoutMs"],
	["guardrails.maxDispatchRuns", "fleet.history.maxRuns"],
	["compaction.auto", "context.compaction.auto"],
	["compaction.threshold", "context.compaction.threshold"],
	["compaction.model", "context.compaction.model"],
	["compaction.systemPrompt", "context.compaction.systemPrompt"],
	["background.target", "context.memory.target"],
	["background.model", "context.memory.model"],
	["memory.intervention.enabled", "context.memory.enabled"],
	["memory.intervention.everyNTools", "context.memory.cadenceToolCalls"],
	["memory.intervention.windowSteps", "context.memory.trajectorySteps"],
	["memory.intervention.maxTokens", "context.memory.maxOutputTokens"],
	["memory.intervention.timeoutMs", "context.memory.timeoutMs"],
	["budget.sessionCeilingUsd", "safety.limits.sessionCostUsd"],
	["guardrails.turnToolCallBudget", "safety.limits.chatToolCallsPerTurn"],
	["guardrails.readMaxBytes", "safety.limits.readBytesPerCall"],
	["guardrails.observationTurnBudgetBytes", "safety.limits.observationBytesPerTurn"],
	["watchdog.enabled", "safety.review.enabled"],
	["watchdog.target", "safety.review.target"],
	["watchdog.cadenceToolCalls", "safety.review.cadenceToolCalls"],
	["terminal.outputVerbosity", "interface.outputDetail"],
	["terminal.smoothStreaming", "interface.smoothStreaming"],
	["terminal.tuiMode", "interface.mode"],
	["terminal.fullscreenScrollbar", "interface.fullscreenScrollbar"],
	["terminal.showTerminalProgress", "interface.terminalProgress"],
	["terminal.notify", "interface.desktopNotifications"],
	// The panes keys shipped for exactly one release (v0.4.0, the day before
	// this rework) but they did ship, and each has a direct v2 successor with
	// an identical value domain, so they move like everything else. The
	// retired agents/keepFailed pair and the `panes` root itself stay in
	// SETTINGS_V1_RETIRED-adjacent handling via V1_ONLY_ROOTS.
	["panes.enabled", "interface.panes.enabled"],
	["panes.notifications", "interface.panes.notifications"],
	["panes.journal", "fleet.history.journal"],
	["panes.yazi.enabled", "interface.panes.files.enabled"],
	["panes.yazi.mode", "interface.panes.files.mode"],
	["panes.yazi.profile", "interface.panes.files.profile"],
	["panes.yazi.followCwd", "interface.panes.files.followCwd"],
	["keybindings.*", "interface.keybindings.*"],
	["skills.trustProjectCompatRoots", "integrations.projectResources.trustProjectImports"],
	["delegation.defaults.connectTimeoutMs", "integrations.externalAgents.defaults.connectTimeoutMs"],
	["delegation.defaults.turnTimeoutMs", "integrations.externalAgents.defaults.turnTimeoutMs"],
	["delegation.defaults.permissionTimeoutMs", "integrations.externalAgents.defaults.permissionTimeoutMs"],
	["delegation.defaults.toolGovernance", "integrations.externalAgents.defaults.toolGovernance"],
	["delegation.agents[].id", "integrations.externalAgents.entries[].id"],
	["delegation.agents[].command", "integrations.externalAgents.entries[].command"],
	["delegation.agents[].args[]", "integrations.externalAgents.entries[].args[]"],
	["delegation.agents[].cwd", "integrations.externalAgents.entries[].cwd"],
	["delegation.agents[].env.*", "integrations.externalAgents.entries[].env.*"],
	["delegation.agents[].connectTimeoutMs", "integrations.externalAgents.entries[].connectTimeoutMs"],
	["delegation.agents[].turnTimeoutMs", "integrations.externalAgents.entries[].turnTimeoutMs"],
	["delegation.agents[].permissionTimeoutMs", "integrations.externalAgents.entries[].permissionTimeoutMs"],
	["delegation.agents[].stallTimeoutMs", "integrations.externalAgents.entries[].stallTimeoutMs"],
	["delegation.agents[].toolGovernance", "integrations.externalAgents.entries[].toolGovernance"],
	["delegation.agents[].projectContext", "integrations.externalAgents.entries[].projectContext"],
	["delegation.agents[].labels.*", "integrations.externalAgents.entries[].labels.*"],
	["runtimePlugins[]", "integrations.runtimePlugins[]"],
	["library.catalog", "integrations.library.catalog"],
	["library.remote", "integrations.library.remote"],
	["library.confirmedRemote", "integrations.library.confirmedRemote"],
	["library.sync", "integrations.library.sync"],
	["attribution.gitCommits", "integrations.git.commitAttribution"],
	["fleet.nodes[].clioEntry", "fleet.nodes[].clioCoderEntry"],
] as const);

export const SETTINGS_V1_RETIRED_PATHS = Object.freeze({
	identity: "it was accepted and ignored; no behavior is lost",
	"background.thinkingLevel": "proactive memory always resolves thinking off",
	theme: "the only registered theme was not read by runtime rendering",
	"compaction.excludeLastTurns": "only the temporary legacy mask used it; context.workingSet.protectLastTurns remains",
} as const);

const V1_ONLY_ROOTS = new Set([
	"identity",
	"autonomy",
	"runtimePlugins",
	"orchestrator",
	"background",
	"memory",
	"watchdog",
	"workers",
	"routing",
	"scope",
	"modelSelector",
	"budget",
	"defaults",
	"theme",
	"terminal",
	"skills",
	"library",
	"attribution",
	"delegation",
	"keybindings",
	"compaction",
	"prewarm",
	"panes",
	"retry",
	"guardrails",
]);

interface PatternMatch {
	path: string;
}

function pathPatternSegments(pattern: string): string[] {
	return pattern.split(".");
}

function patternMatches(value: unknown, pattern: string): PatternMatch[] {
	const out: PatternMatch[] = [];
	const visit = (current: unknown, segments: ReadonlyArray<string>, path: string): void => {
		const segment = segments[0];
		if (segment === undefined) {
			out.push({ path });
			return;
		}
		const rest = segments.slice(1);
		if (segment === "*") {
			if (!isPlainObject(current)) return;
			for (const [key, child] of Object.entries(current)) visit(child, rest, path ? `${path}.${key}` : key);
			return;
		}
		const list = segment.endsWith("[]");
		const key = list ? segment.slice(0, -2) : segment;
		if (!isPlainObject(current) || !(key in current)) return;
		const child = current[key];
		const nextPath = path ? `${path}.${key}` : key;
		if (!list) {
			visit(child, rest, nextPath);
			return;
		}
		if (!Array.isArray(child)) return;
		for (let index = 0; index < child.length; index += 1) visit(child[index], rest, `${nextPath}[${index}]`);
	};
	visit(value, pathPatternSegments(pattern), "");
	return out;
}

function reportV1Tombstones(issues: Issues, raw: Record<string, unknown>): void {
	const reportedRoots = new Set<string>();
	for (const [from, to] of SETTINGS_V1_PATH_MOVES) {
		for (const match of patternMatches(raw, from)) {
			issues.add(match.path, `retired settings-v1 path; use ${to} in version 2`);
			reportedRoots.add(match.path.split(/[.[]/u)[0] ?? match.path);
		}
	}
	for (const [path, reason] of Object.entries(SETTINGS_V1_RETIRED_PATHS)) {
		for (const match of patternMatches(raw, path)) {
			issues.add(match.path, `retired without replacement: ${reason}. Remove this key`);
			reportedRoots.add(match.path.split(/[.[]/u)[0] ?? match.path);
		}
	}
	for (const root of V1_ONLY_ROOTS) {
		if (root in raw && !reportedRoots.has(root)) {
			const replacements = new Set(
				SETTINGS_V1_PATH_MOVES.filter(([from]) => from.split(/[.[]/u)[0] === root).map(
					([, to]) => to.split(/[.[]/u)[0] ?? to,
				),
			);
			const hint = replacements.size > 0 ? `; use ${[...replacements].join(" or ")} in version 2` : "";
			issues.add(root, `retired settings-v1 namespace${hint}; migrate this document with \`clio-coder upgrade\``);
		}
	}
}

function validateRoute(
	issues: Issues,
	path: string,
	value: unknown,
	defaults: FleetRoute,
	targets: ReadonlyArray<ClioSettings["targets"][number]>,
	options?: { nodeIds?: ReadonlySet<string> },
): FleetRoute {
	const out = cloneValue(defaults);
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
	if ("target" in value) {
		if (value.target === null) out.target = null;
		else {
			const parsed = expectString(issues, `${path}.target`, value.target);
			if (parsed !== undefined) out.target = targets.some((entry) => entry.id === parsed) ? parsed : null;
		}
	}
	if ("model" in value) {
		if (value.model === null) out.model = null;
		else {
			const parsed = expectString(issues, `${path}.model`, value.model);
			if (parsed !== undefined) out.model = parsed;
		}
	}
	if ("thinkingLevel" in value) {
		const parsed = expectEnum(issues, `${path}.thinkingLevel`, value.thinkingLevel, THINKING_LEVELS);
		if (parsed !== undefined) out.thinkingLevel = parsed;
	}
	if (allowNode && "node" in value) {
		if (value.node === null) delete out.node;
		else {
			const parsed = expectString(issues, `${path}.node`, value.node);
			if (parsed !== undefined && (parsed === "local" || options.nodeIds?.has(parsed) === true)) out.node = parsed;
		}
	}
	if (!out.target) out.model = null;
	else if (out.model === null) out.model = targets.find((entry) => entry.id === out.target)?.defaultModel ?? null;
	return out;
}

function normalizeModelRefs(
	refs: ReadonlyArray<string>,
	targets: ReadonlyArray<ClioSettings["targets"][number]>,
): string[] {
	const targetIds = new Set(targets.map((target) => target.id));
	return refs.filter((ref) => {
		const [targetId, ...model] = ref.split("/");
		return Boolean(targetId && targetIds.has(targetId) && model.join("/").trim());
	});
}

function normalizeCycleSet(refs: ReadonlyArray<string>): string[] {
	return refs.filter((ref) => Boolean(ref.trim().split("/")[0]));
}

function validateExternalAgent(
	issues: Issues,
	path: string,
	value: unknown,
	defaults: ExternalAgentDefaults,
	seen: Set<string>,
): ExternalAgent | null {
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
		issues.add(`${path}.id`, `duplicate external agent id '${id}'`);
		return null;
	}
	seen.add(id);
	const agent: ExternalAgent = {
		id,
		command,
		args: [],
		connectTimeoutMs: defaults.connectTimeoutMs,
		turnTimeoutMs: defaults.turnTimeoutMs,
		permissionTimeoutMs: defaults.permissionTimeoutMs,
		toolGovernance: defaults.toolGovernance,
	};
	if ("args" in value) {
		const parsed = expectStringArray(issues, `${path}.args`, value.args);
		if (parsed !== undefined) agent.args = parsed;
	}
	for (const key of ["connectTimeoutMs", "turnTimeoutMs", "permissionTimeoutMs"] as const) {
		if (!(key in value)) continue;
		const parsed = expectInteger(issues, `${path}.${key}`, value[key], { min: 1, max: MAX_TIMER_DELAY_MS });
		if (parsed !== undefined) agent[key] = parsed;
	}
	if ("stallTimeoutMs" in value) {
		const parsed = expectInteger(issues, `${path}.stallTimeoutMs`, value.stallTimeoutMs);
		if (parsed !== undefined) agent.stallTimeoutMs = parsed;
	}
	if ("toolGovernance" in value) {
		const parsed = expectEnum(
			issues,
			`${path}.toolGovernance`,
			normalizeLegacyNamingValue(value.toolGovernance, "clio-policy", "clio-coder-policy"),
			TOOL_GOVERNANCE,
		);
		if (parsed !== undefined) agent.toolGovernance = parsed;
	}
	if ("projectContext" in value) {
		const parsed = expectEnum(issues, `${path}.projectContext`, value.projectContext, ["none", "bounded"] as const);
		if (parsed !== undefined) agent.projectContext = parsed;
	}
	for (const key of ["cwd"] as const) {
		if (!(key in value)) continue;
		const parsed = expectString(issues, `${path}.${key}`, value[key]);
		if (parsed !== undefined) agent[key] = parsed;
	}
	for (const key of ["env", "labels"] as const) {
		if (!(key in value)) continue;
		const parsed = expectStringRecord(issues, `${path}.${key}`, value[key]);
		if (parsed !== undefined && Object.keys(parsed).length > 0) agent[key] = parsed;
	}
	return agent;
}

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
		"clioCoderEntry",
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
	if (id === "local") {
		issues.add(`${path}.id`, "'local' is reserved for the implicit local node");
		return null;
	}
	if (seen.has(id)) {
		issues.add(`${path}.id`, `duplicate fleet node id '${id}'`);
		return null;
	}
	seen.add(id);
	const node: FleetNodeConfig = { id, host, maxWorkers: 2 };
	for (const key of ["user", "identityFile", "clioCoderEntry"] as const) {
		if (!(key in value)) continue;
		const parsed = expectString(issues, `${path}.${key}`, value[key]);
		if (parsed !== undefined) node[key] = parsed;
	}
	if ("port" in value) {
		const parsed = expectInteger(issues, `${path}.port`, value.port, { min: 1 });
		if (parsed !== undefined) node.port = parsed;
	}
	if ("labels" in value) {
		const parsed = expectStringArray(issues, `${path}.labels`, value.labels);
		if (parsed !== undefined) node.labels = parsed;
	}
	if ("maxWorkers" in value) {
		const parsed = expectInteger(issues, `${path}.maxWorkers`, value.maxWorkers, { min: 1 });
		if (parsed !== undefined) node.maxWorkers = parsed;
	}
	if ("residency" in value) {
		const parsed = expectEnum(issues, `${path}.residency`, value.residency, ["observe", "manage"] as const);
		if (parsed !== undefined) node.residency = parsed;
	}
	return node;
}

function validateKeybindings(issues: Issues, path: string, value: unknown): Record<string, string | string[]> {
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return {};
	}
	const next: Record<string, string | string[]> = {};
	for (const [rawKey, rawValue] of Object.entries(value)) {
		const legacyId = rawKey.trim();
		const id = legacyId.startsWith("clio.") ? `clio-coder.${legacyId.slice("clio.".length)}` : legacyId;
		if (!id) {
			issues.add(path, "empty keybinding id");
			continue;
		}
		if (id !== legacyId) {
			warnLegacyNaming(legacyId, id);
			// Canonical values win even when the legacy key occurs later in YAML.
			if (Object.hasOwn(value, id)) continue;
		}
		if (typeof rawValue === "string") {
			const parsed = expectString(issues, `${path}.${legacyId}`, rawValue);
			if (parsed !== undefined) next[id] = parsed;
		} else if (Array.isArray(rawValue)) {
			const parsed = expectStringArray(issues, `${path}.${legacyId}`, rawValue);
			if (parsed !== undefined && parsed.length > 0) next[id] = parsed;
		} else issues.add(`${path}.${legacyId}`, `expected a string or list of strings, got ${describe(rawValue)}`);
	}
	return next;
}

const TOP_LEVEL_KEYS = [
	"version",
	"targets",
	"chat",
	"fleet",
	"context",
	"safety",
	"interface",
	"integrations",
	...V1_ONLY_ROOTS,
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
	if (!isPlainObject(raw)) {
		issues.add("(root)", `expected a map, got ${describe(raw)}`);
		return { settings, issues: issues.list };
	}
	reportV1Tombstones(issues, raw);
	issues.unknownKeys("", raw, TOP_LEVEL_KEYS);
	if ("version" in raw && raw.version !== 2) {
		issues.add("version", `expected 2, got ${describe(raw.version)}; run \`clio-coder upgrade\` for version 1`);
	}

	if ("targets" in raw) {
		if (!Array.isArray(raw.targets)) issues.add("targets", `expected a list, got ${describe(raw.targets)}`);
		else {
			const seen = new Set<string>();
			const targets: ClioSettings["targets"] = [];
			for (let index = 0; index < raw.targets.length; index += 1) {
				const target = validateTarget(issues, `targets[${index}]`, raw.targets[index]);
				if (!target) continue;
				if (seen.has(target.id)) {
					issues.add(`targets[${index}].id`, `duplicate target id '${target.id}'`);
					continue;
				}
				seen.add(target.id);
				targets.push(target);
			}
			settings.targets = targets;
		}
	}

	if ("chat" in raw) {
		if (!isPlainObject(raw.chat)) issues.add("chat", `expected a map, got ${describe(raw.chat)}`);
		else {
			const chat = raw.chat;
			issues.unknownKeys("chat", chat, [
				"target",
				"model",
				"thinkingLevel",
				"modelPicker",
				"maxOutputTokens",
				"prewarm",
				"retry",
			]);
			const routeInput: Record<string, unknown> = {};
			for (const key of ["target", "model", "thinkingLevel"] as const) {
				if (key in chat) routeInput[key] = chat[key];
			}
			const route = validateRoute(
				issues,
				"chat",
				routeInput,
				{ target: settings.chat.target, model: settings.chat.model, thinkingLevel: settings.chat.thinkingLevel },
				settings.targets,
			);
			settings.chat.target = route.target;
			settings.chat.model = route.model;
			settings.chat.thinkingLevel = route.thinkingLevel;
			if ("modelPicker" in chat) {
				if (!isPlainObject(chat.modelPicker))
					issues.add("chat.modelPicker", `expected a map, got ${describe(chat.modelPicker)}`);
				else {
					issues.unknownKeys("chat.modelPicker", chat.modelPicker, ["cycleSet", "favorites", "recentLimit"]);
					if ("cycleSet" in chat.modelPicker) {
						const parsed = expectStringArray(issues, "chat.modelPicker.cycleSet", chat.modelPicker.cycleSet);
						if (parsed !== undefined) settings.chat.modelPicker.cycleSet = normalizeCycleSet(parsed);
					}
					if ("favorites" in chat.modelPicker) {
						const parsed = expectStringArray(issues, "chat.modelPicker.favorites", chat.modelPicker.favorites);
						if (parsed !== undefined) settings.chat.modelPicker.favorites = normalizeModelRefs(parsed, settings.targets);
					}
					if ("recentLimit" in chat.modelPicker) {
						const parsed = expectInteger(issues, "chat.modelPicker.recentLimit", chat.modelPicker.recentLimit, { min: 1 });
						if (parsed !== undefined) settings.chat.modelPicker.recentLimit = parsed;
					}
				}
			}
			if ("maxOutputTokens" in chat) {
				const parsed = expectInteger(issues, "chat.maxOutputTokens", chat.maxOutputTokens, { min: 0 });
				if (parsed !== undefined) settings.chat.maxOutputTokens = parsed;
			}
			if ("prewarm" in chat) {
				const parsed = expectBoolean(issues, "chat.prewarm", chat.prewarm);
				if (parsed !== undefined) settings.chat.prewarm = parsed;
			}
			if ("retry" in chat) {
				if (!isPlainObject(chat.retry)) issues.add("chat.retry", `expected a map, got ${describe(chat.retry)}`);
				else {
					issues.unknownKeys("chat.retry", chat.retry, [
						"enabled",
						"maxRetries",
						"baseDelayMs",
						"maxDelayMs",
						"streamStallMs",
					]);
					if ("enabled" in chat.retry) {
						const parsed = expectBoolean(issues, "chat.retry.enabled", chat.retry.enabled);
						if (parsed !== undefined) settings.chat.retry.enabled = parsed;
					}
					for (const key of ["maxRetries", "baseDelayMs", "maxDelayMs", "streamStallMs"] as const) {
						if (!(key in chat.retry)) continue;
						const parsed = expectInteger(issues, `chat.retry.${key}`, chat.retry[key], { min: 0 });
						if (parsed !== undefined) settings.chat.retry[key] = parsed;
					}
				}
			}
		}
	}

	let rawFleet: Record<string, unknown> | null = null;
	if ("fleet" in raw) {
		if (!isPlainObject(raw.fleet)) issues.add("fleet", `expected a map, got ${describe(raw.fleet)}`);
		else {
			rawFleet = raw.fleet;
			issues.unknownKeys("fleet", rawFleet, [
				"default",
				"profiles",
				"rosters",
				"agentProfiles",
				"adaptiveRouting",
				"nodes",
				"permissions",
				"concurrency",
				"retry",
				"limits",
				"history",
			]);
		}
	}
	if (rawFleet && "nodes" in rawFleet) {
		if (!Array.isArray(rawFleet.nodes)) issues.add("fleet.nodes", `expected a list, got ${describe(rawFleet.nodes)}`);
		else {
			const seen = new Set<string>();
			settings.fleet.nodes = rawFleet.nodes
				.map((entry, index) => validateFleetNode(issues, `fleet.nodes[${index}]`, entry, seen))
				.filter((entry): entry is FleetNodeConfig => entry !== null);
		}
	}
	const fleetNodeIds = new Set(settings.fleet.nodes.map((node) => node.id));
	if (rawFleet) {
		if ("default" in rawFleet) {
			settings.fleet.default = validateRoute(
				issues,
				"fleet.default",
				rawFleet.default,
				settings.fleet.default,
				settings.targets,
				{
					nodeIds: fleetNodeIds,
				},
			);
		}
		if ("profiles" in rawFleet) {
			if (!isPlainObject(rawFleet.profiles))
				issues.add("fleet.profiles", `expected a map, got ${describe(rawFleet.profiles)}`);
			else {
				const profiles: ClioSettings["fleet"]["profiles"] = {};
				for (const [rawName, rawProfile] of Object.entries(rawFleet.profiles)) {
					const name = rawName.trim();
					if (!name) {
						issues.add("fleet.profiles", "empty profile name");
						continue;
					}
					const profile = validateRoute(
						issues,
						`fleet.profiles.${name}`,
						rawProfile,
						DEFAULT_SETTINGS.fleet.default,
						settings.targets,
						{
							nodeIds: fleetNodeIds,
						},
					);
					if (profile.target) profiles[name] = profile;
				}
				settings.fleet.profiles = profiles;
			}
		}
		if ("rosters" in rawFleet) {
			if (!isPlainObject(rawFleet.rosters))
				issues.add("fleet.rosters", `expected a map, got ${describe(rawFleet.rosters)}`);
			else {
				const rosters: ClioSettings["fleet"]["rosters"] = {};
				for (const [rawName, rawRoster] of Object.entries(rawFleet.rosters)) {
					const name = rawName.trim();
					const path = `fleet.rosters.${name}`;
					if (!name) {
						issues.add("fleet.rosters", "empty roster name");
						continue;
					}
					if (!isPlainObject(rawRoster)) {
						issues.add(path, `expected a map, got ${describe(rawRoster)}`);
						continue;
					}
					issues.unknownKeys(path, rawRoster, ["members"]);
					if (!Array.isArray(rawRoster.members)) {
						issues.add(`${path}.members`, "expected a list");
						continue;
					}
					if (rawRoster.members.length < 2 || rawRoster.members.length > 5)
						issues.add(`${path}.members`, "expected 2 to 5 members");
					const members: ClioSettings["fleet"]["rosters"][string]["members"] = [];
					const labels = new Set<string>();
					for (const [index, rawMember] of rawRoster.members.entries()) {
						const memberPath = `${path}.members[${index}]`;
						if (!isPlainObject(rawMember)) {
							issues.add(memberPath, `expected a map, got ${describe(rawMember)}`);
							continue;
						}
						issues.unknownKeys(memberPath, rawMember, ["label", "target", "model", "thinkingLevel", "color"]);
						const label = expectString(issues, `${memberPath}.label`, rawMember.label);
						const target = expectString(issues, `${memberPath}.target`, rawMember.target);
						if (label !== undefined && !COUNCIL_MEMBER_LABEL_PATTERN.test(label))
							issues.add(`${memberPath}.label`, "expected [a-z][a-z0-9_-]{0,31}");
						if (label !== undefined && labels.has(label)) issues.add(`${memberPath}.label`, "duplicate label");
						if (label !== undefined) labels.add(label);
						if (target !== undefined && !settings.targets.some((entry) => entry.id === target))
							issues.add(`${memberPath}.target`, `unknown target '${target}'`);
						const model =
							rawMember.model === undefined ? undefined : expectString(issues, `${memberPath}.model`, rawMember.model);
						const thinkingLevel =
							rawMember.thinkingLevel === undefined
								? undefined
								: expectEnum(issues, `${memberPath}.thinkingLevel`, rawMember.thinkingLevel, THINKING_LEVELS);
						const color =
							rawMember.color === undefined ? undefined : expectString(issues, `${memberPath}.color`, rawMember.color);
						if (color !== undefined && !THEME_NAMED_COLORS.includes(color as never) && !/^#[0-9a-fA-F]{6}$/u.test(color)) {
							issues.add(`${memberPath}.color`, "expected a theme named color or 6-digit hex color");
						}
						if (label === undefined || target === undefined) continue;
						members.push({
							label,
							target,
							...(model ? { model } : {}),
							...(thinkingLevel ? { thinkingLevel } : {}),
							...(color ? { color } : {}),
						});
					}
					if (rawRoster.members.length >= 2 && rawRoster.members.length <= 5 && members.length === rawRoster.members.length)
						rosters[name] = { members };
				}
				settings.fleet.rosters = rosters;
			}
		}
		if ("agentProfiles" in rawFleet) {
			if (!isPlainObject(rawFleet.agentProfiles))
				issues.add("fleet.agentProfiles", `expected a map, got ${describe(rawFleet.agentProfiles)}`);
			else {
				const bindings: ClioSettings["fleet"]["agentProfiles"] = {};
				for (const [rawAgentId, rawProfileName] of Object.entries(rawFleet.agentProfiles)) {
					const agentId = rawAgentId.trim();
					if (!agentId) {
						issues.add("fleet.agentProfiles", "empty agent id");
						continue;
					}
					if (agentId === "auto") {
						issues.add("fleet.agentProfiles", "'auto' is reserved for coordinator-owned agent selection");
						continue;
					}
					const profile = expectString(issues, `fleet.agentProfiles.${agentId}`, rawProfileName);
					if (profile !== undefined) bindings[agentId] = profile;
				}
				settings.fleet.agentProfiles = bindings;
			}
		}
		if ("adaptiveRouting" in rawFleet) {
			if (!isPlainObject(rawFleet.adaptiveRouting))
				issues.add("fleet.adaptiveRouting", `expected a map, got ${describe(rawFleet.adaptiveRouting)}`);
			else {
				const adaptive = rawFleet.adaptiveRouting;
				issues.unknownKeys("fleet.adaptiveRouting", adaptive, ["roles", "postures", "agentRoles"]);
				for (const [key, allowed] of [
					["roles", ACTIVE_ROUTING_ROLES],
					["postures", ACTIVE_ROUTING_POSTURES],
				] as const) {
					if (!(key in adaptive)) continue;
					const parsed = expectStringArray(issues, `fleet.adaptiveRouting.${key}`, adaptive[key]);
					if (parsed === undefined) continue;
					const allowedSet = new Set<string>(allowed);
					for (const value of parsed)
						if (!allowedSet.has(value))
							issues.add(`fleet.adaptiveRouting.${key}`, `unsupported ${key === "roles" ? "role" : "posture"} '${value}'`);
					if (parsed.every((value) => allowedSet.has(value))) settings.fleet.adaptiveRouting[key] = parsed as never;
				}
				if ("agentRoles" in adaptive) {
					if (!Array.isArray(adaptive.agentRoles)) issues.add("fleet.adaptiveRouting.agentRoles", "expected a list");
					else {
						const pairs: ClioSettings["fleet"]["adaptiveRouting"]["agentRoles"] = [];
						const seen = new Set<string>();
						for (const [index, value] of adaptive.agentRoles.entries()) {
							const path = `fleet.adaptiveRouting.agentRoles[${index}]`;
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
							if (agentId === "auto")
								issues.add(`${path}.agentId`, "'auto' is reserved for coordinator-owned agent selection");
							if (agentId === undefined || agentId === "auto" || executionRole === undefined) continue;
							const pairKey = `${agentId}\u0000${executionRole}`;
							if (seen.has(pairKey)) {
								issues.add(path, "duplicate agent and execution-role pair");
								continue;
							}
							seen.add(pairKey);
							pairs.push({ agentId, executionRole });
						}
						if (pairs.length === adaptive.agentRoles.length) settings.fleet.adaptiveRouting.agentRoles = pairs;
					}
				}
			}
		}
		if ("permissions" in rawFleet) {
			if (!isPlainObject(rawFleet.permissions))
				issues.add("fleet.permissions", `expected a map, got ${describe(rawFleet.permissions)}`);
			else {
				issues.unknownKeys("fleet.permissions", rawFleet.permissions, ["mode", "escalation"]);
				if ("mode" in rawFleet.permissions) {
					const parsed = expectEnum(issues, "fleet.permissions.mode", rawFleet.permissions.mode, [
						"deny",
						"fail",
						"escalate",
					] as const);
					if (parsed !== undefined) settings.fleet.permissions.mode = parsed;
				}
				if ("escalation" in rawFleet.permissions) {
					if (!isPlainObject(rawFleet.permissions.escalation))
						issues.add("fleet.permissions.escalation", `expected a map, got ${describe(rawFleet.permissions.escalation)}`);
					else {
						const escalation = rawFleet.permissions.escalation;
						issues.unknownKeys("fleet.permissions.escalation", escalation, ["timeoutMs", "fallback"]);
						if ("timeoutMs" in escalation) {
							const parsed = expectInteger(issues, "fleet.permissions.escalation.timeoutMs", escalation.timeoutMs, { min: 1 });
							if (parsed !== undefined) settings.fleet.permissions.escalation.timeoutMs = parsed;
						}
						if ("fallback" in escalation) {
							const parsed = expectEnum(issues, "fleet.permissions.escalation.fallback", escalation.fallback, [
								"deny",
								"fail",
							] as const);
							if (parsed !== undefined) settings.fleet.permissions.escalation.fallback = parsed;
						}
					}
				}
			}
		}
		if ("concurrency" in rawFleet) {
			if (rawFleet.concurrency === "auto") settings.fleet.concurrency = "auto";
			else {
				const parsed = expectInteger(issues, "fleet.concurrency", rawFleet.concurrency, { min: 1 });
				if (parsed !== undefined) settings.fleet.concurrency = parsed;
			}
		}
		for (const [blockName, fields] of [
			[
				"retry",
				[
					["maxRetries", 0],
					["routeCooldownMs", 0],
				],
			],
			[
				"limits",
				[
					["toolCallsPerRun", 1],
					["internalRunTimeoutMs", 1],
				],
			],
			["history", [["maxRuns", 1]]],
		] as const) {
			if (!(blockName in rawFleet)) continue;
			const block = rawFleet[blockName];
			if (!isPlainObject(block)) {
				issues.add(`fleet.${blockName}`, `expected a map, got ${describe(block)}`);
				continue;
			}
			const known = fields.map(([key]) => key);
			if (blockName === "history") known.push("journal" as never);
			issues.unknownKeys(`fleet.${blockName}`, block, known);
			for (const [key, min] of fields) {
				if (!(key in block)) continue;
				const parsed = expectInteger(issues, `fleet.${blockName}.${key}`, block[key], { min });
				if (parsed !== undefined) (settings.fleet[blockName] as unknown as Record<string, unknown>)[key] = parsed;
			}
			if (blockName === "history" && "journal" in block) {
				const parsed = expectBoolean(issues, "fleet.history.journal", block.journal);
				if (parsed !== undefined) settings.fleet.history.journal = parsed;
			}
		}
	}

	if ("context" in raw) {
		if (!isPlainObject(raw.context)) issues.add("context", `expected a map, got ${describe(raw.context)}`);
		else {
			const context = raw.context;
			issues.unknownKeys("context", context, ["toolResultMaxBytes", "workingSet", "compaction", "memory"]);
			if ("toolResultMaxBytes" in context) {
				const parsed = expectInteger(issues, "context.toolResultMaxBytes", context.toolResultMaxBytes, { min: 4096 });
				if (parsed !== undefined) settings.context.toolResultMaxBytes = parsed;
			}
			if ("workingSet" in context) {
				if (!isPlainObject(context.workingSet))
					issues.add("context.workingSet", `expected a map, got ${describe(context.workingSet)}`);
				else {
					const workingSet = context.workingSet;
					issues.unknownKeys("context.workingSet", workingSet, [
						"enabled",
						"policy",
						"target",
						"protectLastTurns",
						"minEvictableTokens",
					]);
					if ("enabled" in workingSet) {
						const parsed = expectBoolean(issues, "context.workingSet.enabled", workingSet.enabled);
						if (parsed !== undefined) settings.context.workingSet.enabled = parsed;
					}
					if ("policy" in workingSet) {
						const parsed = expectEnum(issues, "context.workingSet.policy", workingSet.policy, [
							"age-horizon",
							"structural-v1",
						] as const);
						if (parsed !== undefined) settings.context.workingSet.policy = parsed;
					}
					if ("target" in workingSet) {
						const parsed = expectNumber(issues, "context.workingSet.target", workingSet.target);
						if (parsed !== undefined && (parsed <= 0 || parsed >= 1))
							issues.add("context.workingSet.target", `expected a number > 0 and < 1, got ${parsed}`);
						else if (parsed !== undefined) settings.context.workingSet.target = parsed;
					}
					for (const [key, min] of [
						["protectLastTurns", 1],
						["minEvictableTokens", 0],
					] as const) {
						if (!(key in workingSet)) continue;
						const parsed = expectInteger(issues, `context.workingSet.${key}`, workingSet[key], { min });
						if (parsed !== undefined) settings.context.workingSet[key] = parsed;
					}
				}
			}
			if ("compaction" in context) {
				if (!isPlainObject(context.compaction))
					issues.add("context.compaction", `expected a map, got ${describe(context.compaction)}`);
				else {
					const compaction = context.compaction;
					issues.unknownKeys("context.compaction", compaction, [
						"auto",
						"threshold",
						"model",
						"systemPrompt",
						"excludeLastTurns",
					]);
					if ("excludeLastTurns" in compaction)
						issues.add(
							"context.compaction.excludeLastTurns",
							"retired without replacement; use context.workingSet.protectLastTurns",
						);
					if ("auto" in compaction) {
						const parsed = expectBoolean(issues, "context.compaction.auto", compaction.auto);
						if (parsed !== undefined) settings.context.compaction.auto = parsed;
					}
					if ("threshold" in compaction) {
						const parsed = expectNumber(issues, "context.compaction.threshold", compaction.threshold, { min: 0, max: 1 });
						if (parsed !== undefined) settings.context.compaction.threshold = parsed;
					}
					for (const key of ["model", "systemPrompt"] as const) {
						if (!(key in compaction)) continue;
						const parsed = expectString(issues, `context.compaction.${key}`, compaction[key]);
						if (parsed !== undefined) settings.context.compaction[key] = parsed;
					}
				}
			}
			if ("memory" in context) {
				if (!isPlainObject(context.memory)) issues.add("context.memory", `expected a map, got ${describe(context.memory)}`);
				else {
					const memory = context.memory;
					issues.unknownKeys("context.memory", memory, [
						"enabled",
						"target",
						"model",
						"cadenceToolCalls",
						"trajectorySteps",
						"maxOutputTokens",
						"timeoutMs",
					]);
					if ("enabled" in memory) {
						const parsed = expectBoolean(issues, "context.memory.enabled", memory.enabled);
						if (parsed !== undefined) settings.context.memory.enabled = parsed;
					}
					if ("target" in memory) {
						if (memory.target === null) settings.context.memory.target = null;
						else {
							const parsed = expectString(issues, "context.memory.target", memory.target);
							if (parsed !== undefined)
								settings.context.memory.target = settings.targets.some((target) => target.id === parsed) ? parsed : null;
						}
					}
					if ("model" in memory) {
						if (memory.model === null) settings.context.memory.model = null;
						else {
							const parsed = expectString(issues, "context.memory.model", memory.model);
							if (parsed !== undefined) settings.context.memory.model = parsed;
						}
					}
					if (!settings.context.memory.target) settings.context.memory.model = null;
					else if (settings.context.memory.model === null)
						settings.context.memory.model =
							settings.targets.find((target) => target.id === settings.context.memory.target)?.defaultModel ?? null;
					for (const [key, min] of [
						["cadenceToolCalls", 2],
						["trajectorySteps", 1],
						["maxOutputTokens", 1],
						["timeoutMs", 1],
					] as const) {
						if (!(key in memory)) continue;
						const parsed = expectInteger(issues, `context.memory.${key}`, memory[key], { min });
						if (parsed !== undefined) settings.context.memory[key] = parsed;
					}
				}
			}
		}
	}

	if ("safety" in raw) {
		if (!isPlainObject(raw.safety)) issues.add("safety", `expected a map, got ${describe(raw.safety)}`);
		else {
			const safety = raw.safety;
			issues.unknownKeys("safety", safety, ["autonomy", "limits", "review"]);
			if ("autonomy" in safety) {
				const parsed = expectEnum(issues, "safety.autonomy", safety.autonomy, AUTONOMY_LEVELS);
				if (parsed !== undefined) settings.safety.autonomy = parsed;
			}
			if ("limits" in safety) {
				if (!isPlainObject(safety.limits)) issues.add("safety.limits", `expected a map, got ${describe(safety.limits)}`);
				else {
					const limits = safety.limits;
					issues.unknownKeys("safety.limits", limits, [
						"sessionCostUsd",
						"chatToolCallsPerTurn",
						"readBytesPerCall",
						"observationBytesPerTurn",
					]);
					if ("sessionCostUsd" in limits) {
						const parsed = expectNumber(issues, "safety.limits.sessionCostUsd", limits.sessionCostUsd, { min: 0 });
						if (parsed !== undefined) settings.safety.limits.sessionCostUsd = parsed;
					}
					for (const key of ["chatToolCallsPerTurn", "readBytesPerCall", "observationBytesPerTurn"] as const) {
						if (!(key in limits)) continue;
						const parsed = expectInteger(issues, `safety.limits.${key}`, limits[key], { min: 1 });
						if (parsed !== undefined) settings.safety.limits[key] = parsed;
					}
				}
			}
			if ("review" in safety) {
				if (!isPlainObject(safety.review)) issues.add("safety.review", `expected a map, got ${describe(safety.review)}`);
				else {
					const review = safety.review;
					issues.unknownKeys("safety.review", review, ["enabled", "target", "cadenceToolCalls"]);
					if ("enabled" in review) {
						const parsed = expectBoolean(issues, "safety.review.enabled", review.enabled);
						if (parsed !== undefined) settings.safety.review.enabled = parsed;
					}
					if ("target" in review && review.target !== null) {
						const parsed = expectString(issues, "safety.review.target", review.target);
						if (parsed !== undefined && settings.targets.some((target) => target.id === parsed))
							settings.safety.review.target = parsed;
						else if (parsed !== undefined) issues.add("safety.review.target", `unknown target '${parsed}'`);
					}
					if ("cadenceToolCalls" in review && review.cadenceToolCalls !== null) {
						const parsed = expectInteger(issues, "safety.review.cadenceToolCalls", review.cadenceToolCalls, { min: 1 });
						if (parsed !== undefined) settings.safety.review.cadenceToolCalls = parsed;
					}
				}
			}
		}
	}

	if ("interface" in raw) {
		if (!isPlainObject(raw.interface)) issues.add("interface", `expected a map, got ${describe(raw.interface)}`);
		else {
			const ui = raw.interface;
			issues.unknownKeys("interface", ui, [
				"outputDetail",
				"smoothStreaming",
				"mode",
				"fullscreenScrollbar",
				"terminalProgress",
				"desktopNotifications",
				"panes",
				"keybindings",
			]);
			for (const key of ["terminalProgress", "desktopNotifications"] as const) {
				if (!(key in ui)) continue;
				const parsed = expectBoolean(issues, `interface.${key}`, ui[key]);
				if (parsed !== undefined) (settings.interface as unknown as Record<string, unknown>)[key] = parsed;
			}
			for (const [key, allowed] of [
				["outputDetail", ["minimal", "default", "verbose"]],
				["smoothStreaming", ["off", "auto", "on"]],
				["mode", ["regular", "fullscreen"]],
				["fullscreenScrollbar", ["hidden", "auto", "always"]],
			] as const) {
				if (!(key in ui)) continue;
				const parsed = expectEnum(issues, `interface.${key}`, ui[key], allowed);
				if (parsed !== undefined) (settings.interface as unknown as Record<string, unknown>)[key] = parsed;
			}
			if ("panes" in ui) {
				if (!isPlainObject(ui.panes)) issues.add("interface.panes", `expected a map, got ${describe(ui.panes)}`);
				else {
					const panes = ui.panes;
					issues.unknownKeys("interface.panes", panes, ["enabled", "notifications", "layout", "workers", "files"]);
					if ("enabled" in panes) {
						const parsed = expectEnum(issues, "interface.panes.enabled", panes.enabled, ["auto", "embedded", "off"] as const);
						if (parsed !== undefined) settings.interface.panes.enabled = parsed;
					}
					if ("notifications" in panes) {
						const parsed = expectEnum(issues, "interface.panes.notifications", panes.notifications, [
							"failures",
							"all",
							"off",
						] as const);
						if (parsed !== undefined) settings.interface.panes.notifications = parsed;
					}
					if ("layout" in panes) {
						const parsed = expectEnum(issues, "interface.panes.layout", panes.layout, ["off", "workers", "cockpit"] as const);
						if (parsed !== undefined) settings.interface.panes.layout = parsed;
					}
					if ("workers" in panes) {
						if (!isPlainObject(panes.workers))
							issues.add("interface.panes.workers", `expected a map, got ${describe(panes.workers)}`);
						else {
							const workers = panes.workers;
							issues.unknownKeys("interface.panes.workers", workers, ["ratio"]);
							if ("ratio" in workers) {
								const parsed = expectNumber(issues, "interface.panes.workers.ratio", workers.ratio, {
									min: 0.05,
									max: 0.5,
								});
								if (parsed !== undefined) settings.interface.panes.workers.ratio = parsed;
							}
						}
					}
					if ("files" in panes) {
						if (!isPlainObject(panes.files))
							issues.add("interface.panes.files", `expected a map, got ${describe(panes.files)}`);
						else {
							const files = panes.files;
							issues.unknownKeys("interface.panes.files", files, ["enabled", "mode", "profile", "followCwd", "ratio"]);
							for (const key of ["enabled", "followCwd"] as const) {
								if (!(key in files)) continue;
								const parsed = expectBoolean(issues, `interface.panes.files.${key}`, files[key]);
								if (parsed !== undefined) settings.interface.panes.files[key] = parsed;
							}
							if ("mode" in files) {
								const parsed = expectEnum(issues, "interface.panes.files.mode", files.mode, ["companion", "chooser"] as const);
								if (parsed !== undefined) settings.interface.panes.files.mode = parsed;
							}
							if ("profile" in files) {
								const parsed = expectEnum(issues, "interface.panes.files.profile", files.profile, ["managed", "user"] as const);
								if (parsed !== undefined) settings.interface.panes.files.profile = parsed;
							}
							if ("ratio" in files) {
								const parsed = expectNumber(issues, "interface.panes.files.ratio", files.ratio, { min: 0.05, max: 0.5 });
								if (parsed !== undefined) settings.interface.panes.files.ratio = parsed;
							}
						}
					}
				}
			}
			if ("keybindings" in ui)
				settings.interface.keybindings = validateKeybindings(issues, "interface.keybindings", ui.keybindings);
		}
	}

	if ("integrations" in raw) {
		if (!isPlainObject(raw.integrations)) issues.add("integrations", `expected a map, got ${describe(raw.integrations)}`);
		else {
			const integrations = raw.integrations;
			issues.unknownKeys("integrations", integrations, [
				"projectResources",
				"externalAgents",
				"runtimePlugins",
				"library",
				"git",
			]);
			if ("projectResources" in integrations) {
				if (!isPlainObject(integrations.projectResources))
					issues.add("integrations.projectResources", `expected a map, got ${describe(integrations.projectResources)}`);
				else {
					issues.unknownKeys("integrations.projectResources", integrations.projectResources, ["trustProjectImports"]);
					if ("trustProjectImports" in integrations.projectResources) {
						const parsed = expectBoolean(
							issues,
							"integrations.projectResources.trustProjectImports",
							integrations.projectResources.trustProjectImports,
						);
						if (parsed !== undefined) settings.integrations.projectResources.trustProjectImports = parsed;
					}
				}
			}
			if ("runtimePlugins" in integrations) {
				const parsed = expectStringArray(issues, "integrations.runtimePlugins", integrations.runtimePlugins);
				if (parsed !== undefined) settings.integrations.runtimePlugins = parsed;
			}
			if ("library" in integrations) {
				if (!isPlainObject(integrations.library))
					issues.add("integrations.library", `expected a map, got ${describe(integrations.library)}`);
				else {
					const library = integrations.library;
					issues.unknownKeys("integrations.library", library, ["catalog", "remote", "confirmedRemote", "sync"]);
					for (const key of ["catalog", "remote", "confirmedRemote"] as const) {
						if (!(key in library)) continue;
						const value = library[key];
						if (value !== null && typeof value !== "string")
							issues.add(`integrations.library.${key}`, `expected a string or null, got ${describe(value)}`);
						else settings.integrations.library[key] = value as string | null;
					}
					if ("sync" in library) {
						const parsed = expectBoolean(issues, "integrations.library.sync", library.sync);
						if (parsed !== undefined) settings.integrations.library.sync = parsed;
					}
				}
			}
			if ("git" in integrations) {
				if (!isPlainObject(integrations.git))
					issues.add("integrations.git", `expected a map, got ${describe(integrations.git)}`);
				else {
					issues.unknownKeys("integrations.git", integrations.git, ["commitAttribution"]);
					if ("commitAttribution" in integrations.git) {
						const parsed = expectBoolean(issues, "integrations.git.commitAttribution", integrations.git.commitAttribution);
						if (parsed !== undefined) settings.integrations.git.commitAttribution = parsed;
					}
				}
			}
			if ("externalAgents" in integrations) {
				if (!isPlainObject(integrations.externalAgents))
					issues.add("integrations.externalAgents", `expected a map, got ${describe(integrations.externalAgents)}`);
				else {
					const external = integrations.externalAgents;
					issues.unknownKeys("integrations.externalAgents", external, ["entries", "defaults"]);
					if ("defaults" in external) {
						if (!isPlainObject(external.defaults))
							issues.add("integrations.externalAgents.defaults", `expected a map, got ${describe(external.defaults)}`);
						else {
							const defaults = external.defaults;
							issues.unknownKeys("integrations.externalAgents.defaults", defaults, [
								"connectTimeoutMs",
								"turnTimeoutMs",
								"permissionTimeoutMs",
								"toolGovernance",
							]);
							for (const key of ["connectTimeoutMs", "turnTimeoutMs", "permissionTimeoutMs"] as const) {
								if (!(key in defaults)) continue;
								const parsed = expectInteger(issues, `integrations.externalAgents.defaults.${key}`, defaults[key], {
									min: 1,
									max: MAX_TIMER_DELAY_MS,
								});
								if (parsed !== undefined) settings.integrations.externalAgents.defaults[key] = parsed;
							}
							if ("toolGovernance" in defaults) {
								const parsed = expectEnum(
									issues,
									"integrations.externalAgents.defaults.toolGovernance",
									normalizeLegacyNamingValue(defaults.toolGovernance, "clio-policy", "clio-coder-policy"),
									TOOL_GOVERNANCE,
								);
								if (parsed !== undefined) settings.integrations.externalAgents.defaults.toolGovernance = parsed;
							}
						}
					}
					if ("entries" in external) {
						if (!Array.isArray(external.entries))
							issues.add("integrations.externalAgents.entries", `expected a list, got ${describe(external.entries)}`);
						else {
							const seen = new Set<string>();
							settings.integrations.externalAgents.entries = external.entries
								.map((entry, index) =>
									validateExternalAgent(
										issues,
										`integrations.externalAgents.entries[${index}]`,
										entry,
										settings.integrations.externalAgents.defaults,
										seen,
									),
								)
								.filter((entry): entry is ExternalAgent => entry !== null);
						}
					}
				}
			}
		}
	}

	return { settings, issues: issues.list };
}

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
export function applySettingsDelta(saved: unknown, before: unknown, after: unknown): unknown {
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

/**
 * Replace the raw user settings document under the same cross-process lock as
 * `updateSettings`. Workspace-aware layering owns the only current caller: it
 * computes and validates the candidate against the project layers before this
 * helper commits the raw user-layer delta.
 */
export function updateSavedSettingsDocument(
	mutate: (saved: unknown) => unknown,
	options: SettingsUpdateOptions = {},
): void {
	withSettingsLock(() => {
		// Keep the strict gate updateSettings has always used. readSavedDocument
		// deliberately degrades parse/read failures to `{}` for recovery callers;
		// writing through that degraded value would erase a malformed, null, or
		// transiently unreadable operator document.
		readSettings();
		const saved = readSavedDocument();
		persistSettings(mutate(cloneValue(saved)));
	}, options);
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
	settings.chat.target = target.id;
	settings.chat.model = options.orchestratorModel ?? sharedModel;
	settings.fleet.default.target = workerTarget.id;
	settings.fleet.default.model =
		options.workerModel ?? (workerTarget === target ? sharedModel : (workerTarget.defaultModel ?? null));
	if (options.backgroundModel !== undefined) {
		settings.context.memory.target = target.id;
		settings.context.memory.model = options.backgroundModel;
	}
	return { workerTargetId: workerTarget.id };
}

/** Drop a target and every routing field, profile, and scope entry that named it. */
export function removeTargetFromSettings(settings: ClioSettings, id: string): boolean {
	if (!settings.targets.some((entry) => entry.id === id)) return false;
	settings.targets = settings.targets.filter((entry) => entry.id !== id);
	if (settings.chat.target === id) {
		settings.chat.target = null;
		settings.chat.model = null;
	}
	if (settings.context.memory.target === id) {
		settings.context.memory.target = null;
		settings.context.memory.model = null;
	}
	if (settings.fleet.default.target === id) {
		settings.fleet.default.target = null;
		settings.fleet.default.model = null;
	}
	for (const [name, profile] of Object.entries(settings.fleet.profiles)) {
		if (profile.target === id) delete settings.fleet.profiles[name];
	}
	settings.chat.modelPicker.cycleSet = settings.chat.modelPicker.cycleSet.filter((entry) => entry.split("/")[0] !== id);
	settings.chat.modelPicker.favorites = settings.chat.modelPicker.favorites.filter(
		(entry) => entry.split("/")[0] !== id,
	);
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
	const existing = settings.fleet.profiles[name];
	settings.fleet.profiles[name] = {
		target: target.id,
		model: options.model ?? target.defaultModel ?? null,
		thinkingLevel: options.thinkingLevel ?? existing?.thinkingLevel ?? "off",
	};
	return true;
}

/** Remove a fleet profile and its agent bindings; returns how many bindings went with it. */
export function removeFleetProfileFromSettings(settings: ClioSettings, name: string): number {
	delete settings.fleet.profiles[name];
	let removedBindings = 0;
	for (const [agentId, profileName] of Object.entries(settings.fleet.agentProfiles)) {
		if (profileName !== name) continue;
		delete settings.fleet.agentProfiles[agentId];
		removedBindings += 1;
	}
	return removedBindings;
}

/** Bind a native agent to a profile. False for an ACP delegation agent, which ignores native routing. */
export function bindAgentProfileInSettings(settings: ClioSettings, agentId: string, profileName: string): boolean {
	if (settings.integrations.externalAgents.entries.some((agent) => agent.id === agentId)) return false;
	settings.fleet.agentProfiles[agentId] = profileName;
	return true;
}
