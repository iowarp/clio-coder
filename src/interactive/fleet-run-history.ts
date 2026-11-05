import { clioStateDir } from "../core/xdg.js";
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
function recordedUsage(runId: string): DispatchRunUsage {
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
		taskSummary: run.task,
		status,
		elapsedMs: Number.isFinite(endedAt - startedAt) ? Math.max(0, endedAt - startedAt) : 0,
		usage: recordedUsage(run.id),
		ttft: null,
		...(run.outcomeDetail ? { outcomeDetail: run.outcomeDetail } : {}),
		...(run.node !== undefined ? { node: run.node.id } : {}),
		...(facts?.trust !== undefined ? { trust: summarizeTrustStatus(facts.trust) } : {}),
		...(facts?.validationFailure !== undefined ? { validationFailure: facts.validationFailure } : {}),
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
 */
export function readDurableWorkerRuns(cwd: string, worktreeRoot?: string): DispatchBoardRow[] {
	const ownership = dispatchOwnership({ sessionId: null, cwd, ...(worktreeRoot !== undefined ? { worktreeRoot } : {}) });
	const settled = openLedger()
		.list()
		.filter((run) => run.endedAt !== null && SETTLED_STATUS[run.status] !== undefined)
		.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
	const rows: DispatchBoardRow[] = [];
	for (const run of settled) {
		if (rows.length >= DURABLE_RUN_LIMIT) break;
		// Helper and internal work is not the operator's fleet history.
		if (run.requestOrigin === "internal" || run.agentAudience === "internal" || run.agentAudience === "shadow") continue;
		if (!ownership.inProject(run.cwd)) continue;
		const status = SETTLED_STATUS[run.status];
		if (status === undefined) continue;
		try {
			rows.push(historyRow(run, status));
		} catch {
			// Written by another build; the listing goes on without it.
		}
	}
	return rows;
}
