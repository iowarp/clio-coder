/**
 * The reread port: what the read tool asks when the file it just read may be
 * an evicted read the model is fetching again.
 *
 * The comparison is exact. Every evicted tool result carries the sha256 of
 * the body its marker replaced (`EvictedItem.contentHash`); the read tool
 * hashes the body it just produced the same way and asks for an evicted read
 * of the same canonical path with the same hash. A match means the bytes the
 * model is about to receive are the bytes it already had, so the port records
 * a `contextRecall` with trigger `reread` and the read result carries the ref:
 * exact provenance, one interception, nothing else intercepted. mtime never
 * enters it; a touched file with the same content is the same content.
 *
 * Cost. The read tool is hot and the ledger reader re-parses the file on every
 * call, so the port never folds the ledger per read. It keeps a small index
 * from content hash to the evicted reads that carry it, built lazily from the
 * eviction records of the current session and rebuilt only when an eviction
 * event is published (`invalidate`) or the session changes. A hash miss, the
 * common case, costs one map lookup. Only a hit folds the active path, to
 * confirm the ref is still evicted on this branch before anything is written.
 */

import type { ContextRecalledPayload } from "../../../core/bus-events.js";
import type { SessionEntryInput } from "../../session/contract.js";
import type { SessionEntry } from "../../session/entries.js";
import { foldWorkingSet } from "./fold.js";
import { buildPathIndex, canonicalize } from "./path-index.js";
import { buildRecallFields, recallParentTurnId, resolveRecall } from "./recall.js";

export interface RereadMatch {
	ref: string;
	alias?: string;
}

/** What the read tool needs; `src/tools/read.ts` types its port against this. */
export interface ReadRecallPort {
	/** Newest evicted read of the canonical `path` whose stored hash equals `contentHash`, on the active path; null when none. */
	matchEvictedRead(path: string, contentHash: string): RereadMatch | null;
	/** Append the `reread` recall record and publish it; the recall entry's turnId, or null when the append failed. */
	recordReread(input: { ref: string; toolCallId?: string; tokensReadmitted: number }): string | null;
}

export interface RereadPortDeps {
	sessionId(): string | null;
	readEntries(): ReadonlyArray<SessionEntry>;
	activeLeafTurnId(): string | undefined;
	cwd(): string | null;
	appendEntry(entry: SessionEntryInput): SessionEntry;
	onRecalled?: (payload: ContextRecalledPayload) => void;
}

interface HashIndex {
	sessionId: string | null;
	/** Content hash to the evicted reads carrying it, in ledger order. */
	byHash: Map<string, Array<{ ref: string; path: string }>>;
}

export interface RereadRecallPort extends ReadRecallPort {
	/** Forget the index; the next lookup rebuilds it. Call on every eviction event. */
	invalidate(): void;
}

function buildIndex(deps: RereadPortDeps): HashIndex {
	const entries = deps.readEntries();
	const index = buildPathIndex(entries, { cwd: deps.cwd() });
	const byHash = new Map<string, Array<{ ref: string; path: string }>>();
	for (const entry of entries) {
		if (entry.kind !== "contextEviction") continue;
		for (const item of entry.evicted) {
			if (item.contentHash === undefined) continue;
			const observation = index.byRef.get(item.ref.entry);
			if (observation === undefined || observation.op !== "read" || observation.path.length === 0) continue;
			const bucket = byHash.get(item.contentHash);
			const row = { ref: item.ref.entry, path: observation.path };
			if (bucket === undefined) byHash.set(item.contentHash, [row]);
			else bucket.push(row);
		}
	}
	return { sessionId: deps.sessionId(), byHash };
}

export function createRereadRecallPort(deps: RereadPortDeps): RereadRecallPort {
	let index: HashIndex | null = null;
	const ensure = (): HashIndex => {
		const sessionId = deps.sessionId();
		if (index === null || index.sessionId !== sessionId) index = buildIndex(deps);
		return index;
	};
	return {
		invalidate(): void {
			index = null;
		},
		matchEvictedRead(path, contentHash): RereadMatch | null {
			if (deps.sessionId() === null) return null;
			const wanted = canonicalize(path, deps.cwd());
			const rows = ensure().byHash.get(contentHash);
			if (rows === undefined || wanted.length === 0) return null;
			const candidates = rows.filter((row) => row.path === wanted);
			if (candidates.length === 0) return null;
			// A hit is rare and worth one fold: the ref must still be evicted on
			// the branch the session is on, or the marker the model is answering
			// does not exist there.
			const entries = deps.readEntries();
			const leaf = deps.activeLeafTurnId();
			const view = foldWorkingSet(entries, leaf);
			for (let i = candidates.length - 1; i >= 0; i -= 1) {
				const candidate = candidates[i];
				if (candidate === undefined || !view.evicted.has(candidate.ref)) continue;
				const resolved = resolveRecall(entries, view, candidate.ref, leaf);
				if (!resolved.ok) continue;
				const alias = view.evicted.get(candidate.ref)?.alias;
				return { ref: candidate.ref, ...(alias === undefined ? {} : { alias }) };
			}
			return null;
		},
		recordReread(input): string | null {
			const entries = deps.readEntries();
			const leaf = deps.activeLeafTurnId();
			const view = foldWorkingSet(entries, leaf);
			const resolved = resolveRecall(entries, view, input.ref, leaf);
			if (!resolved.ok) return null;
			const fields = buildRecallFields(resolved.result, {
				trigger: "reread",
				...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
			});
			let recorded: SessionEntry;
			try {
				recorded = deps.appendEntry({ ...fields, parentTurnId: recallParentTurnId(entries, leaf) });
			} catch {
				// A recall record that cannot be written costs provenance, not
				// correctness: the read result still carries the body.
				return null;
			}
			deps.onRecalled?.({ ref: input.ref, trigger: "reread", tokensReadmitted: input.tokensReadmitted, at: Date.now() });
			return recorded.turnId;
		},
	};
}
