/**
 * Worker-side agent-ledger mirror and port.
 *
 * The mirror is the worker's whole view of the board. The orchestrator pushes
 * `ledger_delta` frames down stdin and the mirror dedupes them by sequence, so
 * a read answers locally with an explicit watermark instead of blocking a tool
 * call on a round trip. A read is slightly stale and says so.
 *
 * The control lane is one-way, so a post cannot learn the orchestrator's
 * verdict. The port therefore enforces the body bounds and the per-run post cap
 * locally to give the model a synchronous typed refusal, while the orchestrator
 * enforces the same rules authoritatively at append. Only what the orchestrator
 * admitted is what a receipt counts.
 */

import {
	type AgentLedgerBody,
	type AgentLedgerEntry,
	type AgentLedgerPort,
	parseAgentLedgerBody,
	type WorkerControlFrame,
} from "./protocol.js";

/** Mirrors the orchestrator's per-run cap so a refusal is synchronous. */
export const WORKER_AGENT_LEDGER_POST_CAP = 20;

/**
 * Refusal tokens shared with the orchestrator's append path, so a worker-local
 * refusal and the authoritative one a receipt counts read the same.
 */
export type WorkerAgentLedgerRefusal = "invalid-body" | "per-run-cap" | "no-ledger";

export interface WorkerAgentLedgerMirror {
	/** Merge one pushed batch, deduping by sequence. */
	apply(entries: ReadonlyArray<AgentLedgerEntry>): void;
	entries(): ReadonlyArray<AgentLedgerEntry>;
	/** Highest sequence this mirror has seen. */
	watermark(): number;
}

export function createWorkerAgentLedgerMirror(): WorkerAgentLedgerMirror {
	const bySequence = new Map<number, AgentLedgerEntry>();
	let watermark = 0;
	return {
		apply(entries: ReadonlyArray<AgentLedgerEntry>): void {
			for (const entry of entries) {
				bySequence.set(entry.sequence, entry);
				if (entry.sequence > watermark) watermark = entry.sequence;
			}
		},
		entries(): ReadonlyArray<AgentLedgerEntry> {
			return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
		},
		watermark(): number {
			return watermark;
		},
	};
}

export interface WorkerAgentLedgerPortDeps {
	/** The spec's ledger field. Absent when this run has no ledger at all. */
	ledger?: { id: string; sequence: number };
	emitControlFrame: (frame: WorkerControlFrame) => void;
	/** Defaults to a private mirror; injectable so a caller can feed it deltas. */
	mirror?: WorkerAgentLedgerMirror;
}

/** The shared port plus the stdin-side entry point that feeds the mirror. */
export interface WorkerAgentLedgerPort extends AgentLedgerPort {
	acceptDelta(entries: ReadonlyArray<AgentLedgerEntry>): void;
}

export function createWorkerAgentLedgerPort(deps: WorkerAgentLedgerPortDeps): WorkerAgentLedgerPort {
	const mirror = deps.mirror ?? createWorkerAgentLedgerMirror();
	const { ledger, emitControlFrame } = deps;
	let posted = 0;
	return {
		post(body: AgentLedgerBody): { ok: true } | { ok: false; reason: WorkerAgentLedgerRefusal } {
			if (ledger === undefined) return { ok: false, reason: "no-ledger" };
			const parsed = parseAgentLedgerBody(body);
			if (!parsed.ok) return { ok: false, reason: "invalid-body" };
			if (posted >= WORKER_AGENT_LEDGER_POST_CAP) return { ok: false, reason: "per-run-cap" };
			posted += 1;
			emitControlFrame({ kind: "ledger_post", body: parsed.body });
			return { ok: true };
		},
		read(): { open: boolean; watermark: number; entries: ReadonlyArray<AgentLedgerEntry> } | null {
			if (ledger === undefined) return null;
			return { open: true, watermark: mirror.watermark(), entries: mirror.entries() };
		},
		acceptDelta(entries: ReadonlyArray<AgentLedgerEntry>): void {
			mirror.apply(entries);
		},
	};
}
