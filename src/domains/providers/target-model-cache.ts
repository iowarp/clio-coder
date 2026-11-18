/**
 * Disposable per-target model catalogs discovered by provider probes.
 *
 * A live endpoint catalog is machine state, not operator policy. Persisting it
 * in settings.yaml made a three-target config carry hundreds of volatile model
 * ids. Cache files keep that snapshot available to a new process without
 * turning the hand-edited settings file into a probe transcript.
 *
 * Reading never creates the cache root.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioCacheDir, clioCachePath } from "../../core/xdg.js";
import { type CapabilityFlags, type ThinkingLevel, VALID_THINKING_LEVELS } from "./types/capability-flags.js";
import { type CopilotContextTier, copilotContextTierOf, type TargetDescriptor } from "./types/target-descriptor.js";

export const TARGET_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const TARGET_MODEL_CACHE_VERSION = 1;
const TARGET_MODEL_CACHE_MAX_MODELS = 4_096;
const TARGET_MODEL_CACHE_MAX_MODEL_ID_CHARS = 1_024;

export interface TargetModelSnapshot {
	version: 1;
	targetId: string;
	runtimeId: string;
	url: string | null;
	models: string[];
	modelLabels?: Record<string, string>;
	modelCreatedAt?: Record<string, string>;
	/**
	 * What the listing said about each model, for runtimes whose listing carries capabilities. A snapshot without
	 * it (every file written before it existed) still lists models, and its capabilities count as unknown.
	 */
	modelCapabilities?: Record<string, CachedModelCapabilities>;
	/**
	 * Each model's context window on every tier the listing published, for runtimes whose window depends on a
	 * target's context tier. `modelCapabilities` holds the writing target's tier; this lets any tier resolve.
	 */
	modelContextWindows?: Record<string, CachedContextWindows>;
	observedAt: string;
}

export type CachedContextWindows = Partial<Record<CopilotContextTier, number>>;

/** The listed capabilities a later process may trust: they describe the account's model, not a serving state. */
export type CachedModelCapabilities = Partial<
	Pick<
		CapabilityFlags,
		"reasoning" | "reasoningLevels" | "reasoningDefaultLevel" | "vision" | "contextWindow" | "maxTokens"
	>
>;

interface TargetModelCacheOptions {
	cacheDir?: string;
	nowMs?: number;
	ttlMs?: number;
	modelLabels?: Readonly<Record<string, string>>;
	modelCreatedAt?: Readonly<Record<string, string>>;
	modelCapabilities?: Readonly<Record<string, Partial<CapabilityFlags>>>;
	modelContextWindows?: Readonly<Record<string, CachedContextWindows>>;
}

function targetCacheKey(targetId: string): string {
	return createHash("sha256").update(targetId).digest("hex").slice(0, 24);
}

export function targetModelSnapshotPath(targetId: string, cacheDir = clioCachePath()): string {
	return join(cacheDir, "provider-target-models", `${targetCacheKey(targetId)}.json`);
}

function normalizedModels(models: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of models) {
		const model = raw.trim();
		if (model.length === 0 || model.length > TARGET_MODEL_CACHE_MAX_MODEL_ID_CHARS || seen.has(model)) continue;
		seen.add(model);
		out.push(model);
		if (out.length >= TARGET_MODEL_CACHE_MAX_MODELS) break;
	}
	return out;
}

function normalizedLabels(models: ReadonlyArray<string>, labels: unknown): Record<string, string> | undefined {
	if (typeof labels !== "object" || labels === null || Array.isArray(labels)) return undefined;
	const source = labels as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const id of models) {
		const label = source[id];
		if (typeof label !== "string") continue;
		const trimmed = label.trim();
		if (trimmed.length === 0 || trimmed.length > TARGET_MODEL_CACHE_MAX_MODEL_ID_CHARS || /[\r\n\0]/u.test(trimmed)) {
			continue;
		}
		out[id] = trimmed;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

const THINKING_LEVELS = new Set<string>(VALID_THINKING_LEVELS);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

function positiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cachedCapabilities(value: unknown): CachedModelCapabilities | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const row = value as Record<string, unknown>;
	const out: CachedModelCapabilities = {};
	if (typeof row.reasoning === "boolean") out.reasoning = row.reasoning;
	if (Array.isArray(row.reasoningLevels) && row.reasoningLevels.length > 0 && row.reasoningLevels.every(isThinkingLevel))
		out.reasoningLevels = [...new Set(row.reasoningLevels)];
	if (isThinkingLevel(row.reasoningDefaultLevel)) out.reasoningDefaultLevel = row.reasoningDefaultLevel;
	if (typeof row.vision === "boolean") out.vision = row.vision;
	if (positiveInteger(row.contextWindow)) out.contextWindow = row.contextWindow;
	if (positiveInteger(row.maxTokens)) out.maxTokens = row.maxTokens;
	return out;
}

function normalizedCapabilities(
	models: ReadonlyArray<string>,
	capabilities: unknown,
): Record<string, CachedModelCapabilities> | undefined {
	if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) return undefined;
	const source = capabilities as Record<string, unknown>;
	const out: Record<string, CachedModelCapabilities> = {};
	for (const id of models) {
		const row = cachedCapabilities(source[id]);
		if (row !== null) out[id] = row;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Kept only when every model has an entry, possibly empty: a partial record cannot vouch for any tier. */
function normalizedContextWindows(
	models: ReadonlyArray<string>,
	windows: unknown,
): Record<string, CachedContextWindows> | undefined {
	if (typeof windows !== "object" || windows === null || Array.isArray(windows) || models.length === 0) return undefined;
	const source = windows as Record<string, unknown>;
	const out: Record<string, CachedContextWindows> = {};
	for (const id of models) {
		const row = source[id];
		if (typeof row !== "object" || row === null || Array.isArray(row)) return undefined;
		const tiers = row as Record<string, unknown>;
		const entry: CachedContextWindows = {};
		if (positiveInteger(tiers.default)) entry.default = tiers.default;
		if (positiveInteger(tiers.long_context)) entry.long_context = tiers.long_context;
		out[id] = entry;
	}
	return out;
}

function parseSnapshot(value: unknown): TargetModelSnapshot | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const row = value as Partial<TargetModelSnapshot>;
	if (row.version !== TARGET_MODEL_CACHE_VERSION) return null;
	if (typeof row.targetId !== "string" || row.targetId.length === 0) return null;
	if (typeof row.runtimeId !== "string" || row.runtimeId.length === 0) return null;
	if (row.url !== null && typeof row.url !== "string") return null;
	if (!Array.isArray(row.models) || row.models.some((model) => typeof model !== "string")) return null;
	if (typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt))) return null;
	const models = normalizedModels(row.models);
	if (models.length !== row.models.length) return null;
	const snapshot: TargetModelSnapshot = {
		version: TARGET_MODEL_CACHE_VERSION,
		targetId: row.targetId,
		runtimeId: row.runtimeId,
		url: row.url,
		models,
		observedAt: row.observedAt,
	};
	const modelLabels = normalizedLabels(models, row.modelLabels);
	if (modelLabels !== undefined) snapshot.modelLabels = modelLabels;
	const modelCreatedAt = normalizedLabels(models, row.modelCreatedAt);
	if (modelCreatedAt !== undefined) snapshot.modelCreatedAt = modelCreatedAt;
	const modelCapabilities = normalizedCapabilities(models, row.modelCapabilities);
	if (modelCapabilities !== undefined) snapshot.modelCapabilities = modelCapabilities;
	const modelContextWindows = normalizedContextWindows(models, row.modelContextWindows);
	if (modelContextWindows !== undefined) snapshot.modelContextWindows = modelContextWindows;
	return snapshot;
}

/**
 * The listed capabilities as the reading target's context tier sees them. The file is keyed by target id alone, so
 * `modelCapabilities` holds the writer's tier: each window is replaced by the reader's tier window from the per-tier
 * record. A Copilot snapshot written before that record existed does not say which tier wrote it, so its windows
 * are dropped rather than trusted.
 */
function projectToReaderTier(
	snapshot: TargetModelSnapshot,
	target: Pick<TargetDescriptor, "runtime" | "contextTier">,
): TargetModelSnapshot {
	const capabilities = snapshot.modelCapabilities;
	const windows = snapshot.modelContextWindows;
	if (!capabilities || (!windows && snapshot.runtimeId !== "copilot-sdk")) return snapshot;
	const tier = copilotContextTierOf(target);
	const projected: Record<string, CachedModelCapabilities> = {};
	for (const [id, caps] of Object.entries(capabilities)) {
		const { contextWindow: _writersTier, ...rest } = caps;
		const tiers = windows?.[id];
		const window = tier === "long_context" ? (tiers?.long_context ?? tiers?.default) : tiers?.default;
		projected[id] = window !== undefined ? { ...rest, contextWindow: window } : rest;
	}
	return { ...snapshot, modelCapabilities: projected };
}

/** Read a fresh snapshot only when it still describes this target identity. */
export function readTargetModelSnapshot(
	target: Pick<TargetDescriptor, "id" | "runtime" | "url"> & Partial<Pick<TargetDescriptor, "contextTier">>,
	options: TargetModelCacheOptions = {},
): TargetModelSnapshot | null {
	const path = targetModelSnapshotPath(target.id, options.cacheDir);
	if (!existsSync(path)) return null;
	try {
		const snapshot = parseSnapshot(JSON.parse(readFileSync(path, "utf8")) as unknown);
		if (snapshot === null) return null;
		if (snapshot.targetId !== target.id || snapshot.runtimeId !== target.runtime) return null;
		if (snapshot.url !== (target.url ?? null)) return null;
		const observedMs = Date.parse(snapshot.observedAt);
		const nowMs = options.nowMs ?? Date.now();
		const ttlMs = options.ttlMs ?? TARGET_MODEL_CACHE_TTL_MS;
		if (observedMs > nowMs || nowMs - observedMs >= ttlMs) return null;
		return projectToReaderTier(snapshot, target);
	} catch {
		return null;
	}
}

/** Best-effort atomic replacement of one target's disposable probe snapshot. */
export function recordTargetModelSnapshot(
	target: Pick<TargetDescriptor, "id" | "runtime" | "url"> & Partial<Pick<TargetDescriptor, "contextTier">>,
	models: ReadonlyArray<string>,
	options: Pick<
		TargetModelCacheOptions,
		"cacheDir" | "nowMs" | "modelLabels" | "modelCreatedAt" | "modelCapabilities" | "modelContextWindows"
	> = {},
): boolean {
	if (target.id.length === 0 || target.runtime.length === 0) return false;
	const snapshot: TargetModelSnapshot = {
		version: TARGET_MODEL_CACHE_VERSION,
		targetId: target.id,
		runtimeId: target.runtime,
		url: target.url ?? null,
		models: normalizedModels(models),
		observedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
	};
	const modelLabels = normalizedLabels(snapshot.models, options.modelLabels);
	if (modelLabels !== undefined) snapshot.modelLabels = modelLabels;
	const modelCreatedAt = normalizedLabels(snapshot.models, options.modelCreatedAt);
	if (modelCreatedAt !== undefined) snapshot.modelCreatedAt = modelCreatedAt;
	const modelCapabilities = normalizedCapabilities(snapshot.models, options.modelCapabilities);
	if (modelCapabilities !== undefined) snapshot.modelCapabilities = modelCapabilities;
	const modelContextWindows = normalizedContextWindows(snapshot.models, options.modelContextWindows);
	if (modelContextWindows !== undefined) snapshot.modelContextWindows = modelContextWindows;
	try {
		// Every successful probe confirms the same list. Rewriting it costs a synchronous fsync on the probe path,
		// so a snapshot that already says the same and is not yet half way to expiry stands as written.
		const existing = readTargetModelSnapshot(target, {
			...(options.cacheDir !== undefined ? { cacheDir: options.cacheDir } : {}),
			...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
			ttlMs: TARGET_MODEL_CACHE_TTL_MS / 2,
		});
		if (existing !== null && sameSnapshotContent(existing, snapshot)) return true;
		// The writer's root check; reads resolve the root without creating it.
		const cacheDir = options.cacheDir ?? clioCacheDir();
		safeResourceWrite(targetModelSnapshotPath(target.id, cacheDir), `${JSON.stringify(snapshot, null, 2)}\n`, {
			encoding: "utf8",
		});
		return true;
	} catch {
		return false;
	}
}

function sameSnapshotContent(left: TargetModelSnapshot, right: TargetModelSnapshot): boolean {
	const { observedAt: _left, ...leftContent } = left;
	const { observedAt: _right, ...rightContent } = right;
	return JSON.stringify(leftContent) === JSON.stringify(rightContent);
}
