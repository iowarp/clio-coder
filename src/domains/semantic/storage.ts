import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import type { SemanticLimits, SemanticProfile, SemanticRecord } from "./types.js";

export const SEMANTIC_FORMAT = 2;
export const DEFAULT_SEMANTIC_LIMITS: SemanticLimits = {
	maxRecords: 10_000,
	maxBytes: 64 * 1024 * 1024,
	maxTextChars: 12_000,
	batchSize: 16,
	maxEmbeddingsPerDay: 10_000,
	queryTimeoutMs: 5_000,
	documentTimeoutMs: 30_000,
	searchBudgetMs: 100,
};

export function sourceHash(content: string | Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

export function semanticProfileKey(profile: SemanticProfile): string {
	if (!profile.id || !Number.isSafeInteger(profile.dimensions) || profile.dimensions < 1 || profile.dimensions > 8192)
		throw new Error("Invalid semantic profile identity or dimensions");
	if (!/^[a-f0-9]{64}$/.test(profile.profileIdentity))
		throw new Error("Semantic profile requires the embedder's exact SHA-256 recipe identity");
	return profile.profileIdentity;
}

/** Preserve the provider-owned recipe identity verbatim; this domain never re-hashes it. */
export function embeddingProfileToSemanticProfile<T extends { id: string; dimensions: number }>(
	profile: T,
	profileIdentity: string,
): SemanticProfile {
	const result: SemanticProfile = {
		id: profile.id,
		dimensions: profile.dimensions,
		profileIdentity,
		identity: structuredClone(Object.fromEntries(Object.entries(profile))),
	};
	semanticProfileKey(result);
	return result;
}

export function recordFingerprint(record: SemanticRecord): string {
	return sourceHash(
		JSON.stringify([record.extractionVersion, record.input, record.input.kind === "text" ? null : record.contentHash]),
	);
}

export function validateVector(vector: ArrayLike<number>, dimensions: number): void {
	if (vector.length !== dimensions) throw new Error("Semantic vector has invalid dimensions or non-finite values");
	let norm = 0;
	for (let i = 0; i < vector.length; i++) {
		const value = vector[i] ?? Number.NaN;
		if (!Number.isFinite(value)) throw new Error("Semantic vector has invalid dimensions or non-finite values");
		norm += value * value;
	}
	if (Math.abs(Math.sqrt(norm) - 1) > 0.001) throw new Error("Semantic vector must be nonzero and L2 normalized");
}

/** Float32 base64 keeps a 768d vector near 4 KiB; JSON doubles took 16 KiB and capped a generation near 1,300 records. */
export function encodeVector(vector: ArrayLike<number>): string {
	return Buffer.from(Float32Array.from(vector).buffer).toString("base64");
}

export function decodeVector(encoded: string, dimensions: number): Float32Array {
	const bytes = Buffer.from(encoded, "base64");
	if (bytes.length !== dimensions * 4) throw new Error("Semantic vector has invalid dimensions or non-finite values");
	const vector = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
	validateVector(vector, dimensions);
	return vector;
}

/** Text records embed their own text; storing it again as input would double every generation. */
function compactRecord(record: SemanticRecord): unknown {
	return record.input.kind === "text" && record.input.text === record.text
		? { ...record, input: { kind: "text" } }
		: record;
}

function expandRecord(record: SemanticRecord): SemanticRecord {
	return record.input.kind === "text" && record.input.text === undefined
		? { ...record, input: { kind: "text", text: record.text } }
		: record;
}

/** Bytes a record adds to a generation file, for trimming before any embedding is spent. */
export function storedRecordBytes(record: SemanticRecord, dimensions: number): number {
	return (
		Buffer.byteLength(JSON.stringify(compactRecord(record))) + record.id.length + Math.ceil((dimensions * 4) / 3) * 4 + 8
	);
}

export interface Generation {
	version: typeof SEMANTIC_FORMAT;
	projectId: string;
	profileKey: string;
	profile: SemanticProfile;
	generation: string;
	createdAt: string;
	records: SemanticRecord[];
	/** Encoded vectors by record ID. */
	vectors: Record<string, string>;
	tombstones: string[];
}

export interface Checkpoint {
	version: typeof SEMANTIC_FORMAT;
	projectId: string;
	profileKey: string;
	snapshotHash: string;
	/** Encoded vectors by record fingerprint, so finished work survives source edits and line shifts. */
	vectors: Record<string, string>;
	pending: string[];
	failed: Record<string, string>;
	day: string;
	spent: number;
}

/** The TUI reopens the index for every search; reparsing and rehashing a 20 MiB generation took about 180 ms. */
let lastLoaded: { key: string; data: Generation } | undefined;

export class SemanticStorage {
	constructor(
		readonly directory: string,
		readonly maxBytes: number,
	) {}

	read<T>(name: string): T | null {
		const text = this.readText(name);
		return text === null ? null : (JSON.parse(text) as T);
	}

	private readText(name: string): string | null {
		const path = join(this.directory, name);
		if (!existsSync(path)) return null;
		if (statSync(path).size > this.maxBytes) throw new Error("Semantic storage byte limit exceeded");
		return readFileSync(path, "utf8");
	}

	write(name: string, value: unknown): void {
		const text = JSON.stringify(value);
		if (Buffer.byteLength(text) > this.maxBytes) throw new Error("Semantic storage byte limit exceeded");
		safeResourceWrite(join(this.directory, name), text, { mode: 0o600 });
	}

	load(projectId: string, profileKey: string, attempts = 2): Generation | null {
		const manifest = this.read<{
			version: number;
			projectId: string;
			profileKey: string;
			generation: string;
			sha256: string;
		}>("manifest.json");
		// An older format is derived data the next refresh replaces, not a reason to fail status or search.
		if (!manifest || manifest.version !== SEMANTIC_FORMAT) return null;
		if (
			manifest.projectId !== projectId ||
			manifest.profileKey !== profileKey ||
			!/^[a-f0-9-]+$/.test(manifest.generation)
		)
			throw new Error("Semantic manifest identity mismatch");
		const stamp = statSync(join(this.directory, `generation-${manifest.generation}.json`), { throwIfNoEntry: false });
		const key = `${this.directory}\0${manifest.sha256}\0${stamp?.size}\0${stamp?.mtimeMs}`;
		if (stamp && lastLoaded?.key === key) return lastLoaded.data;
		let text: string | null;
		try {
			text = this.readText(`generation-${manifest.generation}.json`);
		} catch (error) {
			const current = this.read<{ generation: string }>("manifest.json");
			if (attempts > 0 && current?.generation !== manifest.generation)
				return this.load(projectId, profileKey, attempts - 1);
			throw error;
		}
		if (text === null && attempts > 0) {
			const current = this.read<{ generation: string }>("manifest.json");
			if (current?.generation !== manifest.generation) return this.load(projectId, profileKey, attempts - 1);
		}
		// Hash the bytes as written; re-serializing a parsed 20 MiB generation per load cost more than the parse.
		if (text === null || sourceHash(text) !== manifest.sha256)
			throw new Error("Semantic generation checksum or identity mismatch");
		const data = JSON.parse(text) as Generation;
		if (
			data.projectId !== projectId ||
			data.profileKey !== profileKey ||
			data.generation !== manifest.generation ||
			semanticProfileKey(data.profile) !== profileKey
		)
			throw new Error("Semantic generation checksum or identity mismatch");
		data.records = data.records.map(expandRecord);
		lastLoaded = { key, data };
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
		const text = JSON.stringify({ ...data, records: data.records.map(compactRecord) });
		if (Buffer.byteLength(text) > this.maxBytes) throw new Error("Semantic storage byte limit exceeded");
		safeResourceWrite(join(this.directory, `generation-${data.generation}.json`), text, { mode: 0o600 });
		// The manifest is the only visibility switch; interruption leaves the old complete generation readable.
		this.write("manifest.json", {
			version: SEMANTIC_FORMAT,
			projectId: data.projectId,
			profileKey: data.profileKey,
			generation: data.generation,
			sha256: sourceHash(text),
		});
	}
}
