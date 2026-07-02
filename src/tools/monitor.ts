import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { runEventTail } from "./dispatch.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
import { truncateUtf8 } from "./truncate-utf8.js";

/**
 * The monitor tool: read-only visibility into dispatched runs. mode=list
 * enumerates known runs (this session first), status reports one run's state
 * and progress counters, peek returns the bounded tail of a run's recent
 * events buffered in this process, receipt returns the stored receipt.
 * Built strictly on the dispatch domain's ledger, live snapshot, and the
 * event stream the dispatch tool already consumes.
 */

const LIST_LIMIT = 20;
const PEEK_MAX_BYTES = 8 * 1024;
const RECEIPT_MAX_BYTES = 14 * 1024;

export interface MonitorToolDeps {
	dispatch: DispatchContract;
}

function runLine(run: RunEnvelope): string {
	const state = run.outcome ?? run.status;
	const receipt = run.receiptPath ?? "n/a";
	return `- ${run.id} agent=${run.agentId} state=${state} started=${run.startedAt} tokens=${run.tokenCount} receipt=${receipt}`;
}

function listRuns(deps: MonitorToolDeps, options: ToolInvokeOptions | undefined): ToolResult {
	let runs: ReadonlyArray<RunEnvelope>;
	try {
		runs = deps.dispatch.listRuns();
	} catch (err) {
		return { kind: "error", message: `monitor: ${err instanceof Error ? err.message : String(err)}` };
	}
	const sessionId = options?.sessionId ?? null;
	const sessionRuns = sessionId !== null ? runs.filter((run) => run.sessionId === sessionId) : [];
	const scoped = sessionRuns.length > 0 ? sessionRuns : runs;
	const scopeNote = sessionRuns.length > 0 ? "this session" : "all sessions";
	const shown = scoped.slice(0, LIST_LIMIT);
	if (shown.length === 0) {
		return { kind: "ok", output: "No dispatched runs recorded.", details: { mode: "list", runCount: 0 } };
	}
	const lines = [`dispatched runs (${scopeNote}, newest first, ${shown.length} of ${scoped.length}):`];
	for (const run of shown) lines.push(runLine(run));
	lines.push("", 'Use monitor(run_id=<id>) for state, mode="peek" for recent output, mode="receipt" for the receipt.');
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "list",
			runCount: scoped.length,
			runs: shown.map((run) => ({ runId: run.id, agentId: run.agentId, state: run.outcome ?? run.status })),
		},
	};
}

function runStatus(deps: MonitorToolDeps, runId: string): ToolResult {
	const run = deps.dispatch.getRun(runId);
	if (!run) return { kind: "error", message: `monitor: unknown run '${runId}'` };
	const live = deps.dispatch.snapshot().running.find((entry) => entry.runId === runId) ?? null;
	const lines = [
		`run ${run.id} (${run.agentId})`,
		`state: ${run.status}${run.outcome ? ` outcome=${run.outcome}` : ""}${run.outcomeDetail ? ` detail=${run.outcomeDetail}` : ""}`,
		`target=${run.targetId} model=${run.wireModelId} runtime=${run.runtimeKind}`,
		`started=${run.startedAt} ended=${run.endedAt ?? "n/a"} exit=${run.exitCode ?? "n/a"}`,
		`tokens=${run.tokenCount} cost=$${run.costUsd.toFixed(4)} receipt=${run.receiptPath ?? "n/a"}`,
	];
	if (live) {
		lines.push(
			`live: phase=${live.outcomePhase} heartbeat=${live.heartbeat} elapsed=${Math.round(live.elapsedMs / 1000)}s tokens=${live.tokens.total}`,
		);
	}
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "status",
			runId: run.id,
			agentId: run.agentId,
			status: run.status,
			outcome: run.outcome ?? null,
			exitCode: run.exitCode,
			tokenCount: run.tokenCount,
			costUsd: run.costUsd,
			receiptPath: run.receiptPath,
			running: live !== null,
		},
	};
}

function runPeek(deps: MonitorToolDeps, runId: string): ToolResult {
	const run = deps.dispatch.getRun(runId);
	const tail = runEventTail(runId);
	if (!tail || tail.entries.length === 0) {
		if (!run) return { kind: "error", message: `monitor: unknown run '${runId}'` };
		return {
			kind: "ok",
			output: `No buffered events for run ${runId} in this process. Use mode="receipt" for the stored receipt or mode="status" for run state.`,
			details: { mode: "peek", runId, eventCount: 0 },
		};
	}
	const rendered = tail.entries.map((entry) => `${entry.at} ${entry.type}${entry.detail ? `: ${entry.detail}` : ""}`);
	// Keep the newest events: trim from the front until the tail fits.
	let body = rendered.join("\n");
	let dropped = 0;
	while (Buffer.byteLength(body, "utf8") > PEEK_MAX_BYTES && dropped < rendered.length - 1) {
		dropped += 1;
		body = rendered.slice(dropped).join("\n");
	}
	const lines = [
		`recent events for run ${runId} (${tail.agentId}), newest last${dropped > 0 ? `, ${dropped} older omitted` : ""}:`,
		body,
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: { mode: "peek", runId, eventCount: tail.entries.length, omitted: dropped },
	};
}

function runReceipt(deps: MonitorToolDeps, runId: string): ToolResult {
	const run = deps.dispatch.getRun(runId);
	if (!run) return { kind: "error", message: `monitor: unknown run '${runId}'` };
	if (!run.receiptPath) {
		return {
			kind: "error",
			message: `monitor: run '${runId}' has no stored receipt (state=${run.outcome ?? run.status}); try mode="status" or mode="peek"`,
		};
	}
	let raw: string;
	try {
		raw = readFileSync(run.receiptPath, "utf8");
	} catch (err) {
		return {
			kind: "error",
			message: `monitor: cannot read receipt ${run.receiptPath}: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const body = truncateUtf8(raw, RECEIPT_MAX_BYTES, `\n[receipt truncated; read ${run.receiptPath} for the rest]`);
	return {
		kind: "ok",
		output: body,
		details: { mode: "receipt", runId, receiptPath: run.receiptPath },
	};
}

export function createMonitorTool(deps: MonitorToolDeps): ToolSpec {
	return {
		name: ToolNames.Monitor,
		description:
			"Inspect dispatched runs: mode=list enumerates known runs, status (default) reports one run's state, peek shows its recent output/events, receipt returns the stored receipt.",
		parameters: Type.Object({
			run_id: Type.Optional(Type.String({ description: "Run id from dispatch output; omit with mode=list." })),
			mode: Type.Optional(stringEnum(["status", "peek", "receipt", "list"], "What to return (default status).")),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
			const mode = typeof args.mode === "string" ? args.mode : runId.length > 0 ? "status" : "list";
			if (mode !== "status" && mode !== "peek" && mode !== "receipt" && mode !== "list") {
				return { kind: "error", message: `monitor: mode must be status, peek, receipt, or list; got '${mode}'` };
			}
			if (mode === "list") return listRuns(deps, options);
			if (runId.length === 0) return { kind: "error", message: `monitor: mode=${mode} requires run_id` };
			if (mode === "status") return runStatus(deps, runId);
			if (mode === "peek") return runPeek(deps, runId);
			return runReceipt(deps, runId);
		},
	};
}
