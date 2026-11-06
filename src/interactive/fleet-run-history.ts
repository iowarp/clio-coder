import { clioStateDir } from "../core/xdg.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import { dispatchOwnership } from "../domains/dispatch/ownership.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunStatus } from "../domains/dispatch/types.js";
import { summarizeTrustStatus } from "../domains/evidence/trust-projection.js";
import { readRunRecord } from "../domains/telemetry/index.js";
import { readWorkerRunResultFacts } from "../session-control/worker-run-results.js";
import type { DispatchBoardRow, DispatchBoardStatus, DispatchRunUsage } from "./dispatch-board.js";

/** Worker runs a restarted board shows. The ledger holds every run the machine kept. */
const DURABLE_RUN_LIMIT = 12;

const SETTLED_STATUS: Partial<Record<RunStatus, DispatchBoardStatus>> = {
	completed: "completed",
	failed: "failed",
	interrupted: "aborted",
	dead: "dead",
};

/** The run's usage as its own journal folds it, the same quantities a live row reads from the session view. */
export function recordedRunUsage(runId: string): DispatchRunUsage {
	try {
		const record = readRunRecord(clioStateDir(), runId);
		if (record === null) return { kind: "unavailable" };
		return {
			kind: "ready",
			prompt: record.tokens.prompt,
			output: record.tokens.output,
			total: record.row.tokens,
			usd: record.row.usd,
		};
	} catch {
		// An unreadable journal leaves the usage unknown, never the row.
		return { kind: "unavailable" };
	}
}

function historyRow(run: RunEnvelope, status: DispatchBoardStatus): DispatchBoardRow {
	const startedAt = Date.parse(run.startedAt);
	const endedAt = Date.parse(run.endedAt ?? run.startedAt);
	const facts = readWorkerRunResultFacts(run.id);
	const contract =
		facts?.contractKind !== undefined && facts.contract !== undefined
			? { resultContract: { kind: facts.contractKind, conformance: facts.contract } }
			: {};
	return {
		runId: run.id,
		agentId: run.agentId,
		...(run.agentAudience !== undefined ? { agentAudience: run.agentAudience } : {}),
		...(run.requestOrigin !== undefined ? { requestOrigin: run.rootRequestOrigin ?? run.requestOrigin } : {}),
		runtimeKind: run.runtimeKind,
		runtimeId: run.runtimeId,
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		taskSummary: fleetNodeTaskBrief(run.task),
		status,
		elapsedMs: Number.isFinite(endedAt - startedAt) ? Math.max(0, endedAt - startedAt) : 0,
		...(Number.isFinite(endedAt) ? { settledAtMs: endedAt } : {}),
		usage: recordedRunUsage(run.id),
		ttft: null,
		...(run.outcomeDetail ? { outcomeDetail: run.outcomeDetail } : {}),
		...(run.node !== undefined ? { node: run.node.id } : {}),
		// A council's runs fold into one group on a restarted board too, rather than reading as stray researchers.
		...(run.council !== undefined ? { council: { ...run.council } } : {}),
		...(facts?.trust !== undefined ? { trust: summarizeTrustStatus(facts.trust) } : {}),
		...(facts?.validationFailure !== undefined ? { validationFailure: facts.validationFailure } : {}),
		...(facts !== null
			? {
					completion: {
						...(facts.toolCalls !== undefined ? { toolCalls: facts.toolCalls } : {}),
						...(facts.refusedCalls !== undefined ? { refusedCalls: facts.refusedCalls } : {}),
						...(facts.guardedCalls !== undefined ? { guardedCalls: facts.guardedCalls } : {}),
						...(facts.contract !== undefined ? { contract: facts.contract } : {}),
					},
				}
			: {}),
		...contract,
		lastContextTokens: null,
		runRecordId: run.id,
		currentTool: null,
		recentTools: [],
		earlier: true,
	};
}

/**
 * This project's newest settled worker runs, for a board whose process never saw them (J2-F16). The telemetry
 * projection behind the board folds only this process's bus, so after a restart the workers vanished while the plans,
 * read from their durable roots, stayed. A malformed row costs itself, never the board.
 *
 * Yields once per run read, each a journal read that can take 10 ms or more, so a caller may turn the loop between them.
 */
function* durableWorkerRunRows(cwd: string, worktreeRoot: string | undefined): Generator<void, DispatchBoardRow[]> {
	const ownership = dispatchOwnership({ sessionId: null, cwd, ...(worktreeRoot !== undefined ? { worktreeRoot } : {}) });
	const settled = openLedger()
		.list()
		.filter((run) => run.endedAt !== null && SETTLED_STATUS[run.status] !== undefined)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	const rows: DispatchBoardRow[] = [];
	for (const run of settled) {
		if (rows.length >= DURABLE_RUN_LIMIT) break;
		// Helper and internal work is not the operator's fleet history.
		// A council member runs in the shadow audience but answers the operator's own /council question, so it stays.
		if (
			run.council === undefined &&
			(run.requestOrigin === "internal" || run.agentAudience === "internal" || run.agentAudience === "shadow")
		)
			continue;
		if (!ownership.inProject(run.cwd)) continue;
		const status = SETTLED_STATUS[run.status];
		if (status === undefined) continue;
		yield;
		try {
			rows.push(historyRow(run, status));
		} catch {
			// Written by another build; the listing goes on without it.
		}
	}
	return rows;
}

/** Rows read ahead of the interactive build, taken once by the read they were primed for. */
let primedRuns: { cwd: string; worktreeRoot: string | undefined; rows: DispatchBoardRow[] } | null = null;

/**
 * Read the durable worker rows while the Stage 0 shell takes keys, a loop turn between runs, so the board's first
 * read during the interactive build finds them instead of reading every run's journal in one block. A stop through
 * `signal` leaves nothing primed and the board reads as before.
 */
export async function primeDurableWorkerRuns(
	cwd: string,
	worktreeRoot: string | undefined,
	nextTurn: () => Promise<void>,
	signal?: AbortSignal,
): Promise<void> {
	primedRuns = null;
	try {
		const steps = durableWorkerRunRows(cwd, worktreeRoot);
		for (let step = steps.next(); ; step = steps.next()) {
			if (step.done) {
				primedRuns = { cwd, worktreeRoot, rows: step.value };
				return;
			}
			await nextTurn();
			if (signal?.aborted) return;
		}
	} catch {
		// An unreadable ledger primes nothing; the board's own read handles it.
	}
}

export function readDurableWorkerRuns(cwd: string, worktreeRoot?: string): DispatchBoardRow[] {
	const primed = primedRuns;
	primedRuns = null;
	if (primed !== null && primed.cwd === cwd && primed.worktreeRoot === worktreeRoot) return primed.rows;
	const steps = durableWorkerRunRows(cwd, worktreeRoot);
	for (;;) {
		const step = steps.next();
		if (step.done) return step.value;
	}
}
