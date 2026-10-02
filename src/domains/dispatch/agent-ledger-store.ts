/**
 * Durable agent-ledger records.
 *
 * The agent ledger is the bounded coordination surface concurrent dispatch
 * workers share while they run. The orchestrator is its sole writer: workers
 * post over the control lane and receive the board over stdin, so nothing here
 * is ever written by a worker process.
 *
 * Records persist as `agent-ledgers.json` under `clioStateDir()`, modeled on
 * batch-store.ts. Writes go through the shared state-file lock, which is sound
 * here because every writer is an orchestrator process on the local host and
 * the lock adjudicates liveness against the local process table. Reads are
 * lock-free snapshots.
 *
 * This is the agent ledger, not the run ledger. `openLedger` in state.ts owns
 * `runs.json` and is a different thing; the two never share a symbol or a
 * sentence.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowRestrictionSet } from "../../core/flow-restrictions.js";
import { isFlowRestrictionSet } from "../../core/flow-restrictions.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import { clioStateDir } from "../../core/xdg.js";
import type { AgentLedgerEntry } from "../../worker/protocol.js";
import { parseAgentLedgerBody, parseAgentLedgerEntry } from "../../worker/protocol.js";
import type { RenderAgentLedgerOptions } from "./agent-ledger.js";
import { AGENT_LEDGER_PROMPT_MAX_CHARS, claimConflicts, renderAgentLedger } from "./agent-ledger.js";

/** Bounded ring: newest first, oldest dropped past this count. */
const MAX_AGENT_LEDGER_RECORDS = 50;
/** Entries one ledger may hold before further appends are refused. */
export const MAX_AGENT_LEDGER_ENTRIES = 200;
/**
 * Posts one run may land on one ledger. The cap is what makes a post cost
 * something, which is the whole reason a post carries signal. Not configurable.
 */
export const MAX_AGENT_LEDGER_POSTS_PER_RUN = 20;

export interface AgentLedgerRunContribution {
	posted: number;
	refused: number;
}

export interface AgentLedgerRecord {
	id: string;
	openedAt: string;
	closedAt: string | null;
	sequence: number;
	entries: AgentLedgerEntry[];
	perRun: Record<string, AgentLedgerRunContribution>;
}

interface AgentLedgerStoreFile {
	version: 1;
	ledgers: AgentLedgerRecord[];
}

/** Attribution the orchestrator stamps from its own admission record. */
export interface AgentLedgerAttribution {
	runId: string;
	assignmentId: string;
	agentId: string;
	nodeId: string;
	flowRestrictions?: FlowRestrictionSet;
}

export type AgentLedgerAppendRefusal = "invalid-body" | "per-run-cap" | "ledger-closed" | "ledger-full";

export type AgentLedgerAppendResult =
	| { ok: true; entry: AgentLedgerEntry }
	| { ok: false; refusal: AgentLedgerAppendRefusal; reason: string };

function storePath(): string {
	return join(clioStateDir(), "agent-ledgers.json");
}

function readStore(): AgentLedgerRecord[] {
	const path = storePath();
	if (!existsSync(path)) return [];
	const parsed = JSON.parse(readFileSync(path, "utf8")) as AgentLedgerStoreFile;
	if (parsed?.version !== 1 || !Array.isArray(parsed.ledgers)) throw new Error("invalid agent ledger store");
	for (const record of parsed.ledgers) {
		if (
			!record ||
			typeof record.id !== "string" ||
			!Array.isArray(record.entries) ||
			record.entries.length > MAX_AGENT_LEDGER_ENTRIES ||
			!Number.isSafeInteger(record.sequence) ||
			!record.perRun ||
			typeof record.perRun !== "object" ||
			!(record.closedAt === null || typeof record.closedAt === "string")
		) {
			throw new Error("invalid agent ledger record");
		}
		let previous = 0;
		for (const entry of record.entries) {
			if (parseAgentLedgerEntry(entry) === null || entry.sequence <= previous || entry.sequence > record.sequence) {
				throw new Error("invalid agent ledger entry");
			}
			previous = entry.sequence;
		}
	}
	return parsed.ledgers;
}

function writeStore(ledgers: ReadonlyArray<AgentLedgerRecord>): void {
	const active = ledgers.filter((ledger) => ledger.closedAt === null);
	const closed = ledgers.filter((ledger) => ledger.closedAt !== null);
	const file: AgentLedgerStoreFile = {
		version: 1,
		ledgers: [...active, ...closed.slice(0, Math.max(0, MAX_AGENT_LEDGER_RECORDS - active.length))],
	};
	safeResourceWrite(storePath(), JSON.stringify(file), { mode: 0o600 });
}

const pendingWrites = new Map<string, Promise<unknown>>();

function orderedWrite<T>(write: () => T): Promise<T> {
	const path = storePath();
	const previous = pendingWrites.get(path) ?? Promise.resolve();
	const next = previous
		.catch(() => {
			// A failed mutation must not poison subsequent admissions.
		})
		.then(() => withStateFileLock(path, write));
	pendingWrites.set(path, next);
	void next
		.finally(() => {
			if (pendingWrites.get(path) === next) pendingWrites.delete(path);
		})
		.catch(() => {
			// The caller owns the original rejection; cleanup cannot create another.
		});
	return next;
}

function contributionFor(record: AgentLedgerRecord, runId: string): AgentLedgerRunContribution {
	return record.perRun[runId] ?? { posted: 0, refused: 0 };
}

/** Open one ledger for one multi-worker dispatch unit. Idempotent by id. */
export async function openAgentLedger(id: string): Promise<AgentLedgerRecord> {
	let opened: AgentLedgerRecord | null = null;
	await orderedWrite(() => {
		const ledgers = readStore();
		const existing = ledgers.find((ledger) => ledger.id === id);
		if (existing !== undefined) {
			opened = existing;
			return;
		}
		if (ledgers.filter((ledger) => ledger.closedAt === null).length >= MAX_AGENT_LEDGER_RECORDS) {
			throw new Error("too many active agent ledgers; close a dispatch before opening another");
		}
		const record: AgentLedgerRecord = {
			id,
			openedAt: new Date().toISOString(),
			closedAt: null,
			sequence: 0,
			entries: [],
			perRun: {},
		};
		opened = record;
		writeStore([record, ...ledgers]);
	});
	if (opened === null) throw new Error(`agent ledger ${id} could not be opened`);
	return opened;
}

/** Lock-free snapshot. Returns null when no ledger carries this id. */
export function readAgentLedger(id: string): AgentLedgerRecord | null {
	return readStore().find((ledger) => ledger.id === id) ?? null;
}

/**
 * The board as one bounded section, headed by its size and watermark, for a
 * result the main model reads. Attribution, corroboration, and dispute marks
 * are exactly what the workers saw; nothing is counted, scored, or merged.
 *
 * Null when the board is absent or empty, so a result with nothing to add is
 * byte-identical to one that never had a ledger. A closed ledger keeps its
 * entries, so a late read still renders.
 */
export function renderAgentLedgerBoard(
	id: string,
	projection: Omit<RenderAgentLedgerOptions, "maxChars"> = {},
): string | null {
	const record = readAgentLedger(id);
	if (
		record === null ||
		(record.entries.length === 0 &&
			(projection.assignments?.length ?? 0) === 0 &&
			(projection.receiptFindings?.length ?? 0) === 0)
	)
		return null;
	const count = record.entries.length;
	const head = `agent ledger (${count} ${count === 1 ? "entry" : "entries"}, sequence ${record.sequence})`;
	return `${head}\n${renderAgentLedger(record.entries, { ...projection, maxChars: AGENT_LEDGER_PROMPT_MAX_CHARS })}`;
}

/**
 * Append one worker post under the orchestrator's own attribution. This is the
 * authoritative admission: the worker enforces the same bounds locally so a
 * model gets a synchronous refusal, but only what lands here is counted.
 */
export async function appendAgentLedgerEntry(
	id: string,
	attribution: AgentLedgerAttribution,
	body: unknown,
): Promise<AgentLedgerAppendResult> {
	let result: AgentLedgerAppendResult | null = null;
	await orderedWrite(() => {
		const ledgers = readStore();
		const index = ledgers.findIndex((ledger) => ledger.id === id);
		const record = index === -1 ? undefined : ledgers[index];
		if (record === undefined) {
			result = { ok: false, refusal: "ledger-closed", reason: `agent ledger ${id} does not exist` };
			return;
		}

		const refuse = (refusal: AgentLedgerAppendRefusal, reason: string): void => {
			const current = contributionFor(record, attribution.runId);
			record.perRun[attribution.runId] = { posted: current.posted, refused: current.refused + 1 };
			ledgers[index] = record;
			writeStore(ledgers);
			result = { ok: false, refusal, reason };
		};

		if (record.closedAt !== null) {
			refuse("ledger-closed", `agent ledger ${id} is closed`);
			return;
		}
		const parsed = parseAgentLedgerBody(body);
		if (!parsed.ok) {
			refuse("invalid-body", parsed.reason);
			return;
		}
		if (record.entries.length >= MAX_AGENT_LEDGER_ENTRIES) {
			refuse("ledger-full", `agent ledger ${id} holds its maximum of ${MAX_AGENT_LEDGER_ENTRIES} entries`);
			return;
		}
		const current = contributionFor(record, attribution.runId);
		if (current.posted >= MAX_AGENT_LEDGER_POSTS_PER_RUN) {
			refuse("per-run-cap", `this run has used all ${MAX_AGENT_LEDGER_POSTS_PER_RUN} of its ledger posts`);
			return;
		}

		const target =
			parsed.body.kind === "review"
				? parsed.body.target
				: parsed.body.kind === "message"
					? parsed.body.replyTo
					: undefined;
		if (target !== undefined && !record.entries.some((entry) => entry.id === target)) {
			refuse("invalid-body", `entry ${target} does not exist on this board`);
			return;
		}
		if (
			attribution.flowRestrictions !== undefined &&
			(!isFlowRestrictionSet(attribution.flowRestrictions) ||
				Buffer.byteLength(JSON.stringify(attribution.flowRestrictions), "utf8") > 12000)
		) {
			refuse("invalid-body", "ledger flow restrictions are invalid or exceed 12000 bytes");
			return;
		}
		const sequence = record.sequence + 1;
		const conflicts = claimConflicts(parsed.body, record.entries, attribution.runId);
		// Attribution is stamped here and nowhere else. The worker supplies the
		// body and nothing else, so no worker-supplied value can reach a field
		// a peer or a receipt reads as identity.
		const entry: AgentLedgerEntry = {
			id: `e${sequence}`,
			sequence,
			at: new Date().toISOString(),
			runId: attribution.runId,
			assignmentId: attribution.assignmentId,
			agentId: attribution.agentId,
			nodeId: attribution.nodeId,
			body: parsed.body,
			...(attribution.flowRestrictions ? { flowRestrictions: structuredClone(attribution.flowRestrictions) } : {}),
			...(conflicts.length > 0 ? { conflictsWith: [...conflicts] } : {}),
		};
		record.sequence = sequence;
		record.entries.push(entry);
		record.perRun[attribution.runId] = { posted: current.posted + 1, refused: current.refused };
		ledgers[index] = record;
		writeStore(ledgers);
		result = { ok: true, entry };
	});
	if (result === null) {
		return { ok: false, refusal: "ledger-closed", reason: `agent ledger ${id} could not be reached` };
	}
	return result;
}

/** Close one ledger. Idempotent: an already-closed ledger keeps its close time. */
export async function closeAgentLedger(id: string): Promise<AgentLedgerRecord | null> {
	let closed: AgentLedgerRecord | null = null;
	await orderedWrite(() => {
		const ledgers = readStore();
		const index = ledgers.findIndex((ledger) => ledger.id === id);
		const current = index === -1 ? undefined : ledgers[index];
		if (current === undefined) return;
		closed = current.closedAt === null ? { ...current, closedAt: new Date().toISOString() } : current;
		ledgers[index] = closed;
		writeStore(ledgers);
	});
	return closed;
}
