import { randomUUID } from "node:crypto";
import { basename, dirname, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioCacheDir } from "../../core/xdg.js";
import type { ExtractionResult } from "./ingestion.js";
import type { Checkpoint, Generation } from "./storage.js";
import {
	DEFAULT_SEMANTIC_LIMITS,
	decodeVector,
	encodeVector,
	recordFingerprint,
	SEMANTIC_FORMAT,
	SemanticStorage,
	semanticProfileKey,
	sourceHash,
	storedRecordBytes,
	validateVector,
} from "./storage.js";
import type {
	SemanticEmbed,
	SemanticFilters,
	SemanticHit,
	SemanticInput,
	SemanticLimits,
	SemanticProfile,
	SemanticRecord,
	SemanticRefreshOptions,
	SemanticSearchResult,
	SemanticSourceKind,
} from "./types.js";

/** Explicit sources survive a budget trim before code, which code_nav and the codewiki already cover. */
const TRIM_ORDER: Record<SemanticSourceKind, number> = {
	memory: 0,
	evidence: 1,
	recording: 2,
	inbox: 3,
	wiki: 4,
	code: 5,
};
/** Embeddings charged ahead of use, so the checkpoint is rewritten per reservation instead of per batch. */
const CHARGE_AHEAD = 256;
/** Decoded vectors for a loaded generation, shared by every index that reopens it. */
const decodedVectors = new WeakMap<Generation, Map<string, Float32Array>>();

export interface SemanticIndexOptions {
	projectId: string;
	profile: SemanticProfile;
	embed?: SemanticEmbed;
	cacheDir?: string;
	limits?: Partial<SemanticLimits>;
}

export class SemanticIndex {
	readonly profileKey: string;
	readonly limits: SemanticLimits;
	readonly storage: SemanticStorage;
	private generation: Generation | null = null;
	private vectors = new Map<string, Float32Array>();
	private checkpointState: Checkpoint | null = null;
	private readonly profile: SemanticProfile;

	constructor(private readonly options: SemanticIndexOptions) {
		if (!options.projectId) throw new Error("Semantic index requires a project identity");
		this.profile = structuredClone(options.profile);
		this.profileKey = semanticProfileKey(this.profile);
		this.limits = { ...DEFAULT_SEMANTIC_LIMITS, ...options.limits };
		for (const value of Object.values(this.limits))
			if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid semantic limit");
		this.storage = new SemanticStorage(
			join(options.cacheDir ?? clioCacheDir(), "semantic", sourceHash(options.projectId), this.profileKey),
			Math.floor(this.limits.maxBytes / 3),
		);
		this.adopt(this.storage.load(options.projectId, this.profileKey));
		this.checkpoint();
	}

	private adopt(generation: Generation | null): void {
		if (generation) this.validateRecords(generation.records);
		let vectors = generation ? decodedVectors.get(generation) : undefined;
		if (!vectors) {
			vectors = new Map();
			for (const [id, encoded] of Object.entries(generation?.vectors ?? {}))
				vectors.set(id, decodeVector(encoded, this.profile.dimensions));
			if (generation) decodedVectors.set(generation, vectors);
		}
		this.generation = generation;
		this.vectors = vectors;
	}

	canonicalRecords(): SemanticRecord[] {
		return structuredClone(this.generation?.records ?? []);
	}

	status() {
		const checkpoint = this.checkpointState;
		return {
			projectId: this.options.projectId,
			profileKey: this.profileKey,
			generation: this.generation?.generation ?? null,
			indexedAt: this.generation?.createdAt ?? null,
			records: this.generation?.records.length ?? 0,
			vectors: this.vectors.size,
			pending: checkpoint?.pending ?? [],
			failed: checkpoint?.failed ?? {},
		};
	}

	private checkpoint(): Checkpoint | null {
		const stored = this.storage.read<Checkpoint>("checkpoint.json");
		const checkpoint = stored?.version === SEMANTIC_FORMAT ? stored : null;
		if (checkpoint && (checkpoint.projectId !== this.options.projectId || checkpoint.profileKey !== this.profileKey))
			throw new Error("Semantic checkpoint identity mismatch");
		this.checkpointState = checkpoint;
		return checkpoint;
	}

	private validateRecords(records: readonly SemanticRecord[]): void {
		if (records.length > this.limits.maxRecords) throw new Error("Semantic record limit exceeded");
		const ids = new Set<string>();
		for (const r of records) {
			if (
				!r.id ||
				["__proto__", "constructor", "prototype"].includes(r.id) ||
				ids.has(r.id) ||
				r.projectId !== this.options.projectId ||
				!r.sourceId ||
				!r.contentHash ||
				!r.extractionVersion ||
				!r.path ||
				!r.location ||
				!["project", "global"].includes(r.scope) ||
				!["project", "global", "private"].includes(r.visibility)
			)
				throw new Error("Invalid, duplicate or foreign semantic record");
			if (r.scope === "global" && r.visibility !== "global")
				throw new Error("Global semantic records require global visibility");
			if (r.kind === "memory" && !r.memoryId) throw new Error("Memory semantic records require a gated memory ID");
			if (
				r.text.length > this.limits.maxTextChars ||
				(r.input.kind === "text" && r.input.text.length > this.limits.maxTextChars)
			)
				throw new Error("Semantic piece text limit exceeded");
			ids.add(r.id);
		}
	}

	/**
	 * A failed source keeps its previous records, and a snapshot over the record or byte budget keeps the
	 * highest-priority records that fit. Either way the refresh still commits and reports what it left out.
	 */
	async refreshExtracted(result: ExtractionResult, options: SemanticRefreshOptions = {}) {
		const failed = result.sources.filter((source) => source.state === "failed").map((source) => source.path);
		const ids = new Set(result.records.map((record) => record.id));
		const carried = (this.generation?.records ?? []).filter(
			(record) =>
				!ids.has(record.id) && failed.some((path) => record.path === path || record.path.startsWith(`${path}${sep}`)),
		);
		const budget = this.storage.maxBytes - 4096;
		let bytes = 0;
		let truncated = result.truncated;
		const kept: SemanticRecord[] = [];
		for (const record of [...carried, ...result.records].sort((a, b) => TRIM_ORDER[a.kind] - TRIM_ORDER[b.kind])) {
			const size = storedRecordBytes(record, this.profile.dimensions);
			if (kept.length >= this.limits.maxRecords || bytes + size > budget) {
				truncated = true;
				continue;
			}
			bytes += size;
			kept.push(record);
		}
		return { ...(await this.refresh(kept, options)), truncated, carried: carried.length };
	}

	async refresh(records: readonly SemanticRecord[], options: SemanticRefreshOptions = {}) {
		return this.runRefresh(records, options, false);
	}

	async reembed(records: readonly SemanticRecord[] = this.canonicalRecords(), options: SemanticRefreshOptions = {}) {
		return this.runRefresh(records, options, true);
	}

	private async runRefresh(input: readonly SemanticRecord[], options: SemanticRefreshOptions, force: boolean) {
		// Code-unit order: localeCompare follows LANG, so the TUI and the CLI hashed different snapshots.
		const records = structuredClone([...input]).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		this.validateRecords(records);
		return withStateFileLock(
			join(this.storage.directory, "manifest.json"),
			async () => {
				options.signal?.throwIfAborted();
				this.adopt(this.storage.load(this.options.projectId, this.profileKey));
				this.storage.pruneGenerations(this.generation?.generation ?? null);
				const snapshotHash = sourceHash(JSON.stringify([force, records]));
				const prior = this.checkpoint();
				const day = new Date().toISOString().slice(0, 10);
				const fingerprints = new Map(records.map((r) => [r.id, recordFingerprint(r)]));
				const wanted = new Set(fingerprints.values());
				const vectors: Record<string, string> = {};
				// Generation vectors go first, so an unchanged snapshot reproduces the committed generation exactly.
				if (!force && this.generation)
					for (const old of this.generation.records) {
						const fingerprint = recordFingerprint(old);
						const vector = this.generation.vectors[old.id];
						if (vector && wanted.has(fingerprint)) vectors[fingerprint] ??= vector;
					}
				if (prior && (!force || prior.snapshotHash === snapshotHash))
					for (const [fingerprint, vector] of Object.entries(prior.vectors))
						if (wanted.has(fingerprint) && !Object.hasOwn(vectors, fingerprint)) {
							decodeVector(vector, this.profile.dimensions);
							vectors[fingerprint] = vector;
						}
				const cp: Checkpoint = {
					version: SEMANTIC_FORMAT,
					projectId: this.options.projectId,
					profileKey: this.profileKey,
					snapshotHash,
					vectors,
					pending: [],
					failed: prior?.snapshotHash === snapshotHash ? prior.failed : {},
					day,
					spent: prior?.day === day ? prior.spent : 0,
				};
				this.checkpointState = cp;
				const missing = () => records.filter((r) => !Object.hasOwn(cp.vectors, fingerprints.get(r.id) ?? ""));
				let remaining = missing();
				cp.pending = remaining.map((r) => r.id);
				const requestedBudget = options.maxEmbeddings ?? this.limits.maxEmbeddingsPerDay;
				if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 0)
					throw new Error("Invalid semantic embedding budget");
				let embedded = 0;
				let charged = 0;
				try {
					while (remaining.length) {
						options.signal?.throwIfAborted();
						if (options.shouldYield?.() || !this.options.embed) break;
						if (charged === 0) {
							charged = Math.max(
								0,
								Math.min(CHARGE_AHEAD, requestedBudget - embedded, this.limits.maxEmbeddingsPerDay - cp.spent),
							);
							if (charged === 0) break;
							cp.spent += charged;
							// Charge before the network call: a crash cannot reset the persisted daily work budget.
							this.storage.write("checkpoint.json", cp);
						}
						const batch: SemanticRecord[] = [];
						for (const record of remaining) {
							if (batch.length >= Math.min(this.limits.batchSize, charged)) break;
							if (!batch.some((entry) => fingerprints.get(entry.id) === fingerprints.get(record.id))) batch.push(record);
						}
						try {
							const result = await this.embed(
								batch.map((r) => r.input),
								"document",
								options.signal,
							);
							batch.forEach((record, i) => {
								const vector = result[i];
								if (!vector) throw new Error("Missing semantic embedding");
								cp.vectors[fingerprints.get(record.id) ?? ""] = encodeVector(vector);
								delete cp.failed[record.id];
							});
							embedded += batch.length;
							charged -= batch.length;
						} catch (error) {
							for (const record of batch) cp.failed[record.id] = error instanceof Error ? error.message : String(error);
							options.signal?.throwIfAborted();
							break;
						}
						remaining = missing();
					}
				} finally {
					cp.spent -= charged;
					cp.pending = remaining.map((r) => r.id);
					this.storage.write("checkpoint.json", cp);
				}
				if (remaining.length) return { complete: false, embedded, ...this.status() };
				options.signal?.throwIfAborted();
				const nextVectors = Object.fromEntries(records.map((r) => [r.id, cp.vectors[fingerprints.get(r.id) ?? ""] ?? ""]));
				const unchanged =
					!force && this.generation !== null && JSON.stringify(records) === JSON.stringify(this.generation.records);
				if (!unchanged) {
					const live = new Set(records.map((r) => r.id));
					const next: Generation = {
						version: SEMANTIC_FORMAT,
						projectId: this.options.projectId,
						profileKey: this.profileKey,
						profile: this.profile,
						generation: randomUUID(),
						createdAt: new Date().toISOString(),
						records,
						vectors: nextVectors,
						tombstones: (this.generation?.records ?? []).map((r) => r.id).filter((id) => !live.has(id)),
					};
					this.storage.commit(next);
					this.adopt(next);
				}
				cp.pending = [];
				cp.failed = {};
				cp.vectors = {};
				this.storage.write("checkpoint.json", cp);
				this.storage.pruneGenerations(this.generation?.generation ?? null);
				return { complete: true, embedded, ...this.status() };
			},
			{ ...(options.signal ? { signal: options.signal } : {}), timeoutMs: 1000 },
		);
	}

	private async embed(
		inputs: readonly SemanticInput[],
		task: "query" | "document",
		signal?: AbortSignal,
	): Promise<number[][]> {
		if (!this.options.embed) throw new Error("Semantic embedder unavailable");
		const controller = new AbortController();
		let rejectCancelled: ((reason?: unknown) => void) | undefined;
		const cancelled = new Promise<never>((_, reject) => {
			rejectCancelled = reject;
		});
		const forward = () => {
			controller.abort(signal?.reason);
			rejectCancelled?.(signal?.reason ?? new Error("Semantic embedding cancelled"));
		};
		signal?.addEventListener("abort", forward, { once: true });
		if (signal?.aborted) forward();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => {
						controller.abort();
						reject(new Error("Semantic embedding timeout"));
					},
					task === "query" ? this.limits.queryTimeoutMs : this.limits.documentTimeoutMs,
				);
			});
			const result = await Promise.race([
				this.options.embed(inputs, { task, profile: structuredClone(this.profile), signal: controller.signal }),
				timeout,
				cancelled,
			]);
			signal?.throwIfAborted();
			if (result.profileKey !== this.profileKey || result.vectors.length !== inputs.length)
				throw new Error("Semantic embedding profile or batch count mismatch");
			for (const vector of result.vectors) validateVector(vector, this.profile.dimensions);
			return result.vectors;
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", forward);
		}
	}

	async search(query: string, filters: SemanticFilters, signal?: AbortSignal): Promise<SemanticSearchResult> {
		this.assertSearch(query, filters);
		try {
			const vector =
				this.options.embed && this.generation?.records.length
					? (await this.embed([{ kind: "text", text: query }], "query", signal))[0]
					: undefined;
			return this.searchVector(query, vector ? { profileKey: this.profileKey, vector } : undefined, filters);
		} catch (error) {
			signal?.throwIfAborted();
			return {
				...this.searchVector(query, undefined, filters),
				fallbackReason: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private assertSearch(query: string, filters: SemanticFilters): void {
		if (filters.projectId !== this.options.projectId) throw new Error("Semantic search project ownership mismatch");
		if (query.length > this.limits.maxTextChars) throw new Error("Semantic query size limit exceeded");
	}

	searchVector(
		query: string,
		embedding: { profileKey: string; vector: readonly number[] } | undefined,
		filters: SemanticFilters,
	): SemanticSearchResult {
		this.assertSearch(query, filters);
		if (embedding && embedding.profileKey !== this.profileKey) throw new Error("Semantic query profile mismatch");
		const vector = embedding?.vector;
		if (vector) validateVector(vector, this.profile.dimensions);
		const limit =
			filters.limit !== undefined && Number.isFinite(filters.limit)
				? Math.max(1, Math.min(20, Math.floor(filters.limit)))
				: 5;
		const start = performance.now();
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 64);
		const memories = new Set(filters.eligibleMemoryIds ?? []);
		// Many records share a path, and readablePath resolves symlinks on every call.
		const pathAllowed = new Map<string, boolean>();
		const allowsPath = (path: string) => {
			let allowed = pathAllowed.get(path);
			if (allowed === undefined) {
				allowed = filters.allowsPath?.(path) !== false;
				pathAllowed.set(path, allowed);
			}
			return allowed;
		};
		const hits: SemanticHit[] = [];
		let truncated = false;
		for (const record of this.generation?.records ?? []) {
			if (performance.now() - start > this.limits.searchBudgetMs) {
				truncated = true;
				break;
			}
			if (
				record.projectId !== filters.projectId ||
				(record.scope === "global" && !filters.includeGlobal) ||
				(record.visibility === "private" && !filters.includePrivate) ||
				(record.kind === "memory" && !memories.has(record.memoryId ?? "")) ||
				(filters.kinds && !filters.kinds.includes(record.kind)) ||
				(filters.visibility && !filters.visibility.includes(record.visibility)) ||
				(filters.runId && record.runId !== filters.runId) ||
				(filters.mediaType && record.mediaType !== filters.mediaType) ||
				(filters.after && (!record.updatedAt || record.updatedAt < filters.after)) ||
				(filters.before && (!record.updatedAt || record.updatedAt > filters.before)) ||
				filters.allowsRecord?.(record) === false ||
				(record.kind !== "memory" && !allowsPath(record.path))
			)
				continue;
			const exact = query.length > 0 && [record.id, record.sourceId, record.path].includes(query);
			const text = `${record.path}\n${record.text}`.toLowerCase();
			const lexical = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 0;
			const stored = this.vectors.get(record.id);
			let semantic = 0;
			if (vector && stored) for (let i = 0; i < stored.length; i++) semantic += (vector[i] ?? 0) * (stored[i] ?? 0);
			if (!exact && lexical <= 0 && semantic <= 0) continue;
			const evidenceId =
				record.kind === "evidence"
					? /^evidence:([^:]+):/.exec(record.sourceId)?.[1]
					: record.kind === "recording"
						? basename(basename(dirname(record.path)) === "recordings" ? dirname(dirname(record.path)) : dirname(record.path))
						: undefined;
			hits.push({
				id: record.id,
				sourceId: record.sourceId,
				kind: record.kind,
				path: record.path,
				location: { ...record.location },
				excerpt: record.text.replace(/\s+/g, " ").slice(0, 480),
				score: (exact ? 2 : 0) + lexical * 0.35 + Math.max(0, semantic) * 0.65,
				method: exact ? "exact" : vector ? (lexical ? "hybrid" : "semantic") : "lexical",
				mediaType: record.mediaType,
				...(evidenceId ? { evidenceId } : {}),
				...(record.runId ? { runId: record.runId } : {}),
				...(record.experimentId ? { experimentId: record.experimentId } : {}),
			});
		}
		hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		// High-ranking source records often carry exact links to the code, plot,
		// notebook or note that produced an observation. Keep those linked sources
		// in the candidate set so the agent can inspect the originals together.
		if (!filters.kinds && hits.length > limit) {
			const anchors = hits.slice(0, 3);
			const names = hits.map((hit) => ({ hit, name: basename(hit.path) })).filter(({ name }) => name.length >= 6);
			for (const hit of hits) {
				if (hit.method === "exact") continue;
				const name = basename(hit.path);
				if (name.length < 6) continue;
				const mentions = anchors.filter(
					(anchor) => anchor.sourceId !== hit.sourceId && anchor.excerpt.includes(name),
				).length;
				hit.score += Math.min(2, mentions) * 0.25;
				if (anchors.includes(hit)) {
					const linked = new Set(
						names
							.filter(
								({ hit: candidate, name: candidateName }) =>
									candidate.sourceId !== hit.sourceId && hit.excerpt.includes(candidateName),
							)
							.map(({ hit: candidate }) => candidate.sourceId),
					);
					hit.score += Math.min(2, linked.size) * 0.1;
				}
			}
			hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		}
		// An unfiltered cross-source question needs room for both the implementation
		// and its precedent. Repeated evidence bundles can otherwise consume every
		// slot ahead of a relevant code symbol. Exact IDs always keep priority.
		let selected = hits.slice(0, limit);
		if (!filters.kinds && limit >= 5 && hits.length > limit) {
			const diverse: SemanticHit[] = hits.filter((hit) => hit.method === "exact").slice(0, limit);
			const topScore = hits[0]?.score ?? 0;
			for (const [kind, quota] of [
				["memory", 1],
				["wiki", 1],
				["code", 2],
			] as const) {
				const threshold = topScore * (kind === "code" ? 0.8 : 0.5);
				for (const hit of hits
					.filter((candidate) => candidate.kind === kind && candidate.score >= threshold)
					.slice(0, quota)) {
					if (diverse.length < limit && !diverse.some((entry) => entry.path === hit.path)) diverse.push(hit);
				}
			}
			for (const hit of hits) {
				if (diverse.length >= limit) break;
				if (!diverse.some((entry) => entry.path === hit.path)) diverse.push(hit);
			}
			selected = diverse.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		}
		return {
			hits: selected,
			generation: this.generation?.generation ?? null,
			profileKey: this.profileKey,
			indexedAt: this.generation?.createdAt ?? null,
			pending: Boolean(this.status().pending.length),
			truncated,
			...(!vector ? { fallbackReason: "Semantic query vector unavailable; lexical retrieval" } : {}),
		};
	}
}
