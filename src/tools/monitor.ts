import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import { isTerminalRunEnvelope, type RunEnvelope, type RunReceipt } from "../domains/dispatch/types.js";
import { runEventTail } from "./dispatch.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
import { truncateUtf8 } from "./truncate-utf8.js";

/**
 * The monitor tool: read-only visibility into dispatched runs, plus the
 * gather half of detached dispatch. mode=list enumerates known runs (this
 * session first), status reports one run's state and progress counters, peek
 * returns the bounded tail of a run's recent events buffered in this process,
 * receipt returns the stored receipt, wait observes one run for a bounded
 * time until it is terminal or the timeout fires (it never cancels anything;
 * steer action=cancel stops a run), collect is the batch barrier: a pending
 * snapshot while runs are in flight, full results once every run is terminal.
 * Built strictly on the dispatch domain's ledger, live snapshot, durable
 * batch records, and integrity-verified receipts, so wait and collect work
 * across session resume.
 */

const LIST_LIMIT = 20;
const PEEK_MAX_BYTES = 8 * 1024;
const RECEIPT_MAX_BYTES = 14 * 1024;
const WAIT_POLL_MS = 250;
const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
const WAIT_MAX_TIMEOUT_MS = 10 * 60_000;
const COLLECT_TEXT_BYTES = 2_000;

export interface MonitorToolDeps {
	dispatch: DispatchContract;
}

function runLine(run: RunEnvelope): string {
	const state = run.outcome ?? run.status;
	const receipt = run.receiptPath ?? "n/a";
	return `- ${run.id} agent=${run.agentId} state=${state} node=${run.node?.id ?? "local"} started=${run.startedAt} tokens=${run.tokenCount} receipt=${receipt}`;
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
	const reroutes =
		run.reroutes !== undefined && run.reroutes.length > 0
			? ` reroutes=${run.reroutes.map((hop) => `${hop.fromNode}>${hop.toNode}`).join(",")}`
			: "";
	const lines = [
		`run ${run.id} (${run.agentId})`,
		`state: ${run.status}${run.outcome ? ` outcome=${run.outcome}` : ""}${run.outcomeDetail ? ` detail=${run.outcomeDetail}` : ""}`,
		`target=${run.targetId} model=${run.wireModelId} runtime=${run.runtimeKind} node=${run.node?.id ?? "local"}${reroutes}`,
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

/**
 * Verified durable output for a terminal run: read the sealed receipt, verify
 * its integrity against the ledger row, and return its bounded output block.
 * Same-process and resumed collection read the same artifact, so the answer
 * survives session exit; tampered or unverifiable receipts yield nothing
 * rather than unauthenticated text.
 */
function durableRunOutput(run: RunEnvelope): RunReceipt["output"] | null {
	if (!run.receiptPath) return null;
	try {
		const receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
		if (!verifyReceiptIntegrity(receipt, run).ok) return null;
		return receipt.output ?? null;
	} catch {
		return null;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Observe one run until it is terminal, the timeout fires, or the tool call
 * is aborted. Purely a bounded observation: the run is never cancelled or
 * otherwise affected (steer action=cancel stops a run). Elapsed time uses the
 * monotonic clock: a wall-clock step (NTP sync, VM resume) must not shrink or
 * inflate the timeout window.
 */
async function runWait(
	deps: MonitorToolDeps,
	runId: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<ToolResult> {
	const startedAt = performance.now();
	let run = deps.dispatch.getRun(runId);
	if (!run) return { kind: "error", message: `monitor: unknown run '${runId}'` };
	while (!isTerminalRunEnvelope(run)) {
		if (signal?.aborted) return { kind: "error", message: "monitor: wait aborted" };
		const elapsed = Math.round(performance.now() - startedAt);
		if (elapsed >= timeoutMs) {
			return {
				kind: "ok",
				output: `wait timed out after ${timeoutMs}ms: run ${runId} is still ${run.status} and keeps running. Wait again, collect later, or stop it with steer(action="cancel").`,
				details: { mode: "wait", runId, timedOut: true, state: run.status, waitedMs: elapsed },
			};
		}
		await sleep(Math.min(WAIT_POLL_MS, timeoutMs - elapsed));
		run = deps.dispatch.getRun(runId);
		if (!run) return { kind: "error", message: `monitor: run '${runId}' disappeared from the ledger while waiting` };
	}
	const status = runStatus(deps, runId);
	if (status.kind !== "ok") return status;
	const waitedMs = Math.round(performance.now() - startedAt);
	return {
		kind: "ok",
		output: `wait complete after ${waitedMs}ms:\n${status.output}`,
		details: { ...status.details, mode: "wait", timedOut: false, waitedMs },
	};
}

interface CollectRow {
	runId: string;
	agentId: string;
	run: RunEnvelope | null;
}

function collectRunLine(row: CollectRow): string[] {
	const run = row.run;
	if (!run) return [`- ${row.runId} agent=${row.agentId} state=missing (ledger row pruned; receipt may still exist)`];
	const state = run.outcome ?? run.status;
	const detail = run.outcomeDetail ? ` detail=${run.outcomeDetail}` : "";
	const lines = [
		`- ${run.id} agent=${run.agentId} state=${state} node=${run.node?.id ?? "local"} exit=${run.exitCode ?? "n/a"} tokens=${run.tokenCount} cost=$${run.costUsd.toFixed(4)} receipt=${run.receiptPath ?? "n/a"}${detail}`,
	];
	const output = durableRunOutput(run);
	if (output) {
		const capped = truncateUtf8(output.text, COLLECT_TEXT_BYTES, "...");
		const qualifier = output.state === "partial" ? " (partial; the run did not complete this message)" : "";
		const truncatedNote = output.truncated ? ` (stored output truncated; full text was ${output.bytes} bytes)` : "";
		lines.push(`  agent output${qualifier}${truncatedNote}:`, ...capped.split("\n").map((line) => `  ${line}`));
	}
	return lines;
}

/**
 * Batch barrier over a durable batch id or an explicit run-id list. Never
 * blocks: while any run is in flight it returns a pending snapshot; once all
 * are terminal it returns the full results and marks the batch collected so
 * completion nudges stop. A ledger row pruned from the bounded ring counts as
 * terminal (it can never complete) and is reported as missing.
 */
async function runCollect(deps: MonitorToolDeps, batchId: string, runIds: ReadonlyArray<string>): Promise<ToolResult> {
	let rows: CollectRow[];
	let scope: string;
	if (batchId.length > 0) {
		const detached = deps.dispatch.detached;
		if (!detached) return { kind: "error", message: "monitor: no detached batch records are available in this context" };
		const record = detached.get(batchId);
		if (!record) return { kind: "error", message: `monitor: unknown batch '${batchId}'` };
		rows = record.runs.map((run) => ({ runId: run.runId, agentId: run.agentId, run: deps.dispatch.getRun(run.runId) }));
		scope = `batch ${batchId}${record.collectedAt !== null ? " (already collected)" : ""}`;
	} else {
		rows = runIds.map((runId) => {
			const run = deps.dispatch.getRun(runId);
			return { runId, agentId: run?.agentId ?? "unknown", run };
		});
		scope = `${rows.length} run(s)`;
	}
	const pending = rows.filter((row) => row.run !== null && !isTerminalRunEnvelope(row.run));
	if (pending.length > 0) {
		const lines = [
			`collect pending: ${pending.length} of ${rows.length} run(s) still in flight for ${scope}`,
			...rows.map((row) => {
				const state = row.run === null ? "missing" : (row.run.outcome ?? row.run.status);
				return `- ${row.runId} agent=${row.agentId} state=${state}`;
			}),
			"",
			'Collect again later, or block on a single run with mode="wait".',
		];
		return {
			kind: "ok",
			output: lines.join("\n"),
			details: {
				mode: "collect",
				...(batchId.length > 0 ? { batchId } : {}),
				complete: false,
				pendingCount: pending.length,
				runCount: rows.length,
				pendingRunIds: pending.map((row) => row.runId),
			},
		};
	}
	const failed = rows.filter(
		(row) =>
			row.run === null ||
			row.run.exitCode !== 0 ||
			(row.run.outcome !== undefined && row.run.outcome !== "succeeded" && row.run.outcome !== null),
	);
	const missing = rows.filter((row) => row.run === null);
	// The batch is only reported collected when the durable mark actually
	// persisted; on failure it stays open for a later collect and the result
	// says so instead of pretending.
	let collected = false;
	if (batchId.length > 0) {
		try {
			const marked = await deps.dispatch.detached?.markCollected(batchId);
			collected = marked !== null && marked !== undefined;
		} catch {
			collected = false;
		}
	}
	const lines = [
		`collect complete for ${scope}: total=${rows.length} failed=${failed.length}${missing.length > 0 ? ` missing=${missing.length}` : ""}`,
		...rows.flatMap((row) => collectRunLine(row)),
		...(batchId.length > 0 && !collected
			? ["", "note: the batch record could not be marked collected; it stays open for a later collect."]
			: []),
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "collect",
			...(batchId.length > 0 ? { batchId, collected } : {}),
			complete: true,
			runCount: rows.length,
			failedCount: failed.length,
			runs: rows.map((row) => {
				const output = row.run !== null ? durableRunOutput(row.run) : null;
				return {
					runId: row.runId,
					agentId: row.agentId,
					state: row.run === null ? "missing" : (row.run.outcome ?? row.run.status),
					exitCode: row.run?.exitCode ?? null,
					receiptPath: row.run?.receiptPath ?? null,
					...(output ? { output: { state: output.state, bytes: output.bytes, truncated: output.truncated } } : {}),
				};
			}),
		},
	};
}

export function createMonitorTool(deps: MonitorToolDeps): ToolSpec {
	return {
		name: ToolNames.Monitor,
		description:
			"Inspect dispatched runs: mode=list enumerates known runs, status (default) reports one run's state, peek shows its recent output/events, receipt returns the stored receipt, wait observes one run for a bounded time until it finishes or timeout_ms elapses (it never cancels the run; use steer action=cancel to stop one), collect gathers a detached batch (batch_id) or run-id list: a pending snapshot while runs are in flight, full results once all are done.",
		parameters: Type.Object({
			run_id: Type.Optional(Type.String({ description: "Run id from dispatch output; omit with mode=list." })),
			mode: Type.Optional(
				stringEnum(["status", "peek", "receipt", "list", "wait", "collect"], "What to return (default status)."),
			),
			batch_id: Type.Optional(Type.String({ description: "Detached batch id from dispatch detach:true (mode=collect)." })),
			run_ids: Type.Optional(
				Type.Array(Type.String(), { description: "Explicit run ids to collect instead of a batch id (mode=collect)." }),
			),
			timeout_ms: Type.Optional(
				Type.Number({ description: "mode=wait: max ms to block (default 60000, capped at 600000)." }),
			),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
		async run(args, options): Promise<ToolResult> {
			const runId = typeof args.run_id === "string" ? args.run_id.trim() : "";
			const mode = typeof args.mode === "string" ? args.mode : runId.length > 0 ? "status" : "list";
			if (
				mode !== "status" &&
				mode !== "peek" &&
				mode !== "receipt" &&
				mode !== "list" &&
				mode !== "wait" &&
				mode !== "collect"
			) {
				return {
					kind: "error",
					message: `monitor: mode must be status, peek, receipt, list, wait, or collect; got '${mode}'`,
				};
			}
			if (mode === "list") return listRuns(deps, options);
			if (mode === "collect") {
				const batchId = typeof args.batch_id === "string" ? args.batch_id.trim() : "";
				const runIds = Array.isArray(args.run_ids)
					? args.run_ids.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
					: [];
				if (batchId.length === 0 && runIds.length === 0) {
					return { kind: "error", message: "monitor: mode=collect requires batch_id or a non-empty run_ids array" };
				}
				return runCollect(deps, batchId, runIds);
			}
			if (runId.length === 0) return { kind: "error", message: `monitor: mode=${mode} requires run_id` };
			if (mode === "wait") {
				const rawTimeout = typeof args.timeout_ms === "number" && Number.isFinite(args.timeout_ms) ? args.timeout_ms : NaN;
				const timeoutMs =
					Number.isFinite(rawTimeout) && rawTimeout > 0
						? Math.min(Math.floor(rawTimeout), WAIT_MAX_TIMEOUT_MS)
						: WAIT_DEFAULT_TIMEOUT_MS;
				return runWait(deps, runId, timeoutMs, options?.signal);
			}
			if (mode === "status") return runStatus(deps, runId);
			if (mode === "peek") return runPeek(deps, runId);
			return runReceipt(deps, runId);
		},
	};
}
