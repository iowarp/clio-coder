import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import type { ClioSettings } from "../../core/config.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import { resolveClioDirs } from "../../core/xdg.js";
import {
	type CapabilityFlags,
	STRUCTURED_OUTPUT_MODES,
	THINKING_FORMATS,
	TOOL_CALL_FORMATS,
} from "./types/capability-flags.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";

export interface ModelProfile {
	id: string;
	match: {
		exactIds?: string[];
		/** Whole model-name prefixes only; never substring searches. */
		familyPrefixes?: string[];
		/** A qualified profile wins a tie against an unqualified one. */
		runtimeIds?: string[];
	};
	claims: {
		/** Unverified catalog ceiling, never this deployment's serving window. */
		modelMaxContext?: number;
		modelMaxOutput?: number;
		capabilities?: Partial<Omit<CapabilityFlags, "contextWindow" | "maxTokens">>;
	};
	behavior?: Record<string, unknown>;
	recommendations?: Record<string, unknown>;
	provenance?: Record<string, unknown>;
}

export interface ModelProfileHit {
	profile: ModelProfile;
	kind: "exact" | "family";
}

export interface ProfileComparison {
	targetId: string;
	runtimeId: string;
	modelId: string | null;
	profileId: string | null;
	legacyFamily: string | null;
	differentFields: string[];
}

function record(value: unknown, where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object`);
	return value as Record<string, unknown>;
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) throw new Error(`${where}: unknown field '${key}'`);
	}
}

function nonempty(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
		throw new Error(`${where} must be a nonempty, trimmed string`);
	}
	return value;
}

function stringList(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.length === 0) throw new Error(`${where} must be a nonempty string list`);
	const out = value.map((item, index) => nonempty(item, `${where}[${index}]`));
	if (new Set(out.map((item) => item.toLowerCase())).size !== out.length) {
		throw new Error(`${where} contains duplicate values`);
	}
	return out;
}

function positiveInteger(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${where} must be a positive integer`);
	}
	return value;
}

const CAPABILITY_BOOLEANS: readonly string[] = [
	"chat",
	"tools",
	"reasoning",
	"vision",
	"audio",
	"embeddings",
	"rerank",
	"fim",
	"decisions",
];

const CAPABILITY_ENUMS: Readonly<Record<string, readonly string[]>> = {
	toolCallFormat: TOOL_CALL_FORMATS,
	thinkingFormat: THINKING_FORMATS,
	structuredOutputs: STRUCTURED_OUTPUT_MODES,
};

/** Fields only a live server report sets: a profile describes the model, not this deployment. */
const LIVE_ONLY_CAPABILITY_FIELDS: readonly string[] = [
	"contextWindow",
	"maxTokens",
	"reasoningLevels",
	"thinkingControlRuntime",
	"parallelSlots",
];

/** Why a profile may not carry this capability value, or null when it may. */
function capabilityProblem(key: string, value: unknown): string | null {
	if (LIVE_ONLY_CAPABILITY_FIELDS.includes(key)) {
		return "is a live server report, so a profile cannot set it";
	}
	if (CAPABILITY_BOOLEANS.includes(key)) return typeof value === "boolean" ? null : "must be true or false";
	const allowed = CAPABILITY_ENUMS[key];
	if (allowed)
		return typeof value === "string" && allowed.includes(value) ? null : `must be one of ${allowed.join(", ")}`;
	return "is not a profile capability field";
}

function validateProfile(value: unknown, where: string): ModelProfile {
	const item = record(value, where);
	keysOnly(item, ["id", "match", "claims", "behavior", "recommendations", "provenance"], where);
	nonempty(item.id, `${where}.id`);
	const match = record(item.match, `${where}.match`);
	keysOnly(match, ["exactIds", "familyPrefixes", "runtimeIds"], `${where}.match`);
	const exactIds = match.exactIds === undefined ? undefined : stringList(match.exactIds, `${where}.match.exactIds`);
	const familyPrefixes =
		match.familyPrefixes === undefined ? undefined : stringList(match.familyPrefixes, `${where}.match.familyPrefixes`);
	if (match.runtimeIds !== undefined) stringList(match.runtimeIds, `${where}.match.runtimeIds`);
	if (!exactIds && !familyPrefixes) throw new Error(`${where}.match needs exactIds or familyPrefixes`);
	for (const prefix of familyPrefixes ?? []) {
		if (prefix.includes("/") || /[?*^$[\]{}()|\\]/u.test(prefix)) {
			throw new Error(`${where}.match.familyPrefixes must contain literal model-name prefixes`);
		}
	}
	const claims = record(item.claims, `${where}.claims`);
	keysOnly(claims, ["modelMaxContext", "modelMaxOutput", "capabilities"], `${where}.claims`);
	if (claims.modelMaxContext !== undefined) positiveInteger(claims.modelMaxContext, `${where}.claims.modelMaxContext`);
	if (claims.modelMaxOutput !== undefined) positiveInteger(claims.modelMaxOutput, `${where}.claims.modelMaxOutput`);
	if (claims.capabilities !== undefined) {
		const capabilities = record(claims.capabilities, `${where}.claims.capabilities`);
		if ("contextWindow" in capabilities || "maxTokens" in capabilities) {
			throw new Error(`${where}.claims.capabilities cannot contain serving or output limits`);
		}
		for (const [key, value] of Object.entries(capabilities)) {
			const problem = capabilityProblem(key, value);
			if (problem) throw new Error(`${where}.claims.capabilities.${key} ${problem}`);
		}
	}
	for (const field of ["behavior", "recommendations", "provenance"] as const) {
		if (item[field] !== undefined) record(item[field], `${where}.${field}`);
	}
	return item as unknown as ModelProfile;
}

function parseManifest(path: string): unknown[] {
	const document = record(parseYaml(readFileSync(path, "utf8")), path);
	keysOnly(document, ["version", "models"], path);
	if (document.version !== 1 || !Array.isArray(document.models)) {
		throw new Error(`${path} must contain version: 1 and a models list`);
	}
	return document.models;
}

function mergeFields(base: unknown, patch: unknown): unknown {
	if (
		!base ||
		typeof base !== "object" ||
		Array.isArray(base) ||
		!patch ||
		typeof patch !== "object" ||
		Array.isArray(patch)
	) {
		return structuredClone(patch);
	}
	const merged = structuredClone(base) as Record<string, unknown>;
	for (const [key, value] of Object.entries(patch))
		merged[key] = key in merged ? mergeFields(merged[key], value) : structuredClone(value);
	return merged;
}

function runtimeScopesOverlap(a?: string[], b?: string[]): boolean {
	return !a || !b || a.some((runtime) => b.some((other) => runtime.toLowerCase() === other.toLowerCase()));
}

function validateUniqueMatches(profiles: readonly ModelProfile[]): void {
	for (let i = 0; i < profiles.length; i++) {
		const a = profiles[i];
		if (!a) continue;
		for (const b of profiles.slice(i + 1)) {
			// The runtime-qualified entry deliberately overrides an unqualified tie.
			if (Boolean(a.match.runtimeIds) !== Boolean(b.match.runtimeIds)) continue;
			if (!runtimeScopesOverlap(a.match.runtimeIds, b.match.runtimeIds)) continue;
			for (const kind of ["exactIds", "familyPrefixes"] as const) {
				const left = new Set((a.match[kind] ?? []).map((value) => value.toLowerCase()));
				const duplicate = (b.match[kind] ?? []).find((value) => left.has(value.toLowerCase()));
				if (duplicate) throw new Error(`ambiguous model profile ${kind} '${duplicate}': ${a.id} and ${b.id}`);
			}
		}
	}
}

export class ModelProfiles {
	private readonly loaded: readonly ModelProfile[];

	constructor(profiles: readonly ModelProfile[]) {
		const ids = new Set<string>();
		for (const profile of profiles) {
			const key = profile.id.toLowerCase();
			if (ids.has(key)) throw new Error(`duplicate model profile id '${profile.id}'`);
			ids.add(key);
		}
		validateUniqueMatches(profiles);
		this.loaded = profiles;
	}

	entries(): readonly ModelProfile[] {
		return this.loaded;
	}

	lookup(modelId: string, runtimeId?: string): ModelProfileHit | null {
		const full = modelId.trim().toLowerCase();
		const modelName = full.split("/").at(-1) ?? full;
		const runtime = runtimeId?.trim().toLowerCase();
		let best: { hit: ModelProfileHit; rank: number; length: number; qualified: number } | null = null;
		for (const profile of this.loaded) {
			const runtimeIds = profile.match.runtimeIds;
			if (runtimeIds && (!runtime || !runtimeIds.some((id) => id.toLowerCase() === runtime))) continue;
			const exact = (profile.match.exactIds ?? []).find((id) => id.toLowerCase() === full);
			const prefix = (profile.match.familyPrefixes ?? [])
				.filter((value) => {
					const candidate = value.toLowerCase();
					return modelName === candidate || ["-", "_", ".", "@"].some((mark) => modelName.startsWith(candidate + mark));
				})
				.sort((a, b) => b.length - a.length)[0];
			if (!exact && !prefix) continue;
			const candidate = {
				hit: { profile, kind: exact ? "exact" : "family" } as ModelProfileHit,
				rank: exact ? 2 : 1,
				length: exact?.length ?? prefix?.length ?? 0,
				qualified: runtimeIds ? 1 : 0,
			};
			if (
				!best ||
				candidate.rank > best.rank ||
				(candidate.rank === best.rank &&
					(candidate.length > best.length || (candidate.length === best.length && candidate.qualified > best.qualified)))
			) {
				best = candidate;
			} else if (
				candidate.rank === best.rank &&
				candidate.length === best.length &&
				candidate.qualified === best.qualified
			) {
				throw new Error(`ambiguous model profile for '${modelId}': ${best.hit.profile.id} and ${profile.id}`);
			}
		}
		return best?.hit ?? null;
	}
}

/**
 * The operator's override entry with every bad field removed and reported, so one wrong value
 * costs that field and never the entry, the file or the packaged profiles. `match` is left to
 * the merged profile's validation because it is the entry's identity.
 */
function withoutBadUserFields(
	patch: Record<string, unknown>,
	entry: string,
	warn: (message: string) => void,
): Record<string, unknown> {
	const drop = (field: string, problem: string): void => warn(`${entry}: ${field} ignored, ${problem}`);
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (!["id", "match", "claims", "behavior", "recommendations", "provenance"].includes(key)) {
			drop(key, "unknown field");
		} else if (["behavior", "recommendations", "provenance"].includes(key) && !isPlainRecord(value)) {
			drop(key, "must be an object");
		} else {
			out[key] = value;
		}
	}
	if (out.claims === undefined) return out;
	if (!isPlainRecord(out.claims)) {
		drop("claims", "must be an object");
		delete out.claims;
		return out;
	}
	const claims: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(out.claims)) {
		if (key === "modelMaxContext" || key === "modelMaxOutput") {
			if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) claims[key] = value;
			else drop(`claims.${key}`, "must be a positive integer");
		} else if (key === "capabilities") {
			if (!isPlainRecord(value)) {
				drop("claims.capabilities", "must be an object");
				continue;
			}
			const capabilities: Record<string, unknown> = {};
			for (const [field, fieldValue] of Object.entries(value)) {
				const problem = capabilityProblem(field, fieldValue);
				if (problem) drop(`claims.capabilities.${field}`, problem);
				else capabilities[field] = fieldValue;
			}
			claims.capabilities = capabilities;
		} else {
			drop(`claims.${key}`, "unknown field");
		}
	}
	out.claims = claims;
	return out;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Packaged profiles first, then the operator's file layered on them field by field. The packaged
 * file is ours, so any fault in it throws. The operator's file is theirs: a bad field or entry is
 * dropped with a warning naming the file and entry, and the rest still loads.
 */
export function loadModelProfiles(
	options: { packagedPath?: string; userPath?: string; onWarning?: (message: string) => void } = {},
): ModelProfiles {
	const packagedPath = options.packagedPath ?? join(resolvePackageRoot(), "models", "profiles.yaml");
	const userPath = options.userPath ?? join(resolveClioDirs().config, "model-profiles.yaml");
	const warn = options.onWarning ?? (() => undefined);
	const byId = new Map<string, unknown>();
	for (const [index, item] of parseManifest(packagedPath).entries()) {
		const profile = validateProfile(item, `${packagedPath}.models[${index}]`);
		if (byId.has(profile.id.toLowerCase())) throw new Error(`${packagedPath}: duplicate id '${profile.id}'`);
		byId.set(profile.id.toLowerCase(), profile);
	}
	if (existsSync(userPath)) {
		let overrides: unknown[] = [];
		try {
			overrides = parseManifest(userPath);
		} catch (err) {
			warn(`${userPath} ignored: ${err instanceof Error ? err.message : String(err)}`);
		}
		const overridden = new Set<string>();
		for (const [index, item] of overrides.entries()) {
			const id = isPlainRecord(item) && typeof item.id === "string" ? item.id : "";
			const entry = `${userPath} entry ${id ? `'${id}'` : `#${index}`}`;
			if (!isPlainRecord(item) || id.trim() !== id || id.length === 0) {
				warn(`${entry} skipped: needs a nonempty string id`);
				continue;
			}
			const key = id.toLowerCase();
			if (overridden.has(key)) {
				warn(`${entry} skipped: duplicate override id`);
				continue;
			}
			overridden.add(key);
			const patch = withoutBadUserFields(item, entry, warn);
			try {
				const merged = byId.has(key) ? mergeFields(byId.get(key), patch) : patch;
				byId.set(key, validateProfile(merged, entry));
			} catch (err) {
				warn(`${entry} skipped: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}
	return new ModelProfiles([...byId.values()] as ModelProfile[]);
}

/**
 * Comparison mode for the fields step 4 has not switched. Capability flags, windows, output
 * caps and the thinking block are read from the profile now, so the legacy catalog no longer
 * has a vote on them; sampling and the free-form serving notes still come from it.
 */
export function compareConfiguredModelProfiles(
	settings: Pick<ClioSettings, "targets" | "chat" | "fleet" | "context">,
	profiles: ModelProfiles,
	legacy: KnowledgeBase,
): ProfileComparison[] {
	const rows: ProfileComparison[] = [];
	for (const target of settings.targets) {
		const models = new Set<string>();
		if (target.defaultModel?.trim()) models.add(target.defaultModel.trim());
		if (settings.chat.target === target.id && settings.chat.model?.trim()) models.add(settings.chat.model.trim());
		for (const route of [settings.fleet.default, ...Object.values(settings.fleet.profiles), settings.context.memory]) {
			if (route.target === target.id && route.model?.trim()) models.add(route.model.trim());
		}
		for (const modelId of models.size ? models : [null]) {
			const profile = modelId ? (profiles.lookup(modelId, target.runtime)?.profile ?? null) : null;
			const old = modelId ? (legacy.lookup(modelId)?.entry ?? null) : null;
			const differentFields: string[] = [];
			if (profile && old) {
				for (const [key, value] of Object.entries(old.quirks ?? {})) {
					if (key === "thinking") continue;
					const projected = key === "measuredUnder" ? profile.provenance?.measuredUnder : profile.recommendations?.[key];
					if (!isDeepStrictEqual(value, projected)) differentFields.push(`quirks.${key}`);
				}
			}
			rows.push({
				targetId: target.id,
				runtimeId: target.runtime,
				modelId,
				profileId: profile?.id ?? null,
				legacyFamily: old?.family ?? null,
				differentFields,
			});
		}
	}
	return rows;
}
