import { ceilChars } from "../session/context-accounting.js";

export const TASK_MEMORY_VERSION = 1;
export const TASK_MEMORY_DEFAULT_KNOWLEDGE_CAP = 20;
export const TASK_MEMORY_DEFAULT_PROCEDURAL_CAP = 30;
export const TASK_MEMORY_CONTENT_MAX_CHARS = 1_200;

export type TaskMemoryClass = "status" | "knowledge" | "procedural";
export type TaskMemoryRenderableClass = Exclude<TaskMemoryClass, "status">;

export interface TaskMemoryEntry {
	id: string;
	kind: TaskMemoryClass;
	content: string;
	createdAt: string;
	lastTouchedAt: string;
	injectionCount: number;
}

/** JSON-safe export shape. The bank itself remains session-scoped and in memory. */
export interface TaskMemorySnapshot {
	version: 1;
	status: TaskMemoryEntry | null;
	knowledge: TaskMemoryEntry[];
	procedural: TaskMemoryEntry[];
}

export interface TaskMemoryBankOptions {
	knowledgeCap?: number;
	proceduralCap?: number;
	now?: () => Date;
}

export interface SaveTaskMemoryOptions {
	/** Update an existing entry while preserving its identity. */
	id?: string;
}

/**
 * Per-session execution memory. This deliberately has no durable store or
 * approval flow: it is authoritative working state for one active task.
 */
export class TaskMemoryBank {
	readonly #knowledgeCap: number;
	readonly #proceduralCap: number;
	readonly #now: () => Date;
	readonly #knowledge = new Map<string, TaskMemoryEntry>();
	readonly #procedural = new Map<string, TaskMemoryEntry>();
	#status: TaskMemoryEntry | null = null;
	#nextId = 1;

	constructor(options: TaskMemoryBankOptions = {}) {
		this.#knowledgeCap = positiveInteger(options.knowledgeCap, TASK_MEMORY_DEFAULT_KNOWLEDGE_CAP);
		this.#proceduralCap = positiveInteger(options.proceduralCap, TASK_MEMORY_DEFAULT_PROCEDURAL_CAP);
		this.#now = options.now ?? (() => new Date());
	}

	updateStatus(content: string): TaskMemoryEntry {
		const timestamp = this.#timestamp();
		const normalized = normalizeContent(content);
		this.#status =
			this.#status === null
				? this.#newEntry("status", normalized, timestamp)
				: { ...this.#status, content: normalized, lastTouchedAt: timestamp };
		return cloneEntry(this.#status);
	}

	saveKnowledge(content: string, options: SaveTaskMemoryOptions = {}): TaskMemoryEntry {
		return this.#save("knowledge", content, options.id);
	}

	saveProcedural(content: string, options: SaveTaskMemoryOptions = {}): TaskMemoryEntry {
		return this.#save("procedural", content, options.id);
	}

	deleteEntry(id: string): boolean {
		if (this.#status?.id === id) {
			this.#status = null;
			return true;
		}
		return this.#knowledge.delete(id) || this.#procedural.delete(id);
	}

	/** Reset execution state when the composition root switches sessions. */
	clear(): void {
		this.#status = null;
		this.#knowledge.clear();
		this.#procedural.clear();
		this.#nextId = 1;
	}

	/** Record attribution after an entry has contributed to a visible reminder. */
	recordInjection(ids: ReadonlyArray<string>): void {
		for (const id of new Set(ids)) {
			const entries = this.#knowledge.has(id) ? this.#knowledge : this.#procedural;
			const entry = entries.get(id);
			if (entry === undefined) continue;
			const updated = { ...entry, injectionCount: entry.injectionCount + 1, lastTouchedAt: this.#timestamp() };
			entries.set(id, updated);
		}
	}

	/**
	 * Render only action-agent-visible classes under a conservative character
	 * token estimate. Status remains private even if a caller requests it.
	 */
	render(budgetTokens: number, kinds: ReadonlyArray<TaskMemoryRenderableClass> = ["knowledge", "procedural"]): string {
		if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return "";
		const allowed = new Set(kinds);
		const entries = [...this.#knowledge.values(), ...this.#procedural.values()]
			.filter((entry) => allowed.has(entry.kind as TaskMemoryRenderableClass))
			.sort(compareForRender);
		let rendered = "";
		for (const entry of entries) {
			const line = `- [${entry.id}] ${entry.kind}: ${entry.content}`;
			const candidate = rendered.length === 0 ? line : `${rendered}\n${line}`;
			if (ceilChars(candidate.length) > budgetTokens) continue;
			rendered = candidate;
		}
		return rendered;
	}

	snapshot(): TaskMemorySnapshot {
		return {
			version: TASK_MEMORY_VERSION,
			status: this.#status === null ? null : cloneEntry(this.#status),
			knowledge: [...this.#knowledge.values()].sort(compareForSnapshot).map(cloneEntry),
			procedural: [...this.#procedural.values()].sort(compareForSnapshot).map(cloneEntry),
		};
	}

	#save(kind: TaskMemoryRenderableClass, content: string, id: string | undefined): TaskMemoryEntry {
		const entries = this.#mapFor(kind);
		const normalized = normalizeContent(content);
		const timestamp = this.#timestamp();
		let saved: TaskMemoryEntry;
		if (id === undefined) {
			saved = this.#newEntry(kind, normalized, timestamp);
		} else {
			const existing = entries.get(id);
			if (existing === undefined) throw new Error(`task memory entry not found: ${id}`);
			saved = { ...existing, content: normalized, lastTouchedAt: timestamp };
		}
		entries.set(saved.id, saved);
		this.#evictOldest(entries, kind === "knowledge" ? this.#knowledgeCap : this.#proceduralCap);
		return cloneEntry(saved);
	}

	#newEntry(kind: TaskMemoryClass, content: string, timestamp: string): TaskMemoryEntry {
		const prefix = kind === "status" ? "s" : kind === "knowledge" ? "k" : "p";
		const id = `tm-${prefix}-${this.#nextId.toString(36)}`;
		this.#nextId += 1;
		return { id, kind, content, createdAt: timestamp, lastTouchedAt: timestamp, injectionCount: 0 };
	}

	#mapFor(kind: TaskMemoryRenderableClass): Map<string, TaskMemoryEntry> {
		return kind === "knowledge" ? this.#knowledge : this.#procedural;
	}

	#evictOldest(entries: Map<string, TaskMemoryEntry>, cap: number): void {
		while (entries.size > cap) {
			const oldest = [...entries.values()].sort(compareForEviction)[0];
			if (oldest === undefined) return;
			entries.delete(oldest.id);
		}
	}

	#timestamp(): string {
		return this.#now().toISOString();
	}
}

function normalizeContent(content: string): string {
	const normalized = content.replace(/\s+/gu, " ").trim();
	if (normalized.length === 0) throw new Error("task memory content must not be empty");
	return normalized.slice(0, TASK_MEMORY_CONTENT_MAX_CHARS).trimEnd();
}

function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function cloneEntry(entry: TaskMemoryEntry): TaskMemoryEntry {
	return { ...entry };
}

function compareForEviction(left: TaskMemoryEntry, right: TaskMemoryEntry): number {
	const byTouched = left.lastTouchedAt.localeCompare(right.lastTouchedAt);
	if (byTouched !== 0) return byTouched;
	const byCreated = left.createdAt.localeCompare(right.createdAt);
	if (byCreated !== 0) return byCreated;
	return left.id.localeCompare(right.id);
}

function compareForRender(left: TaskMemoryEntry, right: TaskMemoryEntry): number {
	const byTouched = right.lastTouchedAt.localeCompare(left.lastTouchedAt);
	if (byTouched !== 0) return byTouched;
	if (left.kind !== right.kind) return left.kind === "knowledge" ? -1 : 1;
	return left.id.localeCompare(right.id);
}

function compareForSnapshot(left: TaskMemoryEntry, right: TaskMemoryEntry): number {
	const byCreated = left.createdAt.localeCompare(right.createdAt);
	return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
}
