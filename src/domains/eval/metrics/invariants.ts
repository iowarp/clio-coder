/**
 * Invariant metrics: the promises Clio makes about its own machinery, read
 * from the journal one eval item left behind.
 *
 * These invert what a benchmark measures. A weak model that never solved the
 * task leaves every one of them intact; a strong model that solved it leaves
 * them broken the moment Clio failed to seal, to agree with itself, or to
 * write a receipt its own ledger can authenticate. The task outcome and the
 * machinery's behavior are separate readings, and only the second is a gate.
 *
 * Every reader here is total and never throws. A metric this pass could not
 * compute is absent rather than false: a threshold on an absent metric fails
 * closed, while a fabricated value would be indistinguishable from a check
 * that ran and passed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReceiptIntegrity } from "../../dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt } from "../../dispatch/types.js";

export interface EvalRunJournal {
	/** Ledger envelopes by run id. The authority a receipt is authenticated against. */
	envelopes: Map<string, RunEnvelope>;
	/** Receipts that parsed into receipt shape. */
	receipts: RunReceipt[];
	/**
	 * Files present under receipts/. A file Clio wrote that no longer parses
	 * as a receipt is a sealed artifact that cannot be read, so the count is
	 * kept apart from `receipts.length` rather than folded into it.
	 */
	receiptFiles: number;
}

/**
 * Read the run ledger and receipts an eval item's Clio wrote under its own
 * state directory. Returns null when there is no such directory to read, which
 * is the one case where the invariants below are genuinely unobservable.
 */
export function readRunJournal(stateDir: string): EvalRunJournal | null {
	if (!existsSync(stateDir)) return null;
	return {
		envelopes: readEnvelopes(join(stateDir, "runs.json")),
		...readReceipts(join(stateDir, "receipts")),
	};
}

function readEnvelopes(runsPath: string): Map<string, RunEnvelope> {
	const envelopes = new Map<string, RunEnvelope>();
	if (!existsSync(runsPath)) return envelopes;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(runsPath, "utf8")) as unknown;
	} catch {
		return envelopes;
	}
	if (!Array.isArray(parsed)) return envelopes;
	for (const entry of parsed) {
		if (isRecord(entry) && typeof entry.id === "string") envelopes.set(entry.id, entry as unknown as RunEnvelope);
	}
	return envelopes;
}

function readReceipts(receiptsDir: string): { receipts: RunReceipt[]; receiptFiles: number } {
	if (!existsSync(receiptsDir)) return { receipts: [], receiptFiles: 0 };
	let names: string[];
	try {
		names = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
	} catch {
		return { receipts: [], receiptFiles: 0 };
	}
	const receipts: RunReceipt[] = [];
	for (const name of names) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
			if (isReceiptShaped(parsed)) receipts.push(parsed);
		} catch {
			// Counted by receiptFiles below: an unreadable receipt is a broken
			// seal, not a receipt that was never written.
		}
	}
	return { receipts, receiptFiles: names.length };
}

/**
 * Invariant metrics for one eval item.
 *
 * - `receipt.count` / `receipt.sealed`: how many receipts this item's Clio
 *   sealed. Zero is an observation, not an absence: the journal was readable
 *   and empty.
 * - `receipt.rootCount`: receipts that begin their own lineage. One per
 *   operator-initiated run; a plan with retries has more.
 * - `receipt.integrityValid`: every sealed receipt parsed and authenticated
 *   against its own ledger envelope through `verifyReceiptIntegrity`. Absent
 *   when nothing sealed, because there is no seal to judge.
 * - `receipt.outcomeMatchesExit`: no receipt claims an outcome its own exit
 *   code contradicts, and where exactly one root receipt exists, its success
 *   agrees with the exit status the process reported. A receipt that says
 *   `succeeded` while the process exited nonzero is the failure this catches.
 *   With several roots the process-level half is unattributable and only the
 *   per-receipt half is checked.
 */
export function receiptInvariantMetrics(
	journal: EvalRunJournal | null,
	processExitCode: number,
): Record<string, number | boolean> {
	if (journal === null) return {};
	const sealed = journal.receiptFiles > 0;
	const roots = journal.receipts.filter(isRootReceipt);
	const base = { "receipt.count": journal.receiptFiles, "receipt.sealed": sealed, "receipt.rootCount": roots.length };
	if (!sealed) return base;
	return {
		...base,
		"receipt.integrityValid": integrityValid(journal),
		"receipt.outcomeMatchesExit": outcomeMatchesExit(journal, roots, processExitCode),
	};
}

function integrityValid(journal: EvalRunJournal): boolean {
	// A receipt file that did not parse never reaches the loop below, so the
	// count has to agree first: an unreadable seal cannot be authenticated.
	if (journal.receipts.length !== journal.receiptFiles) return false;
	return journal.receipts.every((receipt) => {
		const envelope = journal.envelopes.get(receipt.runId);
		// No envelope means no authority to verify against. The receipt is
		// unauthenticated, which is a failure and never an absence.
		if (envelope === undefined) return false;
		return verifyReceiptIntegrity(receipt, envelope).ok;
	});
}

function outcomeMatchesExit(
	journal: EvalRunJournal,
	roots: ReadonlyArray<RunReceipt>,
	processExitCode: number,
): boolean {
	if (journal.receipts.length !== journal.receiptFiles) return false;
	const selfConsistent = journal.receipts.every(
		(receipt) => (receipt.outcome === "succeeded") === (receipt.exitCode === 0),
	);
	if (!selfConsistent) return false;
	const root = roots.length === 1 ? roots[0] : undefined;
	if (root === undefined) return true;
	return (root.exitCode === 0) === (processExitCode === 0);
}

function isRootReceipt(receipt: RunReceipt): boolean {
	return receipt.lineage === undefined || receipt.lineage.rootRunId === receipt.runId;
}

export interface EvalStreamInvariants {
	/** `message_update` events seen on the wire. A diagnostic, not a promise: the two headless surfaces name increments differently. */
	messageUpdateCount: number;
	/** Events that republished a cumulative snapshot instead of an increment. */
	cumulativeSnapshots: number;
	/** Assistant `message_end` events carrying provider usage. */
	usageMessages: number;
	/** Assistant `message_end` events whose provider response id was already reported. */
	repeatedResponses: number;
	/** Assistant `message_end` events carrying a response id at all. */
	identifiedResponses: number;
	/** Total tokens folded from `message_end`, the per-message view. */
	messageTokenTotal: number;
	/** Total tokens summed from `agent_end`, the per-segment view. */
	segmentTokenTotal: number;
	/** `agent_end` events that reported measured usage. */
	measuredSegments: number;
}

export const EMPTY_STREAM_INVARIANTS: EvalStreamInvariants = {
	messageUpdateCount: 0,
	cumulativeSnapshots: 0,
	usageMessages: 0,
	repeatedResponses: 0,
	identifiedResponses: 0,
	messageTokenTotal: 0,
	segmentTokenTotal: 0,
	measuredSegments: 0,
};

/**
 * Sum the readings of several child processes in one item. Response ids are
 * per-run, so a repeat can only be a repeat within one stream; the counts
 * therefore add without needing to compare ids across processes.
 */
export function addStreamInvariants(left: EvalStreamInvariants, right: EvalStreamInvariants): EvalStreamInvariants {
	return {
		messageUpdateCount: left.messageUpdateCount + right.messageUpdateCount,
		cumulativeSnapshots: left.cumulativeSnapshots + right.cumulativeSnapshots,
		usageMessages: left.usageMessages + right.usageMessages,
		repeatedResponses: left.repeatedResponses + right.repeatedResponses,
		identifiedResponses: left.identifiedResponses + right.identifiedResponses,
		messageTokenTotal: left.messageTokenTotal + right.messageTokenTotal,
		segmentTokenTotal: left.segmentTokenTotal + right.segmentTokenTotal,
		measuredSegments: left.measuredSegments + right.measuredSegments,
	};
}

export interface EvalStreamInvariantFold {
	/** Feed a raw stdout chunk; partial trailing lines are held until completed. */
	push(chunk: string): void;
	invariants(): EvalStreamInvariants;
}

/**
 * Fold the headless `--json` stream's own structural promises as it arrives.
 *
 * Folding live rather than reading the stored artifact is what makes these
 * readings trustworthy: the operator-facing stdout keeps only a bounded head
 * and tail, and the one regression these catch is a verbose run republishing
 * content, which is exactly the run whose middle does not survive.
 */
export function createStreamInvariantFold(): EvalStreamInvariantFold {
	const state: EvalStreamInvariants = {
		messageUpdateCount: 0,
		cumulativeSnapshots: 0,
		usageMessages: 0,
		repeatedResponses: 0,
		identifiedResponses: 0,
		messageTokenTotal: 0,
		segmentTokenTotal: 0,
		measuredSegments: 0,
	};
	const seenResponses = new Set<string>();
	let pending = "";

	const consume = (line: string): void => {
		if (line.trim().length === 0) return;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(event)) return;
		if (event.type === "message_update") {
			state.messageUpdateCount += 1;
			// The increment is the only part of an update that is new. A top-level
			// message or a nested partial is the growing snapshot of a message
			// whose completed form follows, and republishing it per delta is
			// quadratic in the length of the answer.
			const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
			if (event.message !== undefined || assistantEvent?.partial !== undefined) state.cumulativeSnapshots += 1;
			return;
		}
		if (event.type === "agent_end") {
			// A segment's transcript is every message that already crossed as its
			// own `message_end`. The summary is what a segment adds.
			if (Array.isArray(event.messages)) state.cumulativeSnapshots += 1;
			const usage = isRecord(event.usage) ? event.usage : undefined;
			if (usage === undefined || usage.measured !== true) return;
			state.measuredSegments += 1;
			state.segmentTokenTotal += numberField(usage, "totalTokens");
			return;
		}
		if (event.type !== "message_end") return;
		const message = isRecord(event.message) ? event.message : undefined;
		if (message === undefined || message.role !== "assistant") return;
		const usage = isRecord(message.usage) ? message.usage : undefined;
		if (usage === undefined) return;
		state.usageMessages += 1;
		const input = numberField(usage, "input");
		const output = numberField(usage, "output");
		const cacheRead = numberField(usage, "cacheRead");
		const cacheWrite = numberField(usage, "cacheWrite");
		const totalTokens = numberField(usage, "totalTokens");
		state.messageTokenTotal += totalTokens > 0 ? totalTokens : input + output + cacheRead + cacheWrite;
		const responseId = message.responseId;
		if (typeof responseId !== "string" || responseId.length === 0) return;
		state.identifiedResponses += 1;
		if (seenResponses.has(responseId)) state.repeatedResponses += 1;
		seenResponses.add(responseId);
	};

	return {
		push(chunk: string): void {
			pending += chunk;
			for (;;) {
				const newline = pending.indexOf("\n");
				if (newline === -1) break;
				consume(pending.slice(0, newline).replace(/\r$/u, ""));
				pending = pending.slice(newline + 1);
			}
		},
		invariants(): EvalStreamInvariants {
			if (pending.length > 0) {
				consume(pending.replace(/\r$/u, ""));
				pending = "";
			}
			return { ...state };
		},
	};
}

/**
 * Metrics for the wire stream's structural promises.
 *
 * - `stream.cumulativeSnapshots`: content crosses the wire once, as an
 *   increment while it streams and as one completed message when it lands. An
 *   event that republishes a growing partial message, or a segment that
 *   republishes the transcript every message of which already crossed, is that
 *   promise broken. This is the one reading both headless surfaces answer: the
 *   main agent publishes increments as `text_delta` and a worker publishes them
 *   as `message_update` deltas, so `stream.messageUpdateCount` beside it is a
 *   diagnostic count rather than a promise.
 * - `stream.usageDoubleCounted`: true when one provider response was reported
 *   as a completed assistant message more than once, which is the shape that
 *   makes a run's cost read higher than it was. Absent when no message carried
 *   a response id, because with nothing to key on there is nothing to judge.
 * - `stream.segmentUsageMatchesMessages`: the per-message view and the
 *   per-segment view of the same run agree on its token total. Two
 *   independently computed accounts disagreeing means one of them is wrong
 *   about what the run cost. Absent when no segment reported measured usage.
 */
export function streamInvariantMetrics(stream: EvalStreamInvariants): Record<string, number | boolean> {
	return {
		"stream.messageUpdateCount": stream.messageUpdateCount,
		"stream.cumulativeSnapshots": stream.cumulativeSnapshots,
		...(stream.identifiedResponses === 0 ? {} : { "stream.usageDoubleCounted": stream.repeatedResponses > 0 }),
		...(stream.measuredSegments === 0
			? {}
			: { "stream.segmentUsageMatchesMessages": stream.segmentTokenTotal === stream.messageTokenTotal }),
	};
}

function numberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isReceiptShaped(value: unknown): value is RunReceipt {
	if (!isRecord(value)) return false;
	return (
		typeof value.runId === "string" &&
		typeof value.agentId === "string" &&
		typeof value.exitCode === "number" &&
		typeof value.outcome === "string" &&
		isRecord(value.integrity)
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
