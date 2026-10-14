/**
 * The bridge between the session task bank and the durable memory store.
 *
 * Through 0.3.9 these were two stores where only one was ever written. The
 * background plane filled the bank on every step, and nothing but an explicit
 * `clio-coder memory propose` created a record, so `<dataDir>/memory/records.json`
 * on the operator's machine did not exist at all: the tier's own output was
 * discarded with the session that produced it, and the next session's first
 * step read an empty bank and recorded `bank_empty` (#229).
 *
 * A reminder that actually reached the operator is the strongest signal the
 * tier produces, so its cited entries are proposed here for review. They are
 * written unapproved, under the repository the session is working in, and
 * approval stays a separate operator action, exactly as it is for a promotion
 * made by hand from `/memory`.
 */

import { applyMemoryGate } from "./guardian-gate.js";
import { canonicalMemoryRepositoryIdentity, cloneMemoryRecord } from "./operations.js";
import { memoryRecordFromPromotion } from "./promotion.js";
import type { MemoryMutationOptions } from "./store.js";
import { mutateMemoryRecords } from "./store.js";
import type { TaskMemoryEntry } from "./task-bank.js";
import type { MemoryRecord, MemoryRepositoryIdentity } from "./types.js";
import { MEMORY_OBSERVATIONS_MAX } from "./types.js";

export interface ProposeInjectedTaskMemoryInput {
	/** Session the reminder was produced in. Without one there is no provenance to file under. */
	sessionId: string | null;
	/** Working directory of that session, used for the repository scope. */
	cwd: string;
	entries: ReadonlyArray<TaskMemoryEntry>;
	now?: Date;
	writeOptions?: MemoryMutationOptions;
	/** Only a caller that checked concrete source evidence may report a held lesson. */
	observation?: "held";
	heldEntryIds?: ReadonlySet<string>;
}

export interface ProposeInjectedTaskMemoryResult {
	records: MemoryRecord[];
	/** The record each entry resolved to, new or already held, keyed by entry id. */
	recordByEntry: Map<string, MemoryRecord>;
	/** One message per entry the store refused, for the caller to report. */
	errors: string[];
}

export async function proposeInjectedTaskMemory(
	dataDir: string,
	input: ProposeInjectedTaskMemoryInput,
): Promise<ProposeInjectedTaskMemoryResult> {
	const result: ProposeInjectedTaskMemoryResult = { records: [], recordByEntry: new Map(), errors: [] };
	const sessionId = input.sessionId;
	const repository = canonicalMemoryRepositoryIdentity(input.cwd);
	// No session means no provenance. No canonical repository leaves only global
	// scope, which broadens applicability to every future session and is a claim
	// a background step may never make on the operator's behalf.
	if (sessionId === null || sessionId.length === 0 || repository === null) return result;
	const prepared: { entry: TaskMemoryEntry; record: MemoryRecord }[] = [];
	for (const entry of input.entries) {
		if (entry.kind === "status") continue;
		try {
			const record = memoryRecordFromPromotion(
				{ kind: "task-bank-entry", sessionId, evidenceRefs: [`session:${sessionId}`], entry },
				{ scope: "repo", repository },
				input.now ?? new Date(),
			);
			prepared.push({ entry, record });
		} catch (error) {
			input.writeOptions?.signal?.throwIfAborted();
			if (input.writeOptions?.isCurrent?.() === false) throw error;
			result.errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!prepared.length) return result;
	return mutateMemoryRecords(
		dataDir,
		(records) => {
			const updated = [...records];
			let changed = false;
			const at = (input.now ?? new Date()).toISOString();
			for (const item of prepared) {
				const existing =
					updated.find((record) => record.id === item.record.id) ??
					(item.entry.durable === true
						? (similarRepositoryLesson(updated, repository, item.entry.content) ??
							sameCommandLesson(updated, repository, item.entry))
						: null);
				const record = cloneMemoryRecord(existing ?? item.record);
				// One verdict per session: a repeat from the same session adds nothing the gate
				// counts, and stacking it would push older contradictions out of the window.
				const held =
					input.observation === "held" &&
					(input.heldEntryIds === undefined || input.heldEntryIds.has(item.entry.id)) &&
					!(existing?.observations ?? []).some((seen) => seen.sessionId === sessionId && seen.kind === "held");
				if (held) {
					record.observations = [...(record.observations ?? []), { at, sessionId, kind: "held" as const }].slice(
						-MEMORY_OBSERVATIONS_MAX,
					);
					applyMemoryGate(record, at);
				}
				changed ||= !existing || held;
				if (existing) updated[updated.indexOf(existing)] = record;
				else updated.push(record);
				result.records.push(record);
				result.recordByEntry.set(item.entry.id, record);
			}
			return changed ? { records: updated, result } : { result };
		},
		input.writeOptions,
	);
}

/**
 * The repository lesson that already says exactly this, if any. Identity is the
 * text with whitespace collapsed and nothing else: term overlap matched "the
 * cache is safe across sessions" with "the cache is NOT safe across sessions",
 * and a changed number or path the same way, so a new and opposite fact would
 * have counted as a second session holding the old one. A rejected record
 * matches too, because the operator declined that lesson.
 */
function similarRepositoryLesson(
	records: ReadonlyArray<MemoryRecord>,
	repository: MemoryRepositoryIdentity,
	content: string,
): MemoryRecord | null {
	const wanted = normalizeLesson(content);
	if (wanted.length === 0) return null;
	return (
		records.find(
			(record) =>
				record.scope === "repo" &&
				record.repository?.key === repository.key &&
				record.provenance?.sourceEntryKind === "knowledge" &&
				normalizeLesson(record.lesson) === wanted,
		) ?? null
	);
}

/**
 * The repository lesson that already quotes this entry's evidence command.
 * Command evidence binds a lesson to one exact command the shell ran with exit
 * 0, so every such lesson claims the same thing: that command works here. Live
 * sessions filed that one validator recipe as an approved record and a pending
 * rewording of it, and the rewording waited for review forever. As with exact
 * text, a rejected record still matches: the operator declined that recipe.
 * Lessons without command evidence keep the exact-text rule above.
 */
function sameCommandLesson(
	records: ReadonlyArray<MemoryRecord>,
	repository: MemoryRepositoryIdentity,
	entry: TaskMemoryEntry,
): MemoryRecord | null {
	const command = entry.evidenceCommand?.trim();
	if (!command) return null;
	const quoted = `\`${command}\``;
	return (
		records.find(
			(record) =>
				record.scope === "repo" &&
				record.repository?.key === repository.key &&
				record.provenance?.sourceEntryKind === "knowledge" &&
				record.lesson.includes(quoted),
		) ?? null
	);
}

function normalizeLesson(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}
