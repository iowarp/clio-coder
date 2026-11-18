import { clioStateDir } from "../core/xdg.js";
import { fleetNodeTaskBrief } from "../domains/dispatch/fleet-node-prompt.js";
import { dispatchOwnership } from "../domains/dispatch/ownership.js";
import { openLedger } from "../domains/dispatch/state.js";
import type { RunEnvelope, RunStatus } from "../domains/dispatch/types.js";
import { summarizeTrustStatus } from "../domains/evidence/trust-projection.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { readRunRecord } from "../domains/telemetry/index.js";
import { readWorkerRunResultFacts } from "../session-control/worker-run-results.js";
import type { DispatchBoardRow, DispatchBoardStatus, DispatchRunUsage } from "./dispatch-board.js";
import { presentSettledWorkerAnswer } from "./renderers/worker-answer.js";

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

/** The run's whole recorded answer in its Fleet Runs card's words, or null when the record does not admit them. */
export function recordedRunAnswerLines(runId: string, text: string, stateDir = clioStateDir()): string[] | null {
	const facts = readWorkerRunResultFacts(runId, stateDir);
	const contract =
		facts?.contractKind !== undefined && facts.contract !== undefined
			? { kind: facts.contractKind, conformance: facts.contract }
			: undefined;
	const verified = facts?.trust?.artifactIntegrity.state === "verified";
	const presented = presentSettledWorkerAnswer(text, contract, verified, true);
	return presented && [...(presented.footer ? [presented.footer] : []), ...presented.lines].map(sanitizeCallTargetText);
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
 * Each row lands in `rows` as it is read, so a reader sees the newest runs before the rest arrive.
 */
function* durableWorkerRunRows(
	cwd: string,
	worktreeRoot: string | undefined,
	rows: DispatchBoardRow[],
): Generator<void, void> {
	const ownership = dispatchOwnership({ sessionId: null, cwd, ...(worktreeRoot !== undefined ? { worktreeRoot } : {}) });
	const settled = openLedger()
		.list()
		.filter((run) => run.endedAt !== null && SETTLED_STATUS[run.status] !== undefined)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
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
}

/** What the board's history holds so far; `complete` once the last run is read. */
export interface DurableWorkerRunsRead {
	rows: ReadonlyArray<DispatchBoardRow>;
	complete: boolean;
}

/** A loop turn with an input poll in it (see stage1-preload's nextTurn) that never keeps the process alive. */
async function idleTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve).unref());
	await new Promise<void>((resolve) => setImmediate(resolve).unref());
}

/** The history load in flight or finished, taken once by the read that sees it complete. */
let loading: { cwd: string; worktreeRoot: string | undefined; rows: DispatchBoardRow[]; complete: boolean } | null =
	null;

/**
 * The durable worker rows for a board, never read on the caller's turn: the first read starts a load that reads a
 * run per loop turn and returns nothing yet, so a prompt submitted at launch never waits for the history. Later reads
 * show the rows loaded so far; `onArrive` fires once the last one is in. An unreadable ledger loads no rows.
 */
export function readDurableWorkerRuns(
	cwd: string,
	worktreeRoot?: string,
	onArrive?: () => void,
	nextTurn: () => Promise<void> = idleTurn,
): DurableWorkerRunsRead {
	const current = loading;
	if (current !== null && current.cwd === cwd && current.worktreeRoot === worktreeRoot) {
		if (current.complete) loading = null;
		return { rows: current.rows, complete: current.complete };
	}
	const load = { cwd, worktreeRoot, rows: [] as DispatchBoardRow[], complete: false };
	loading = load;
	void (async () => {
		try {
			const steps = durableWorkerRunRows(cwd, worktreeRoot, load.rows);
			for (;;) {
				await nextTurn();
				// A newer read for another project abandons this load.
				if (loading !== load) return;
				if (steps.next().done) break;
			}
		} catch {
			// An unreadable ledger costs the rest of the history, never the board.
		}
		load.complete = true;
		onArrive?.();
	})();
	return { rows: load.rows, complete: false };
}
