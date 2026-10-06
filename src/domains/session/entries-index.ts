import { readFileSync, statSync } from "node:fs";
import type { BigIntStats } from "node:fs";
import type { SessionAppendObservation } from "../../engine/session.js";
import { readSessionFileEntriesRange } from "../../engine/session.js";
import { collectSessionEntries } from "./compaction/session-entries.js";
import type { SessionEntry } from "./entries.js";

function freezeJson(value: unknown): void {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

function sameSnapshot(a: BigIntStats | null, b: BigIntStats | null): boolean {
	return a !== null && b !== null && a.dev === b.dev && a.ino === b.ino &&
		a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/** One live ledger index; no state survives closing or reopening its manager. */
export class SessionEntriesIndex {
	private stat: BigIntStats | null = null;
	private entries: SessionEntry[] = [];
	private snapshot: ReadonlyArray<SessionEntry> = Object.freeze([]);
	private completeEntries = 0;
	private offset = 0;
	private lineNumber = 0;
	private chunks: Buffer[] = [];
	private trailing = Buffer.alloc(0);
	private observedAppend: BigIntStats | null = null;

	constructor(private readonly path: string) {}

	noteAppend(observation: SessionAppendObservation): void {
		this.observedAppend = sameSnapshot(this.stat, observation.before) ? observation.after : null;
	}

	refreshAfterWrite(): void {
		try {
			this.read();
		} catch {
			// Accepted writes keep their existing success contract. The next read
			// revalidates and reports corrupt or unavailable external ledger state.
			this.stat = null;
		}
	}

	read(): ReadonlyArray<SessionEntry> {
		let current: BigIntStats | null;
		try {
			current = statSync(this.path, { bigint: true });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			current = null;
		}
		const prior = this.stat;
		const sameFile = prior !== null && current !== null && prior.dev === current.dev && prior.ino === current.ino;
		if (sameSnapshot(prior, current))
			return this.snapshot;
		// Appends preserve the prefix; atomic rewrites change identity. Same-size
		// edits and truncation must invalidate even when the entry count is unchanged.
		let append = sameFile && prior !== null && current !== null && current.size > prior.size;
		if (append && !sameSnapshot(current, this.observedAppend)) {
			const bytes = readFileSync(this.path);
			let offset = 0;
			for (const chunk of [...this.chunks, this.trailing]) {
				if (!bytes.subarray(offset, offset + chunk.length).equals(chunk)) { append = false; break; }
				offset += chunk.length;
			}
		}
		this.observedAppend = null;
		const range = readSessionFileEntriesRange(this.path, append ? this.offset : 0, append ? this.lineNumber : 0);
		// An atomic replacement between stat and open invalidates the tail cursor.
		if (append && range.stat !== null && (prior === null || range.stat.dev !== prior.dev || range.stat.ino !== prior.ino || range.stat.size < prior.size)) {
			this.stat = null;
			return this.read();
		}
		const parsed = collectSessionEntries(range.entries.filter((entry) =>
			!(typeof entry === "object" && entry !== null && "type" in entry && entry.type === "session"),
		), this.path);
		for (const entry of parsed) freezeJson(entry);
		const prefix = append ? this.entries.slice(0, this.completeEntries) : [];
		this.entries = prefix.concat(parsed);
		// A header consumes an engine entry but does not appear in the domain list.
		const finalEntryCount = range.entries.length - range.completeEntries;
		this.completeEntries = this.entries.length - finalEntryCount;
		const rangeOffset = append ? this.offset : 0;
		if (!append) this.chunks = [];
		const completeBytes = range.nextOffset - rangeOffset;
		if (completeBytes > 0) this.chunks.push(range.bytes.subarray(0, completeBytes));
		this.trailing = Buffer.from(range.bytes.subarray(completeBytes));
		this.offset = range.nextOffset;
		this.lineNumber = range.nextLineNumber;
		this.stat = range.stat;
		this.snapshot = Object.freeze(this.entries.slice());
		return this.snapshot;
	}
}
