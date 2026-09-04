/**
 * Disposable per-target model catalogs discovered by provider probes.
 *
 * A live endpoint catalog is machine state, not operator policy. Persisting it
 * in settings.yaml made a three-target config carry hundreds of volatile model
 * ids. Cache files keep that snapshot available to a new process without
 * turning the hand-edited settings file into a probe transcript.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioCacheDir } from "../../core/xdg.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

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
	observedAt: string;
}

interface TargetModelCacheOptions {
	cacheDir?: string;
	nowMs?: number;
	ttlMs?: number;
	modelLabels?: Readonly<Record<string, string>>;
}

function targetCacheKey(targetId: string): string {
	return createHash("sha256").update(targetId).digest("hex").slice(0, 24);
}

export function targetModelSnapshotPath(targetId: string, cacheDir = clioCacheDir()): string {
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
	return snapshot;
}

/** Read a fresh snapshot only when it still describes this target identity. */
export function readTargetModelSnapshot(
	target: Pick<TargetDescriptor, "id" | "runtime" | "url">,
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
		return snapshot;
	} catch {
		return null;
	}
}

/** Best-effort atomic replacement of one target's disposable probe snapshot. */
export function recordTargetModelSnapshot(
	target: Pick<TargetDescriptor, "id" | "runtime" | "url">,
	models: ReadonlyArray<string>,
	options: Pick<TargetModelCacheOptions, "cacheDir" | "nowMs" | "modelLabels"> = {},
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
	try {
		safeResourceWrite(targetModelSnapshotPath(target.id, options.cacheDir), `${JSON.stringify(snapshot, null, 2)}\n`, {
			encoding: "utf8",
		});
		return true;
	} catch {
		return false;
	}
}
