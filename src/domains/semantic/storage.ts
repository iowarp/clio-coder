import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { SemanticLimits, SemanticProfile, SemanticRecord } from "./types.js";

export const SEMANTIC_FORMAT = 1;
export const DEFAULT_SEMANTIC_LIMITS: SemanticLimits = {
	maxRecords: 10_000,
	maxBytes: 64 * 1024 * 1024,
	maxTextChars: 12_000,
	batchSize: 16,
	maxEmbeddingsPerDay: 10_000,
	queryTimeoutMs: 5_000,
	searchBudgetMs: 100,
};

export function sourceHash(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function semanticProfileKey(profile: SemanticProfile): string {
	if (!profile.id || !Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1 || profile.dimensions > 8192)
		throw new Error("Invalid semantic profile identity or dimensions");
	if (!Object.keys(profile.identity).length || Object.values(profile.identity).some((v) => typeof v !== "string" || !v))
		throw new Error("Semantic profile needs an explicit configured asset/recipe identity");
	return sourceHash(
		JSON.stringify([
			profile.id,
			profile.dimensions,
			Object.entries(profile.identity).sort(([a], [b]) => a.localeCompare(b)),
		]),
	);
}

export function recordFingerprint(record: SemanticRecord): string {
	return sourceHash(JSON.stringify(record));
}

export function validateVector(vector: readonly number[], dimensions: number): void {
	if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((v) => !Number.isFinite(v)))
		throw new Error("Semantic vector has invalid dimensions or non-finite values");
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	if (Math.abs(norm - 1) > 0.001) throw new Error("Semantic vector must be nonzero and L2 normalized");
}

export interface Generation {
	version: 1;
	projectId: string;
	profileKey: string;
	profile: SemanticProfile;
	generation: string;
	createdAt: string;
	records: SemanticRecord[];
	vectors: Record<string, number[]>;
	tombstones: string[];
}

export interface Checkpoint {
	version: 1;
	projectId: string;
	profileKey: string;
	snapshotHash: string;
	vectors: Record<string, number[]>;
	pending: string[];
	failed: Record<string, string>;
	day: string;
	spent: number;
}

export class SemanticStorage {
	constructor(
		readonly directory: string,
		readonly maxBytes: number,
	) {}

	read<T>(name: string): T | null {
		const path = join(this.directory, name);
		if (!existsSync(path)) return null;
		if (statSync(path).size > this.maxBytes) throw new Error("Semantic storage byte limit exceeded");
		return JSON.parse(readFileSync(path, "utf8")) as T;
	}

	write(name: string, value: unknown): void {
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text) > this.maxBytes) throw new Error("Semantic storage byte limit exceeded");
		safeResourceWrite(join(this.directory, name), text, { mode: 0o600 });
	}

	load(projectId: string, profileKey: string): Generation | null {
		const manifest = this.read<{
			version: number;
			projectId: string;
			profileKey: string;
			generation: string;
			sha256: string;
		}>("manifest.json");
		if (!manifest) return null;
		if (
			manifest.version !== SEMANTIC_FORMAT ||
			manifest.projectId !== projectId ||
			manifest.profileKey !== profileKey ||
			!/^[a-f0-9-]+$/.test(manifest.generation)
		)
			throw new Error("Semantic manifest identity mismatch");
		const data = this.read<Generation>(`generation-${manifest.generation}.json`);
		if (
			!data ||
			sourceHash(JSON.stringify(data)) !== manifest.sha256 ||
			data.projectId !== projectId ||
			data.profileKey !== profileKey ||
			data.generation !== manifest.generation ||
			semanticProfileKey(data.profile) !== profileKey
		)
			throw new Error("Semantic generation checksum or identity mismatch");
		return data;
	}

	pruneGenerations(keep: string | null): void {
		if (!existsSync(this.directory)) return;
		for (const name of readdirSync(this.directory)) {
			if (/^generation-[a-f0-9-]+\.json$/.test(name) && name !== `generation-${keep}.json`)
				rmSync(join(this.directory, name));
		}
	}

	commit(data: Generation): void {
		this.write(`generation-${data.generation}.json`, data);
		// The manifest is the only visibility switch; interruption leaves the old complete generation readable.
		this.write("manifest.json", {
			version: SEMANTIC_FORMAT,
			projectId: data.projectId,
			profileKey: data.profileKey,
			generation: data.generation,
			sha256: sourceHash(JSON.stringify(data)),
		});
	}
}
