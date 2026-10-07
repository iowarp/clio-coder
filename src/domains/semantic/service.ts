import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioCacheDir } from "../../core/xdg.js";
import type { Checkpoint, Generation } from "./storage.js";
import {
	DEFAULT_SEMANTIC_LIMITS,
	recordFingerprint,
	SemanticStorage,
	semanticProfileKey,
	sourceHash,
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
} from "./types.js";

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
	private generation: Generation | null;
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
		this.generation = this.storage.load(options.projectId, this.profileKey);
		this.checkpointState = this.checkpoint();
		if (this.generation) {
			this.validateRecords(this.generation.records);
			for (const vector of Object.values(this.generation.vectors)) validateVector(vector, this.profile.dimensions);
		}
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
			vectors: Object.keys(this.generation?.vectors ?? {}).length,
			pending: checkpoint?.pending ?? [],
			failed: checkpoint?.failed ?? {},
		};
	}

	private checkpoint(): Checkpoint | null {
		const checkpoint = this.storage.read<Checkpoint>("checkpoint.json");
		if (
			checkpoint &&
			(checkpoint.version !== 1 ||
				checkpoint.projectId !== this.options.projectId ||
				checkpoint.profileKey !== this.profileKey)
		)
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

	async refresh(records: readonly SemanticRecord[], options: SemanticRefreshOptions = {}) {
		return this.runRefresh(records, options, false);
	}

	async reembed(records: readonly SemanticRecord[] = this.canonicalRecords(), options: SemanticRefreshOptions = {}) {
		return this.runRefresh(records, options, true);
	}

	private async runRefresh(input: readonly SemanticRecord[], options: SemanticRefreshOptions, force: boolean) {
		const records = structuredClone([...input]).sort((a, b) => a.id.localeCompare(b.id));
		this.validateRecords(records);
		return withStateFileLock(
			join(this.storage.directory, "manifest.json"),
			async () => {
				options.signal?.throwIfAborted();
				this.generation = this.storage.load(this.options.projectId, this.profileKey);
				const snapshotHash = sourceHash(JSON.stringify([force, records]));
				const prior = this.checkpoint();
				const day = new Date().toISOString().slice(0, 10);
				const cp: Checkpoint =
					prior?.snapshotHash === snapshotHash
						? prior
						: {
								version: 1,
								projectId: this.options.projectId,
								profileKey: this.profileKey,
								snapshotHash,
								vectors: {},
								pending: [],
								failed: {},
								day,
								spent: prior?.day === day ? prior.spent : 0,
							};
				this.checkpointState = cp;
				if (cp.day !== day) {
					cp.day = day;
					cp.spent = 0;
				}
				const previous = new Map(this.generation?.records.map((r) => [r.id, r]) ?? []);
				if (!force)
					for (const record of records) {
						const old = previous.get(record.id);
						const vector = this.generation?.vectors[record.id];
						if (old && vector && recordFingerprint(old) === recordFingerprint(record)) cp.vectors[record.id] = vector;
					}
				for (const vector of Object.values(cp.vectors)) validateVector(vector, this.profile.dimensions);
				let remaining = records.filter((r) => !Object.hasOwn(cp.vectors, r.id));
				cp.pending = remaining.map((r) => r.id);
				this.storage.write("checkpoint.json", cp);
				let embedded = 0;
				const requestedBudget = options.maxEmbeddings ?? this.limits.maxEmbeddingsPerDay;
				if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 0)
					throw new Error("Invalid semantic embedding budget");
				while (remaining.length) {
					options.signal?.throwIfAborted();
					const count = Math.min(
						this.limits.batchSize,
						requestedBudget - embedded,
						this.limits.maxEmbeddingsPerDay - cp.spent,
					);
					if (count <= 0 || options.shouldYield?.() || !this.options.embed) break;
					const batch = remaining.slice(0, count);
					cp.spent += batch.length;
					// Charge before the network call: a crash cannot reset the persisted daily work budget.
					this.storage.write("checkpoint.json", cp);
					try {
						const result = await this.embed(
							batch.map((r) => r.input),
							"document",
							options.signal,
						);
						batch.forEach((record, i) => {
							cp.vectors[record.id] = result[i]!;
							delete cp.failed[record.id];
						});
						embedded += batch.length;
					} catch (error) {
						for (const record of batch) cp.failed[record.id] = error instanceof Error ? error.message : String(error);
						this.storage.write("checkpoint.json", cp);
						options.signal?.throwIfAborted();
						break;
					}
					remaining = records.filter((r) => !Object.hasOwn(cp.vectors, r.id));
					cp.pending = remaining.map((r) => r.id);
					this.storage.write("checkpoint.json", cp);
				}
				if (remaining.length) return { complete: false, embedded, ...this.status() };
				options.signal?.throwIfAborted();
				const live = new Set(records.map((r) => r.id));
				const next: Generation = {
					version: 1,
					projectId: this.options.projectId,
					profileKey: this.profileKey,
					profile: this.profile,
					generation: randomUUID(),
					createdAt: new Date().toISOString(),
					records,
					vectors: cp.vectors,
					tombstones: [...previous.keys()].filter((id) => !live.has(id)),
				};
				this.storage.pruneGenerations(this.generation?.generation ?? null);
				this.storage.commit(next);
				this.generation = next;
				cp.pending = [];
				cp.failed = {};
				cp.vectors = {};
				this.storage.write("checkpoint.json", cp);
				this.storage.pruneGenerations(next.generation);
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
		const forward = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", forward, { once: true });
		if (signal?.aborted) forward();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new Error("Semantic embedding timeout"));
				}, this.limits.queryTimeoutMs);
			});
			const result = await Promise.race([
				this.options.embed(inputs, { task, profile: structuredClone(this.profile), signal: controller.signal }),
				timeout,
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
			const vector = this.options.embed
				? (await this.embed([{ kind: "text", text: query }], "query", signal))[0]
				: undefined;
			return this.searchVector(query, vector, filters);
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

	searchVector(query: string, vector: readonly number[] | undefined, filters: SemanticFilters): SemanticSearchResult {
		this.assertSearch(query, filters);
		if (vector) validateVector(vector, this.profile.dimensions);
		const limit = Number.isFinite(filters.limit) ? Math.max(1, Math.min(20, Math.floor(filters.limit!))) : 5;
		const start = performance.now();
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 64);
		const memories = new Set(filters.eligibleMemoryIds ?? []);
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
				(record.kind === "memory" && !memories.has(record.memoryId!)) ||
				(filters.kinds && !filters.kinds.includes(record.kind)) ||
				(filters.visibility && !filters.visibility.includes(record.visibility)) ||
				(filters.runId && record.runId !== filters.runId) ||
				(filters.mediaType && record.mediaType !== filters.mediaType) ||
				(filters.after && (!record.updatedAt || record.updatedAt < filters.after)) ||
				(filters.before && (!record.updatedAt || record.updatedAt > filters.before))
			)
				continue;
			const exact = query.length > 0 && [record.id, record.sourceId, record.path].includes(query);
			const text = `${record.path}\n${record.text}`.toLowerCase();
			const lexical = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 0;
			const stored = this.generation?.vectors[record.id];
			const semantic = vector && stored ? vector.reduce((sum, value, i) => sum + value * stored[i]!, 0) : 0;
			if (!exact && lexical <= 0 && semantic <= 0) continue;
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
				...(record.runId ? { runId: record.runId } : {}),
				...(record.experimentId ? { experimentId: record.experimentId } : {}),
			});
		}
		hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		return {
			hits: hits.slice(0, limit),
			generation: this.generation?.generation ?? null,
			profileKey: this.profileKey,
			indexedAt: this.generation?.createdAt ?? null,
			pending: Boolean(this.status().pending.length),
			truncated,
			...(!vector ? { fallbackReason: "Semantic query vector unavailable; lexical retrieval" } : {}),
		};
	}
}
