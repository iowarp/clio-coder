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

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { clioConfigDir, resolveClioDirs } from "./xdg.js";

export type ClioSettings = typeof DEFAULT_SETTINGS;

export function settingsPath(): string {
	return join(clioConfigDir(), "settings.yaml");
}

export interface SettingsIssue {
	/** Dotted key path, e.g. `orchestrator.target` or `targets[2].runtime`. */
	path: string;
	message: string;
}

export class SettingsValidationError extends Error {
	readonly issues: ReadonlyArray<SettingsIssue>;

	constructor(issues: ReadonlyArray<SettingsIssue>) {
		const lines = issues.map((issue) => `  ${issue.path}: ${issue.message}`);
		super(`settings.yaml failed validation:\n${lines.join("\n")}`);
		this.name = "SettingsValidationError";
		this.issues = issues;
	}
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

function expectInteger(issues: Issues, path: string, value: unknown, opts?: { min?: number }): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		issues.add(path, `expected an integer, got ${describe(value)}`);
		return undefined;
	}
	if (opts?.min !== undefined && value < opts.min) {
		issues.add(path, `expected an integer >= ${opts.min}, got ${value}`);
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
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
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
): ClioSettings["orchestrator"] {
	const out = cloneValue(defaults);
	if (!isPlainObject(value)) {
		issues.add(path, `expected a map, got ${describe(value)}`);
		return out;
	}
	issues.unknownKeys(path, value, ["target", "model", "thinkingLevel"]);
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

/** Scope entries: `targetId` or `targetId/wireModelId`, filtered to configured ids. */
function normalizeScope(
	refs: ReadonlyArray<string>,
	targets: ReadonlyArray<ClioSettings["targets"][number]>,
): string[] {
	const byId = new Set(targets.map((target) => target.id));
	const out: string[] = [];
	for (const ref of refs) {
		const [targetId] = ref.split("/");
		if (!targetId || !byId.has(targetId)) continue;
		if (!out.includes(ref)) out.push(ref);
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
		"labels",
	]);
	const id = "id" in value ? expectString(issues, `${path}.id`, value.id) : undefined;
	const command = "command" in value ? expectString(issues, `${path}.command`, value.command) : undefined;
	if (!("id" in value)) issues.add(`${path}.id`, "required");
	if (!("command" in value)) issues.add(`${path}.command`, "required");
	if (id === undefined || command === undefined) return null;
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
			const v = expectInteger(issues, `${path}.${key}`, value[key], { min: 0 });
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
					const v = expectInteger(issues, `delegation.defaults.${key}`, value.defaults[key], { min: 0 });
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
	"workers",
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
	if (raw === null || raw === undefined) return { settings, issues: issues.list };
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

	if ("workers" in raw) {
		if (!isPlainObject(raw.workers)) {
			issues.add("workers", `expected a map, got ${describe(raw.workers)}`);
		} else {
			issues.unknownKeys("workers", raw.workers, ["default", "profiles", "maxRetries", "onPermission"]);
			if ("default" in raw.workers) {
				settings.workers.default = validateWorkerTarget(
					issues,
					"workers.default",
					raw.workers.default,
					settings.workers.default,
					settings.targets,
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
						);
						if (!profile.target) continue;
						profiles[name] = profile;
					}
					settings.workers.profiles = profiles;
				}
			}
			if ("maxRetries" in raw.workers) {
				const v = expectInteger(issues, "workers.maxRetries", raw.workers.maxRetries, { min: 0 });
				if (v !== undefined) settings.workers.maxRetries = v;
			}
			if ("onPermission" in raw.workers) {
				const v = expectEnum(issues, "workers.onPermission", raw.workers.onPermission, ["deny", "fail"] as const);
				if (v !== undefined) settings.workers.onPermission = v;
			}
		}
	}

	if ("scope" in raw) {
		const v = expectStringArray(issues, "scope", raw.scope);
		if (v !== undefined) settings.scope = normalizeScope(v, settings.targets);
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
			issues.unknownKeys("terminal", raw.terminal, ["showTerminalProgress"]);
			if ("showTerminalProgress" in raw.terminal) {
				const v = expectBoolean(issues, "terminal.showTerminalProgress", raw.terminal.showTerminalProgress);
				if (v !== undefined) settings.terminal.showTerminalProgress = v;
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
			issues.unknownKeys("retry", raw.retry, ["enabled", "maxRetries", "baseDelayMs", "maxDelayMs"]);
			if ("enabled" in raw.retry) {
				const v = expectBoolean(issues, "retry.enabled", raw.retry.enabled);
				if (v !== undefined) settings.retry.enabled = v;
			}
			for (const key of ["maxRetries", "baseDelayMs", "maxDelayMs"] as const) {
				if (key in raw.retry) {
					const v = expectInteger(issues, `retry.${key}`, raw.retry[key], { min: 0 });
					if (v !== undefined) settings.retry[key] = v;
				}
			}
		}
	}

	return { settings, issues: issues.list };
}

/**
 * Validate the settings file on disk without throwing. Missing file is valid.
 * Resolves the path without the clioConfigDir mkdir side effect so read-only
 * surfaces (plain `clio doctor`, readSettings on a fresh machine) never
 * create directories.
 */
export function validateSettingsFile(): SettingsValidationResult {
	const path = join(resolveClioDirs().config, "settings.yaml");
	if (!existsSync(path)) return { settings: cloneValue(DEFAULT_SETTINGS), issues: [] };
	let parsed: unknown;
	try {
		parsed = parseYaml(readFileSync(path, "utf8"));
	} catch (err) {
		return {
			settings: cloneValue(DEFAULT_SETTINGS),
			issues: [{ path: "(root)", message: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` }],
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
function persistSettings(settings: ClioSettings): void {
	safeResourceWrite(settingsPath(), stringifyYaml(settings), { encoding: "utf8", mode: 0o644 });
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
	/**
	 * A lock file older than this is considered abandoned by a dead process
	 * and is taken over. Locked sections are a read + mutate + write of one
	 * small YAML file, so a healthy holder releases in milliseconds. Default 5s.
	 */
	staleLockMs?: number;
	/** Sleep between acquisition attempts. Default 25ms. */
	pollIntervalMs?: number;
}

export function settingsLockPath(): string {
	return `${settingsPath()}.lock`;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
}

function tryAcquireSettingsLock(lockPath: string, staleLockMs: number): boolean {
	try {
		writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, {
			encoding: "utf8",
			flag: "wx",
			mode: 0o644,
		});
		return true;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
	}
	try {
		if (Date.now() - statSync(lockPath).mtimeMs > staleLockMs) rmSync(lockPath, { force: true });
	} catch {
		// Lock vanished between the failed create and the stat: the holder
		// released it. The caller's next attempt will race for it normally.
	}
	return false;
}

/**
 * Run `fn` while holding the settings.yaml advisory lock. Factored out of
 * updateSettings so the one other sanctioned settings writer (lifecycle
 * migrations, which rewrite pre-schema files the strict reader would reject)
 * holds the same lock instead of racing updateSettings.
 */
export function withSettingsLock<T>(fn: () => T, options: SettingsUpdateOptions = {}): T {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const staleLockMs = options.staleLockMs ?? 5_000;
	const pollIntervalMs = options.pollIntervalMs ?? 25;
	const lockPath = settingsLockPath();
	const deadline = Date.now() + timeoutMs;
	while (!tryAcquireSettingsLock(lockPath, staleLockMs)) {
		if (Date.now() >= deadline) {
			throw new Error(
				`timed out after ${timeoutMs}ms waiting for ${lockPath}; delete it if no other clio process is running`,
			);
		}
		sleepSync(pollIntervalMs);
	}
	try {
		return fn();
	} finally {
		rmSync(lockPath, { force: true });
	}
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
		const current = readSettings();
		const next = mutate(current) ?? current;
		const revalidated = validateSettings(JSON.parse(JSON.stringify(next)));
		if (revalidated.issues.length > 0) throw new SettingsValidationError(revalidated.issues);
		persistSettings(revalidated.settings);
		return revalidated.settings;
	}, options);
}
