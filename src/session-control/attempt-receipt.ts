import { providerCheckpointFromMessage } from "../core/provider-checkpoint-handle.js";
import type { TelemetryContext } from "../core/telemetry/context.js";
import type { ContextFoldPayload } from "../core/telemetry/live-events.js";
import type { CallSettled } from "../core/telemetry/schemas.js";
import type { FoldCursor, FoldOwner } from "../domains/context/index.js";
import type { SessionEntry } from "../domains/session/entries.js";
import { activePath } from "../domains/session/tree/active-path.js";
import { providerHistory } from "../engine/agent.js";
import { withLockedSynthesisDirective } from "../engine/loop-guard.js";
import { createRequestStructures } from "../engine/request-structure.js";
import type { EngineModel } from "../engine/types.js";
import { type ContinuityReplayContext, renderModelReplay } from "./model-session-replay.js";

/**
 * Attempt receipts and their verifier (ContextFold CF-9, F14). The live send path takes a receipt beside the
 * structure it digests; `context working-set --verify` renders the session at each receipt's cursor and owner,
 * finalizes it the way the send path does, and compares element digests.
 */

export type AttemptReceipt = NonNullable<CallSettled["cache"]["receipt"]>;

/** What admission read off the ledger for one request: its cursor, owner, and the fold records it renders. */
export interface RequestCursor extends FoldCursor {
	owner?: FoldOwner;
	/** The clock the request's continuity was rendered at, when a ledger render installed its history. */
	continuityAtMs?: number;
	records: string[];
}

const FOLD_RECORD_KINDS: ReadonlySet<SessionEntry["kind"]> = new Set([
	"contextEviction",
	"contextRecall",
	"compactionSummary",
]);
const DECISION_RECORD_KINDS: ReadonlySet<SessionEntry["kind"]> = new Set(["contextEviction", "compactionSummary"]);
const LLM_ROLES: ReadonlySet<string> = new Set(["system", "user", "assistant", "toolResult"]);
const short = (digest: string) => digest.slice(0, 16);
type Context = Parameters<ReturnType<typeof createRequestStructures>>[1];
type Message = Parameters<typeof providerHistory>[0][number];

function cursorEntries(entries: ReadonlyArray<SessionEntry>, hwm: string | null): ReadonlyArray<SessionEntry> {
	if (hwm === null) return [];
	const end = entries.findIndex((entry) => entry.turnId === hwm);
	return end < 0 ? entries : entries.slice(0, end + 1);
}

/** The fold records on the path a cursor renders: rows through `hwm`, the path to `leaf`. */
function viewRecords(entries: ReadonlyArray<SessionEntry>, cursor: FoldCursor): string[] {
	const truncated = cursorEntries(entries, cursor.hwm);
	if (truncated.length === 0) return [];
	return activePath(truncated, cursor.leaf ?? undefined)
		.filter((entry) => FOLD_RECORD_KINDS.has(entry.kind))
		.map((entry) => entry.turnId);
}

/** The request cursor as admission reads it: the ledger's last row, the live leaf, and the owner. */
export function requestCursorOf(
	entries: ReadonlyArray<SessionEntry>,
	leaf: string | null,
	owner: ContinuityReplayContext,
): RequestCursor {
	const cursor: FoldCursor = { hwm: entries.at(-1)?.turnId ?? null, leaf };
	return {
		...cursor,
		...(owner.sessionId !== undefined
			? { owner: { sessionId: owner.sessionId, ...(owner.fork ? { fork: owner.fork } : {}) } }
			: {}),
		...(owner.nowMs !== undefined ? { continuityAtMs: owner.nowMs } : {}),
		records: viewRecords(entries, cursor),
	};
}

/** The native checkpoint identities a request carries, as short digests; never the opaque bytes. */
export function carriedCheckpoints(context: Pick<Context, "messages">): string[] {
	const digests = new Set<string>();
	for (const message of context.messages) {
		const handle = providerCheckpointFromMessage(message);
		if (handle) digests.add(short(handle.digest));
	}
	return [...digests];
}

export type ReceiptStatus = "verified" | "not-verifiable" | "external" | "mismatch";

export interface AttemptVerdict {
	callId: string;
	attemptId: string;
	attempt: number;
	role: string;
	status: ReceiptStatus;
	reason?: string;
}

export interface DecisionReconciliation {
	/** Fold records on the ledger that no committed `context.fold` stage names. */
	missing: string[];
	/** Fold records more than one committed stage names. */
	duplicate: string[];
	/** Committed stages that name a record the ledger does not hold. */
	orphan: string[];
}

export interface ReceiptVerification {
	attempts: AttemptVerdict[];
	decisions: DecisionReconciliation;
}

/** A journal record as the verifier reads it, whether off disk or from an in-process subscriber. */
export interface ReceiptJournalRecord {
	k: string;
	ctx?: TelemetryContext;
	data: unknown;
}

type Structure = NonNullable<CallSettled["cache"]["structure"]>;

/** Every structure's full element list, following each `base` to the attempt it continues. */
function elementLists(settled: ReadonlyArray<CallSettled>): (attemptId: string) => string[] | null {
	const byAttempt = new Map<string, Structure>();
	for (const call of settled) if (call.cache.structure) byAttempt.set(call.attemptId, call.cache.structure);
	const memo = new Map<string, string[] | null>();
	const resolve = (attemptId: string, depth: number): string[] | null => {
		const cached = memo.get(attemptId);
		if (cached !== undefined) return cached;
		const structure = byAttempt.get(attemptId);
		let list: string[] | null = null;
		if (structure && structure.base === undefined) list = structure.entries;
		else if (structure?.baseAttempt && depth < 100_000) {
			const prior = resolve(structure.baseAttempt, depth + 1);
			if (prior && prior.length >= (structure.base ?? 0)) list = [...prior.slice(0, structure.base), ...structure.entries];
		}
		memo.set(attemptId, list);
		return list;
	};
	return (attemptId) => resolve(attemptId, 0);
}

/** The history the receipt's cursor renders, finalized the way the send path finalizes it, as `role:digest`. */
function renderedElements(
	entries: ReadonlyArray<SessionEntry>,
	receipt: AttemptReceipt,
): { elements: string[]; checkpoints: string[] } {
	const render = renderModelReplay(entries, {
		cursor: receipt.cursor,
		// A note's expiry reads the clock: render at the time live rendered it, not at the time of the verify.
		...(receipt.owner || receipt.continuityAtMs !== undefined
			? {
					continuity: {
						...receipt.owner,
						...(receipt.continuityAtMs !== undefined ? { nowMs: receipt.continuityAtMs } : {}),
					},
				}
			: {}),
	});
	const converted = render.messages.filter((message) => LLM_ROLES.has(message.role)) as Message[];
	const history = providerHistory(converted, receipt.route.images);
	// The declarations are not on the ledger; a placeholder head keeps the transcript where the send path put it.
	let context: Context = { systemPrompt: "-", messages: history };
	if (receipt.tail === "synthesis_directive") context = withLockedSynthesisDirective(context);
	const model = { compat: { supportsMidConvoSystemMessages: receipt.route.midConversation } } as EngineModel;
	const structure = createRequestStructures()(model, context);
	return {
		elements: structure.entries.map((digest, index) => `${structure.roles?.[index] ?? "entry"}:${short(digest)}`),
		checkpoints: carriedCheckpoints(context),
	};
}

function sameList(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function verifyReceipt(
	entries: ReadonlyArray<SessionEntry>,
	receipt: AttemptReceipt,
	sent: string[] | null,
): Pick<AttemptVerdict, "status" | "reason"> {
	const unverifiable = (reason: string) => ({ status: "not-verifiable" as const, reason });
	if (sent === null) return unverifiable("element digests unavailable");
	if (receipt.cursor.hwm !== null && !entries.some((entry) => entry.turnId === receipt.cursor.hwm))
		return unverifiable("cursor row not on the ledger");
	if (receipt.route.midConversation && sent.some((element) => element.startsWith("system:")))
		return unverifiable("mid-conversation declaration not on the ledger");
	const rendered = renderedElements(entries, receipt);
	if (receipt.checkpoints.some((digest) => !rendered.checkpoints.includes(digest)))
		return unverifiable("native checkpoint unavailable");
	if (!sameList(viewRecords(entries, receipt.cursor), receipt.records))
		return { status: "mismatch", reason: "fold records differ" };
	if (sameList(rendered.elements, sent)) return { status: "verified" };
	let index = 0;
	while (index < sent.length && rendered.elements[index] === sent[index]) index += 1;
	const role = (sent[index] ?? rendered.elements[index] ?? "entry").split(":")[0];
	return { status: "mismatch", reason: `element ${index} (${role}) differs` };
}

/** Committed `context.fold` stages against the fold records the ledger holds, by record id. */
function reconcileDecisions(
	entries: ReadonlyArray<SessionEntry>,
	records: ReadonlyArray<ReceiptJournalRecord>,
): DecisionReconciliation {
	const held = new Set(entries.filter((entry) => DECISION_RECORD_KINDS.has(entry.kind)).map((entry) => entry.turnId));
	const named = new Map<string, number>();
	for (const record of records) {
		if (record.k !== "context.fold") continue;
		for (const stage of (record.data as ContextFoldPayload).stages) {
			if (stage.outcome !== "committed" || stage.recordId === undefined) continue;
			named.set(stage.recordId, (named.get(stage.recordId) ?? 0) + 1);
		}
	}
	return {
		missing: [...held].filter((id) => !named.has(id)),
		duplicate: [...named].filter(([id, count]) => count > 1 && held.has(id)).map(([id]) => id),
		orphan: [...named.keys()].filter((id) => !held.has(id)),
	};
}

/**
 * Verify every dispatched attempt a session's journal settled. A peer-owned call has no `call.started` of its own
 * and is `external`. Prewarms, summary calls, worker histories, side calls and v6 sessions are `not-verifiable`; so
 * is a main attempt whose declaration, tail, checkpoint or digests the ledger and journal cannot supply. A main
 * attempt is `verified` only when the render at its cursor matches the receipt taken at its send.
 */
export function verifyAttemptReceipts(input: {
	entries: ReadonlyArray<SessionEntry>;
	records: ReadonlyArray<ReceiptJournalRecord>;
	/** The session's worker run journals' records. */
	runRecords?: ReadonlyArray<ReceiptJournalRecord>;
	/** The ledger header's format version. */
	formatVersion?: number;
}): ReceiptVerification {
	const { entries, records } = input;
	const started = new Set(
		records.filter((record) => record.k === "call.started").map((record) => (record.data as { callId: string }).callId),
	);
	const settled = records.filter((record) => record.k === "call.settled");
	const elements = elementLists(settled.map((record) => record.data as CallSettled));
	const v6 = input.formatVersion !== undefined && input.formatVersion < 7;
	const attempts: AttemptVerdict[] = [];
	const verdict = (record: ReceiptJournalRecord, role: string, result: Pick<AttemptVerdict, "status" | "reason">) => {
		const call = record.data as CallSettled;
		attempts.push({ callId: call.callId, attemptId: call.attemptId, attempt: call.attempt, role, ...result });
	};
	for (const record of settled) {
		const call = record.data as CallSettled;
		if (call.disposition === "never_sent") continue;
		const role = record.ctx?.agent.role ?? "unknown";
		if (!started.has(call.callId)) verdict(record, role, { status: "external" });
		else if (role === "prewarm") verdict(record, role, { status: "not-verifiable", reason: "prewarm" });
		else if (role === "compaction") verdict(record, role, { status: "not-verifiable", reason: "summary call" });
		else if (role === "worker") verdict(record, role, { status: "not-verifiable", reason: "worker history" });
		else if (role !== "main") verdict(record, role, { status: "not-verifiable", reason: `${role} side call` });
		else if (v6) verdict(record, role, { status: "not-verifiable", reason: "v6 session" });
		else if (!call.cache.receipt) verdict(record, role, { status: "not-verifiable", reason: "no receipt" });
		else verdict(record, role, verifyReceipt(entries, call.cache.receipt, elements(call.attemptId)));
	}
	for (const record of input.runRecords ?? []) {
		if (record.k !== "call.settled" || (record.data as CallSettled).disposition === "never_sent") continue;
		verdict(record, record.ctx?.agent.role ?? "worker", { status: "not-verifiable", reason: "worker history" });
	}
	return { attempts, decisions: reconcileDecisions(entries, records) };
}
