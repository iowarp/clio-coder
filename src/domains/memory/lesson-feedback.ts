/**
 * What memory learns from its own deliveries, reviews and history, filed into
 * the durable lesson store.
 *
 * This used to live in the composition root, which tracked proposals, decided
 * held and contradicted transitions and filed scope-end lessons itself. Memory
 * owns those semantics; the composition root supplies the data root, the
 * current session, and where operator notices and store diagnostics go.
 *
 * Historical lessons are recoverable: candidates are written to a host-owned
 * pending file before the store is touched, so a store failure or an exit
 * between extraction and filing leaves them for the next process instead of
 * losing them behind an advanced history cursor.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import { type MemoryGateOutcome, recordMemoryObservations } from "./guardian-gate.js";
import type { MemoryDeliveryOutcome, MemoryKnowledgeReview } from "./intervention.js";
import type { MemoryObservationEvent } from "./observation-events.js";
import { observationDigest } from "./observations.js";
import type { TaskMemoryEntry } from "./task-bank.js";
import { TASK_MEMORY_CONTENT_MAX_CHARS } from "./task-bank.js";
import { proposeInjectedTaskMemory } from "./task-bank-promotion.js";
import type { MemoryObservationKind, MemoryRecord } from "./types.js";

export interface LessonFeedbackPorts {
	dataDir(): string;
	stateDir(): string;
	/** The current session and its workspace; a read-only query. */
	session(): { id: string; cwd: string } | null;
	/** A gate decision the operator should see. */
	notice(line: string): void;
	/** A store failure; never steers a session. */
	diagnostic(line: string): void;
	event?(name: MemoryObservationEvent, facts: Record<string, unknown>): void;
}

export interface HistoryLessons {
	sessionId: string;
	root: string;
	grounded: ReadonlyArray<TaskMemoryEntry>;
	ungrounded: ReadonlyArray<TaskMemoryEntry>;
}

/** Filed in the store, or saved as pending candidates the next replay will file; false means neither. */
export type HistoryFiling = "filed" | "pending" | "failed";

interface ProposedEntry {
	content: string;
	record: Promise<{ memoryId: string; sessionId: string } | null>;
	/**
	 * Whether this session already reported the proposal held. Filing and
	 * evidence are separate: a lesson filed before its command had run is
	 * still owed its held observation when the command later succeeds.
	 */
	held: boolean;
}

const HISTORY_CANDIDATE_VERSION = 1;
const HISTORY_CANDIDATE_MAX_BYTES = 64 * 1024;
/** Pending files kept at most; past it a failing store holds the history cursor instead (SPEC R11). */
const HISTORY_CANDIDATE_MAX_FILES = 64;
/**
 * The sync lock wait spins the event loop, and foreground history review can
 * save while the chat streams, so a wedged lock must not freeze rendering. A
 * refused writer only keeps its cursor. Matches the history cursor locks.
 */
const HISTORY_CANDIDATE_LOCK_TIMEOUT_MS = 100;
/** Pending history files read per replay wake. */
export const HISTORY_REPLAY_BATCH = 4;

export class MemoryLessonFeedback {
	readonly #ports: LessonFeedbackPorts;
	/**
	 * Bank entry id to the durable proposal it became, held until delivery
	 * outcomes arrive. Entry ids restart with every bank reset, so a final
	 * outcome report clears the map.
	 */
	readonly #proposed = new Map<string, ProposedEntry>();
	#inFlight = new Set<Promise<unknown>>();
	/** Pending history files this process already failed to replay; retried by the next process. */
	readonly #replayFailed = new Set<string>();

	constructor(ports: LessonFeedbackPorts) {
		this.#ports = ports;
	}

	/** Resolves when every store write started so far has settled. */
	async whenSettled(): Promise<void> {
		while (this.#inFlight.size > 0) await Promise.allSettled([...this.#inFlight]);
	}

	/** A submitted model-tier reminder's cited entries are proposed and observed delivered. */
	delivered(entries: ReadonlyArray<TaskMemoryEntry>): void {
		this.#propose(entries, "delivered");
	}

	/**
	 * A knowledge entry the guardian kept across a later step becomes a
	 * repository lesson; one it deleted or rewrote takes its lesson back.
	 */
	reviewKnowledge(review: MemoryKnowledgeReview): void {
		const fresh = review.kept.filter((entry) => this.#proposed.get(entry.id)?.content !== entry.content);
		// Already filed, now grounded: the observation goes to the existing
		// proposal. The gate still holds a record the operator rejected.
		const nowHeld = review.kept.flatMap((entry) => {
			const filed = this.#proposed.get(entry.id);
			if (filed === undefined || filed.content !== entry.content || filed.held) return [];
			filed.held = true;
			return [filed.record];
		});
		if (fresh.length > 0) this.#propose(fresh, "held");
		if (nowHeld.length > 0) this.#observeResolved(nowHeld, "held", "held lessons not recorded");
		const unfounded = review.ungrounded.filter((entry) => this.#proposed.get(entry.id)?.content !== entry.content);
		if (unfounded.length > 0) this.#propose(unfounded, null);
		const withdrawn = review.withdrawn.flatMap((entry) => {
			const proposed = this.#proposed.get(entry.id);
			if (proposed?.content !== entry.content) return [];
			this.#proposed.delete(entry.id);
			return [proposed.record];
		});
		if (withdrawn.length > 0) this.#observeResolved(withdrawn, "contradicted", "withdrawn knowledge not recorded");
	}

	/**
	 * Feed what the session saw after a submitted delivery into the store's
	 * gate. Bound to the fact that was delivered: an entry rewritten since then
	 * holds a different proposal under the same id.
	 */
	settleDeliveries(outcomes: ReadonlyArray<MemoryDeliveryOutcome>, final: boolean): void {
		const pending = outcomes.flatMap((outcome) =>
			outcome.entries.map(async (entry) => {
				const current = this.#proposed.get(entry.id);
				if (current?.content !== entry.content) return null;
				if (outcome.kind === "held") {
					if (current.held) return null;
					current.held = true;
				}
				const proposed = await current.record;
				return proposed ? { ...proposed, kind: outcome.kind } : null;
			}),
		);
		if (final) this.#proposed.clear();
		if (pending.length === 0) return;
		this.#track(
			Promise.all(pending)
				.then((resolved) =>
					recordMemoryObservations(
						this.#ports.dataDir(),
						resolved.filter((item) => item !== null),
					),
				)
				.then((outcome) => this.#reportGate(outcome))
				.catch(this.#storeFailure("delivery outcomes not recorded")),
		);
	}

	/** Kept lessons the turn-end pass deleted because the turn showed them wrong. */
	retiredKept(memoryIds: ReadonlyArray<string>): void {
		const sessionId = this.#ports.session()?.id;
		if (sessionId === undefined || memoryIds.length === 0) return;
		this.#observe(
			memoryIds.map((memoryId) => ({ memoryId, sessionId, kind: "contradicted" as const })),
			"retired lessons not recorded",
		);
	}

	/** Approved lessons a submitted reminder carried, and those whose recommended command then succeeded. */
	durableOutcomes(input: {
		sessionId: string | undefined;
		delivered: ReadonlyArray<string>;
		held: ReadonlyArray<string>;
	}): void {
		const sessionId = input.sessionId;
		if (sessionId === undefined) return;
		this.#observe(
			[
				...input.delivered.map((memoryId) => ({ memoryId, sessionId, kind: "delivered" as const })),
				...input.held.map((memoryId) => ({ memoryId, sessionId, kind: "held" as const })),
			],
			"durable lesson outcomes not recorded",
		);
	}

	/**
	 * Lessons still in the bank when its scope ends. One a later step already
	 * kept is in the store; the rest are filed without evidence and wait for a
	 * later session to learn the same thing.
	 */
	scopeEnd(input: { sessionId: string | undefined; lessons: ReadonlyArray<TaskMemoryEntry> }): void {
		const unfiled = input.lessons.filter((entry) => this.#proposed.get(entry.id)?.content !== entry.content);
		if (unfiled.length > 0) this.#propose(unfiled, null, input.sessionId);
	}

	/**
	 * File lessons history review found in an earlier session, with that session
	 * as provenance. A lesson the host bound to evidence it observed in that
	 * session is observed held; the store's gate decides from there. The
	 * candidates are saved first, so the caller may advance its history cursor
	 * on `filed` or `pending` and must not on `failed`.
	 */
	async fileHistory(input: HistoryLessons): Promise<HistoryFiling> {
		if (input.grounded.length + input.ungrounded.length === 0) return "filed";
		const path = this.#saveHistoryCandidates(input);
		const filed = await this.#fileHistoryEntries(input);
		if (filed) {
			if (path !== null) this.#removeCandidates(path);
			return "filed";
		}
		return path === null ? "failed" : "pending";
	}

	/**
	 * Pending history candidates left by an interrupted process or a failed
	 * store write, at most `HISTORY_REPLAY_BATCH` files per call. No model call:
	 * the candidates and their evidence verdicts were decided when they were
	 * saved.
	 */
	hasPendingHistory(): boolean {
		return this.#pendingHistoryFiles(1).length > 0;
	}

	async replayHistory(): Promise<number> {
		let filed = 0;
		for (const path of this.#pendingHistoryFiles(HISTORY_REPLAY_BATCH)) {
			const saved = readHistoryCandidates(path);
			if (saved === "corrupt") {
				// Nothing in it can be filed, and keeping it would be retried forever.
				this.#removeCandidates(path);
				continue;
			}
			if (saved === "unreadable") {
				// A read that failed, or a newer format this process does not know,
				// says nothing about the lessons inside; the cursor already moved past
				// them, so the file waits for a process that can read it.
				this.#replayFailed.add(path);
				continue;
			}
			if (await this.#fileHistoryEntries(saved)) {
				this.#removeCandidates(path);
				filed += 1;
				this.#ports.event?.("history-candidates-replayed", {
					sourceSessionId: saved.sessionId,
					count: saved.grounded.length + saved.ungrounded.length,
				});
			} else {
				this.#replayFailed.add(path);
			}
		}
		return filed;
	}

	#historyDirectory(): string {
		return join(this.#ports.stateDir(), "memory", "history-candidates");
	}

	#pendingHistoryCount(): number {
		try {
			return readdirSync(this.#historyDirectory()).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).length;
		} catch {
			return 0; /* Nothing was ever saved here. */
		}
	}

	#pendingHistoryFiles(limit: number): string[] {
		let directory: string;
		let names: string[];
		try {
			directory = this.#historyDirectory();
			names = readdirSync(directory);
		} catch {
			return []; /* Nothing was ever saved here. */
		}
		const paths: string[] = [];
		for (const name of names.sort()) {
			if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
			const path = join(directory, name);
			if (this.#replayFailed.has(path)) continue;
			paths.push(path);
			if (paths.length >= limit) break;
		}
		return paths;
	}

	#saveHistoryCandidates(input: HistoryLessons): string | null {
		let stateDir: string;
		try {
			stateDir = this.#ports.stateDir();
		} catch {
			return null; /* No state root: nothing can be saved for replay. */
		}
		if (!existsSync(stateDir)) return null;
		const body = JSON.stringify({
			version: HISTORY_CANDIDATE_VERSION,
			sessionId: input.sessionId,
			root: input.root,
			grounded: input.grounded,
			ungrounded: input.ungrounded,
			at: new Date().toISOString(),
		});
		if (Buffer.byteLength(body) > HISTORY_CANDIDATE_MAX_BYTES) return null;
		const directory = this.#historyDirectory();
		const path = join(
			directory,
			`${observationDigest([input.sessionId, input.grounded.map((entry) => entry.content), input.ungrounded.map((entry) => entry.content)])}.json`,
		);
		// Several processes share one state root. The count, the identity check
		// and the write hold one directory lock so concurrent writers cannot all
		// pass the count and overrun the cap; a writer refused here reports
		// `failed`, which keeps its history cursor.
		try {
			return withStateFileLockSync(
				directory,
				() => {
					// The same lessons already saved: rewriting them adds no file.
					if (!existsSync(path) && this.#pendingHistoryCount() >= HISTORY_CANDIDATE_MAX_FILES) {
						this.#ports.diagnostic("history lesson candidates not saved: pending candidate limit reached");
						return null;
					}
					safeResourceWrite(path, body, { mode: 0o600 });
					return path;
				},
				{ timeoutMs: HISTORY_CANDIDATE_LOCK_TIMEOUT_MS },
			);
		} catch (error) {
			this.#ports.diagnostic(`history lesson candidates not saved: ${errorText(error)}`);
			return null;
		}
	}

	#removeCandidates(path: string): void {
		try {
			unlinkSync(path);
		} catch {
			// Already gone: another process replayed it, or the state root was removed.
		}
	}

	async #fileHistoryEntries(input: HistoryLessons): Promise<boolean> {
		const entries = [...input.grounded, ...input.ungrounded];
		try {
			const result = await proposeInjectedTaskMemory(this.#ports.dataDir(), {
				sessionId: input.sessionId,
				cwd: input.root,
				entries,
			});
			for (const error of result.errors) this.#ports.diagnostic(`proposed record not written for ${error}`);
			const held = [
				...new Set(
					input.grounded.flatMap((entry) => {
						const record = result.recordByEntry.get(entry.id);
						return record === undefined ? [] : [record.id];
					}),
				),
			];
			if (held.length > 0)
				this.#reportGate(
					await recordMemoryObservations(
						this.#ports.dataDir(),
						held.map((memoryId) => ({ memoryId, sessionId: input.sessionId, kind: "held" as const })),
					),
				);
			return true;
		} catch (error) {
			this.#storeFailure("history lessons not recorded")(error);
			return false;
		}
	}

	/** Propose entries at repository scope and record what the session observed about each. */
	#propose(entries: ReadonlyArray<TaskMemoryEntry>, kind: "delivered" | "held" | null, scopeSessionId?: string): void {
		const session = this.#ports.session();
		const sessionId = scopeSessionId ?? session?.id ?? null;
		// Ports resolve inside the chain: an unavailable data root is a store failure, never a relative write.
		const proposal = Promise.resolve()
			.then(() =>
				proposeInjectedTaskMemory(this.#ports.dataDir(), {
					sessionId,
					cwd: session?.cwd || process.cwd(),
					entries,
				}),
			)
			.then(async (result) => {
				for (const error of result.errors) this.#ports.diagnostic(`proposed record not written for ${error}`);
				if (sessionId !== null && kind !== null && result.records.length > 0) {
					// Only lessons collect evidence. A cited plain entry is still filed
					// for the operator, and stays pending without them.
					const ids = [
						...new Set(
							entries.flatMap((entry) => {
								const record = entry.durable === true ? result.recordByEntry.get(entry.id) : undefined;
								return record === undefined ? [] : [record.id];
							}),
						),
					];
					this.#reportGate(
						await recordMemoryObservations(
							this.#ports.dataDir(),
							ids.map((memoryId) => ({ memoryId, sessionId, kind })),
						),
					);
				}
				return result.recordByEntry;
			})
			.catch((error: unknown) => {
				this.#storeFailure("proposed records not written")(error);
				return new Map<string, MemoryRecord>();
			});
		this.#track(proposal);
		for (const entry of entries) {
			this.#proposed.set(entry.id, {
				content: entry.content,
				held: kind === "held" && entry.durable === true,
				record: proposal.then((records) => {
					const record = entry.durable === true ? records.get(entry.id) : undefined;
					return record === undefined || sessionId === null ? null : { memoryId: record.id, sessionId };
				}),
			});
		}
	}

	#observeResolved(
		records: ReadonlyArray<Promise<{ memoryId: string; sessionId: string } | null>>,
		kind: MemoryObservationKind,
		failure: string,
	): void {
		this.#track(
			Promise.all(records)
				.then((resolved) =>
					recordMemoryObservations(
						this.#ports.dataDir(),
						resolved.filter((item) => item !== null).map((item) => ({ ...item, kind })),
					),
				)
				.then((outcome) => this.#reportGate(outcome))
				.catch(this.#storeFailure(failure)),
		);
	}

	#observe(inputs: Parameters<typeof recordMemoryObservations>[1], failure: string): void {
		if (inputs.length === 0) return;
		this.#track(
			Promise.resolve()
				.then(() => recordMemoryObservations(this.#ports.dataDir(), inputs))
				.then((outcome) => this.#reportGate(outcome))
				.catch(this.#storeFailure(failure)),
		);
	}

	/** Nobody reviews these by hand any more, so a gate change is told to the operator. */
	#reportGate(result: MemoryGateOutcome): void {
		for (const record of result.approved) {
			this.#ports.notice(`Memory: kept a repository lesson (${record.id}): ${record.lesson}`);
			this.#ports.event?.("lesson-approved", { id: record.id, by: record.approval?.by ?? null });
		}
		for (const record of result.demoted) {
			this.#ports.notice(`Memory: withdrew a repository lesson that stopped holding (${record.id}).`);
			this.#ports.event?.("lesson-demoted", { id: record.id });
		}
	}

	#storeFailure(what: string): (error: unknown) => void {
		return (error) => this.#ports.diagnostic(`${what}: ${errorText(error)}`);
	}

	#track(promise: Promise<unknown>): void {
		const settled = promise.then(
			() => undefined,
			() => undefined,
		);
		this.#inFlight.add(settled);
		void settled.then(() => this.#inFlight.delete(settled));
	}
}

function readHistoryCandidates(path: string): HistoryLessons | "corrupt" | "unreadable" {
	let text: string;
	try {
		if (statSync(path).size > HISTORY_CANDIDATE_MAX_BYTES) return "corrupt";
		text = readFileSync(path, "utf8");
	} catch {
		return "unreadable";
	}
	try {
		const value = JSON.parse(text) as Record<string, unknown>;
		if (typeof value.version === "number" && value.version > HISTORY_CANDIDATE_VERSION) return "unreadable";
		if (
			value.version !== HISTORY_CANDIDATE_VERSION ||
			typeof value.sessionId !== "string" ||
			typeof value.root !== "string" ||
			!Array.isArray(value.grounded) ||
			!Array.isArray(value.ungrounded) ||
			!value.grounded.every(candidateEntry) ||
			!value.ungrounded.every(candidateEntry)
		)
			return "corrupt";
		return {
			sessionId: value.sessionId,
			root: value.root,
			grounded: value.grounded as TaskMemoryEntry[],
			ungrounded: value.ungrounded as TaskMemoryEntry[],
		};
	} catch {
		return "corrupt"; /* A pending file that does not parse carries nothing that can be filed. */
	}
}

function candidateEntry(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Record<string, unknown>;
	return (
		entry.kind === "knowledge" &&
		typeof entry.id === "string" &&
		typeof entry.content === "string" &&
		entry.content.length > 0 &&
		entry.content.length <= TASK_MEMORY_CONTENT_MAX_CHARS &&
		typeof entry.createdAt === "string" &&
		typeof entry.lastTouchedAt === "string"
	);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
