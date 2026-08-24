import { readFileSync } from "node:fs";
import { sleep } from "../core/timers.js";
import { renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
import type { DurableAssignmentRecord } from "../domains/dispatch/assignment-store.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
} from "../domains/dispatch/budget-envelope.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { UNVERIFIABLE_RECEIPT_VERIFICATION } from "../domains/dispatch/receipt-findings.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import {
	isTerminalRunEnvelope,
	type RunEnvelope,
	type RunReceipt,
	type RunReceiptVerification,
} from "../domains/dispatch/types.js";
import {
	adaptRunReceiptTrustStatus,
	type CanonicalTrustStatus,
	inspectRunReceiptTrustStatus,
} from "../domains/evidence/trust-status.js";
import { COST_NOT_MEASURED, costAggregateForAmount, formatCostAggregate } from "../domains/observability/index.js";
import type { DispatchRunEventRegistry } from "./dispatch.js";
import { monitorToolSurface } from "./monitor-surface.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import { receiptEvidenceLabels, workerTextLabel, workerTextNonEvidenceNotices } from "./worker-evidence.js";

/**
 * The monitor tool: read-only visibility into known synchronous and detached
 * dispatched runs. The interactive operator/TUI can inspect an active sync
 * run through the dispatch contract; parent-model mid-run observation requires
 * detach because a sequential synchronous dispatch call auto-waits. mode=list
 * enumerates known runs (this
 * session first), status reports one run's state and progress counters, peek
 * returns the bounded tail of a run's recent events buffered in this process,
 * tools answers what a run executed (its tool calls with outcomes, plus the
 * receipt's per-tool totals),
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
const COLLECT_TIMEOUT_NOTICE = 'collect never blocks; timeout_ms is ignored — block on one run with mode="wait".';

export interface MonitorToolDeps {
	dispatch: DispatchContract;
	runEvents?: Pick<DispatchRunEventRegistry, "eventTail">;
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
	const requestedRun = deps.dispatch.getRun(runId);
	const rootRunId = requestedRun?.lineage?.rootRunId ?? runId;
	const assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
	const resolvedRunId = assignment?.terminalRunId ?? runId;
	const run = deps.dispatch.getRun(resolvedRunId) ?? requestedRun;
	if (!run && !assignment) return { kind: "error", message: `monitor: unknown run or assignment '${runId}'` };
	if (!run) return { kind: "error", message: `monitor: assignment '${runId}' has no available attempt` };
	const live = deps.dispatch.snapshot().running.find((entry) => entry.lineage.rootRunId === rootRunId) ?? null;
	const reroutes =
		run.reroutes !== undefined && run.reroutes.length > 0
			? ` reroutes=${run.reroutes.map((hop) => `${hop.fromNode}>${hop.toNode}`).join(",")}`
			: "";
	const lines = [
		...(assignment
			? [
					`assignment ${assignment.assignmentId} status=${assignment.status} terminal=${assignment.terminalRunId ?? "pending"}`,
					`attempts: ${assignment.attempts.join(", ") || "none finalized"}`,
				]
			: []),
		`run ${run.id} (${run.agentId})`,
		`state: ${run.status}${run.outcome ? ` outcome=${run.outcome}` : ""}${run.outcomeDetail ? ` detail=${run.outcomeDetail}` : ""}`,
		`target=${run.targetId} model=${run.wireModelId} runtime=${run.runtimeKind} node=${run.node?.id ?? "local"}${reroutes}`,
		`started=${run.startedAt} ended=${run.endedAt ?? "n/a"} exit=${run.exitCode ?? "n/a"}`,
		`tokens=${run.tokenCount} cost=${formatCostAggregate(costAggregateForAmount(run.costUsd, run.costProvenance)) ?? COST_NOT_MEASURED} receipt=${run.receiptPath ?? "n/a"}`,
	];
	if (run.council !== undefined || run.gate?.role === "synthesis") {
		lines.push(
			`council: role=${run.gate?.role === "synthesis" ? "synthesis" : "member"} group=${run.council?.group ?? run.gate?.group ?? "unknown"}${run.council?.label ? ` label=${run.council.label}` : ""}`,
		);
	}
	if (run.budget !== undefined) {
		lines.push(
			`recipe policy: ${formatBudgetPolicy(run.budget)}`,
			`requested envelope: ${formatBudgetRequest(run.budget)}`,
			`effective envelope: ${formatEffectiveBudget(run.budget)}`,
			`clamp or escalation reason: ${formatBudgetReasons(run.budget)}`,
		);
	}
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
			...(assignment
				? {
						assignmentId: assignment.assignmentId,
						assignmentStatus: assignment.status,
						attemptRunIds: [...assignment.attempts],
						terminalRunId: assignment.terminalRunId,
					}
				: {}),
			runId: run.id,
			agentId: run.agentId,
			status: run.status,
			outcome: run.outcome ?? null,
			exitCode: run.exitCode,
			tokenCount: run.tokenCount,
			costUsd: run.costUsd,
			costProvenance: run.costProvenance ?? "unknown",
			budget: run.budget ?? null,
			...(run.council !== undefined || run.gate?.role === "synthesis"
				? {
						council: {
							role: run.gate?.role === "synthesis" ? "synthesis" : "member",
							group: run.council?.group ?? run.gate?.group ?? null,
							...(run.council !== undefined ? { label: run.council.label, round: run.council.round } : {}),
						},
					}
				: {}),
			receiptPath: run.receiptPath,
			running: live !== null,
		},
	};
}

function runPeek(deps: MonitorToolDeps, runId: string): ToolResult {
	const run = deps.dispatch.getRun(runId);
	const tail = deps.runEvents?.eventTail(runId) ?? null;
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

const TOOLS_MAX_CALL_LINES = 60;
const TOOLS_MAX_BYTES = 8 * 1024;
const TOOLS_ARGUMENTS_CHARS = 160;

/**
 * Tail event types that describe one tool call. `clio_tool_finish` is the
 * authoritative per-call outcome (it distinguishes a permission block from a
 * command that ran and exited nonzero); the engine's own `tool_execution_end`
 * is kept only when the tail recorded a detail for it, since a bare type line
 * says nothing the finish event does not.
 */
const TOOL_CALL_EVENT_TYPES: ReadonlySet<string> = new Set([
	"clio_tool_finish",
	"clio_permission_resolved",
	"clio_permission_escalated",
]);

function toolCallLines(entries: ReadonlyArray<{ at: string; type: string; detail?: string }>): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		const detailed = entry.detail !== undefined && entry.detail.length > 0;
		if (!TOOL_CALL_EVENT_TYPES.has(entry.type) && !(entry.type === "tool_execution_end" && detailed)) continue;
		lines.push(`  ${entry.at} ${entry.type}${detailed ? `: ${entry.detail}` : ""}`);
	}
	return lines;
}

function receiptToolLines(receipt: RunReceipt): string[] {
	const lines: string[] = [];
	const activity = receipt.toolActivity;
	if (activity) {
		lines.push(
			`  totals: calls=${activity.calls} succeeded=${activity.succeeded} failed=${activity.failed} blocked=${activity.blocked} mutating_succeeded=${activity.mutatingSucceeded}`,
		);
	} else {
		lines.push(`  totals: calls=${receipt.toolCalls}`);
	}
	for (const stat of receipt.toolStats) {
		lines.push(
			`  ${stat.tool}: count=${stat.count} ok=${stat.ok} errors=${stat.errors} blocked=${stat.blocked} total_ms=${stat.totalDurationMs}`,
		);
	}
	for (const attempt of receipt.safety?.blockedAttempts ?? []) {
		const parts = [
			`  blocked: ${attempt.tool}`,
			attempt.actionClass !== undefined ? `class=${attempt.actionClass}` : "",
			attempt.ruleId !== undefined ? `rule=${attempt.ruleId}` : "",
			attempt.reasonCode !== undefined ? `reason_code=${attempt.reasonCode}` : "",
		].filter((part) => part.length > 0);
		lines.push(parts.join(" "));
	}
	for (const entry of receipt.delegation?.toolCallLog ?? []) {
		let rendered: string;
		try {
			rendered = truncateUtf8(JSON.stringify(entry.arguments), TOOLS_ARGUMENTS_CHARS, "…");
		} catch {
			rendered = "(arguments not serializable)";
		}
		lines.push(`  ${entry.timestamp} ${entry.tool} ${entry.decision} args=${rendered}`);
	}
	return lines;
}

/**
 * What a run actually executed, call by call. It exists because the question
 * "did this run really run the validation it claims" had no in-session answer:
 * an orchestrator checking a worker's claimed `npm run typecheck` had to crawl
 * dozens of unrelated calls to find out, and the receipt's `toolCalls` is an
 * integer (REPORT-dispatch-drive-1.md R2).
 *
 * Two sources, both already in this process's hands: the same bounded event
 * tail `mode="peek"` reads, and the run's integrity-verified receipt. Neither
 * carries a command line for an ordinary worker call, so this mode does not
 * pretend to: it reports tool name and outcome per call, aggregates per tool,
 * and the arguments only where the source actually recorded them, which today
 * is the ACP delegation log. Loading the trace mirror to get argv would be a
 * new sqlite path and is deliberately not done here.
 */
function runTools(deps: MonitorToolDeps, runId: string): ToolResult {
	const requestedRun = deps.dispatch.getRun(runId);
	const rootRunId = requestedRun?.lineage?.rootRunId ?? runId;
	const assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
	const resolvedRunId = assignment?.terminalRunId ?? runId;
	const run = deps.dispatch.getRun(resolvedRunId) ?? requestedRun ?? null;
	if (run === null && assignment === null) return { kind: "error", message: `monitor: unknown run '${runId}'` };
	const tail = deps.runEvents?.eventTail(resolvedRunId) ?? null;
	const callLines = tail ? toolCallLines(tail.entries) : [];
	const evidence = durableRunEvidence(run);
	const receiptLines = evidence.receipt !== null ? receiptToolLines(evidence.receipt) : [];

	const lines = [`tool calls for run ${resolvedRunId}${run ? ` (${run.agentId})` : ""}:`];
	let omitted = 0;
	if (callLines.length > 0) {
		// Keep the newest calls: an orchestrator asking what a run executed is
		// usually asking about its last moves.
		const shown = callLines.length > TOOLS_MAX_CALL_LINES ? callLines.slice(-TOOLS_MAX_CALL_LINES) : callLines;
		omitted = callLines.length - shown.length;
		lines.push(
			`executed calls from this process's event buffer (newest last, ${shown.length} of ${callLines.length}${omitted > 0 ? `, ${omitted} older omitted` : ""}):`,
			...shown,
		);
	} else {
		lines.push(
			tail === null
				? "executed calls: no event buffer for this run in this process (it ran in another process, or its tail was evicted)."
				: "executed calls: the event buffer holds no tool-call events for this run.",
		);
	}
	if (receiptLines.length > 0) {
		lines.push("receipt totals (integrity verified):", ...receiptLines);
	} else if (evidence.integrityNote !== null) {
		lines.push(`receipt totals: unavailable. ${evidence.integrityNote}`);
	}
	lines.push(
		"note: the event buffer records tool name and outcome, not command arguments; absent argv is not evidence that no command ran.",
	);
	const body = truncateUtf8(lines.join("\n"), TOOLS_MAX_BYTES, "\n[tool list truncated]");
	return {
		kind: "ok",
		output: body,
		details: {
			mode: "tools",
			runId: resolvedRunId,
			callCount: callLines.length,
			omitted,
			bufferAvailable: tail !== null,
			receiptAvailable: evidence.receipt !== null,
			...(evidence.receipt !== null
				? {
						toolCalls: evidence.receipt.toolCalls,
						toolActivity: evidence.receipt.toolActivity ?? null,
						toolStats: evidence.receipt.toolStats,
					}
				: {}),
		},
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
	let receipt: RunReceipt | null = null;
	let receiptIntegrity: ReceiptIntegrityResult;
	let trustStatus: CanonicalTrustStatus;
	try {
		receipt = JSON.parse(raw) as RunReceipt;
		const inspection = inspectRunReceiptTrustStatus(receipt, run);
		receiptIntegrity = inspection.integrity;
		trustStatus = inspection.status;
	} catch (err) {
		receiptIntegrity = {
			ok: false,
			reason: `receipt invalid: ${err instanceof Error ? err.message : String(err)}`,
		};
		trustStatus = adaptRunReceiptTrustStatus(null, { integrity: receiptIntegrity });
	}
	return {
		kind: "ok",
		output: body,
		details: {
			mode: "receipt",
			runId,
			receiptPath: run.receiptPath,
			receiptIntegrity,
			trustStatus,
			...(receipt !== null && receiptIntegrity.ok
				? {
						evidenceVerification: receipt.verification,
						hostVerification: receipt.hostVerification ?? null,
						briefing: receipt.briefing ?? null,
						projectContext: receipt.projectContext ?? null,
					}
				: {}),
		},
	};
}

interface DurableRunEvidence {
	receipt: RunReceipt | null;
	output: RunReceipt["output"] | null;
	verification: RunReceiptVerification;
	integrity: ReceiptIntegrityResult;
	trustStatus: CanonicalTrustStatus;
	integrityNote: string | null;
	integrityFailure: boolean;
}

function unavailableRunEvidence(reason: string, note: string, integrityFailure = false): DurableRunEvidence {
	return {
		receipt: null,
		output: null,
		verification: UNVERIFIABLE_RECEIPT_VERIFICATION,
		integrity: { ok: false, reason },
		trustStatus: adaptRunReceiptTrustStatus(null, { integrity: { ok: false, reason } }),
		integrityNote: note,
		integrityFailure,
	};
}

/**
 * Read one terminal run's durable evidence boundary exactly once. Receipt
 * fields and worker text become renderable only after the existing integrity
 * check succeeds against the ledger envelope. Every failure returns unknown
 * verification plus an explicit note; unauthenticated prose is withheld.
 */
function durableRunEvidence(run: RunEnvelope | null): DurableRunEvidence {
	if (!run) {
		return unavailableRunEvidence(
			"run ledger envelope unavailable",
			"receipt integrity unavailable: the run ledger envelope is missing; worker text cannot be authenticated.",
		);
	}
	if (!run.receiptPath) {
		return unavailableRunEvidence(
			"receipt unavailable",
			"receipt integrity unavailable: no stored receipt; worker text is unavailable and validation is unknown.",
		);
	}
	let receipt: RunReceipt;
	try {
		receipt = JSON.parse(readFileSync(run.receiptPath, "utf8")) as RunReceipt;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return unavailableRunEvidence(
			`receipt unreadable: ${detail}`,
			`receipt integrity unavailable: cannot read or parse ${run.receiptPath} (${detail}); worker text is unavailable and validation is unknown.`,
		);
	}
	const inspection = inspectRunReceiptTrustStatus(receipt, run);
	const integrity = inspection.integrity;
	if (!integrity.ok) {
		return {
			...unavailableRunEvidence(
				integrity.reason,
				`receipt integrity failed: ${integrity.reason}; worker text is withheld as untrusted and validation is unknown.`,
				true,
			),
			trustStatus: inspection.status,
		};
	}
	return {
		receipt,
		output: receipt.output ?? null,
		verification: receipt.verification,
		integrity,
		trustStatus: inspection.status,
		integrityNote: null,
		integrityFailure: false,
	};
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
	const rootRunId = run.lineage?.rootRunId ?? runId;
	let assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
	while (assignment?.status === "running" || (assignment === null && !isTerminalRunEnvelope(run))) {
		if (signal?.aborted) return { kind: "error", message: "monitor: wait aborted" };
		const elapsed = Math.round(performance.now() - startedAt);
		if (elapsed >= timeoutMs) {
			return {
				kind: "ok",
				output: `wait timed out after ${timeoutMs}ms: ${assignment ? "assignment" : "run"} ${runId} is still ${assignment?.status ?? run.status} and keeps running normally. Wait again or collect later. Only steer(action="cancel") if the result is no longer needed — cancelling discards its work.`,
				details: {
					mode: "wait",
					runId,
					timedOut: true,
					state: assignment?.status ?? run.status,
					waitedMs: elapsed,
				},
			};
		}
		await sleep(Math.min(WAIT_POLL_MS, timeoutMs - elapsed));
		assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
		const resolvedRunId = assignment?.terminalRunId ?? runId;
		run = deps.dispatch.getRun(resolvedRunId) ?? run;
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
	/** Terminal attempt id when known, otherwise the root run id. */
	runId: string;
	assignmentId: string | null;
	attemptRunIds: ReadonlyArray<string>;
	assignmentStatus: DurableAssignmentRecord["status"] | null;
	agentId: string;
	run: RunEnvelope | null;
}

interface CollectedRunRow extends CollectRow {
	evidence: DurableRunEvidence;
}

function failedIntegrityReason(integrity: ReceiptIntegrityResult): string {
	return integrity.ok ? "verification result unavailable" : integrity.reason;
}

function collectRunLine(row: CollectedRunRow): string[] {
	const run = row.run;
	const lines = run
		? [
				`- ${run.id} agent=${run.agentId} state=${run.outcome ?? run.status} node=${run.node?.id ?? "local"} exit=${run.exitCode ?? "n/a"} tokens=${run.tokenCount} cost=${formatCostAggregate(costAggregateForAmount(run.costUsd, run.costProvenance)) ?? COST_NOT_MEASURED} receipt=${run.receiptPath ?? "n/a"}${run.outcomeDetail ? ` detail=${run.outcomeDetail}` : ""}`,
			]
		: [`- ${row.runId} agent=${row.agentId} state=missing (ledger row pruned; receipt may still exist)`];
	if (row.assignmentId !== null) {
		lines.unshift(
			`- assignment=${row.assignmentId} status=${row.assignmentStatus ?? "unknown"} terminal=${row.runId}`,
			`  attempts=${row.attemptRunIds.join(",") || "none"}`,
		);
	}
	if (row.evidence.receipt !== null) {
		lines.push(
			...receiptEvidenceLabels(row.evidence.receipt, row.evidence.verification, row.evidence.integrity).map(
				(label) => `  ${label}`,
			),
		);
	} else {
		const reason = failedIntegrityReason(row.evidence.integrity);
		lines.push(
			row.evidence.integrityFailure
				? `  RECEIPT INTEGRITY FAILED for ${row.runId} (${reason}); stored receipt fields and worker text are untrusted.`
				: `  receipt_integrity=unavailable reason=${JSON.stringify(reason)}`,
		);
	}
	if (row.evidence.integrityNote) lines.push(`  ${row.evidence.integrityNote}`);
	lines.push(`  ${workerTextLabel(row.evidence.trustStatus)}`);
	const output = row.evidence.output;
	if (output) {
		const capped = truncateUtf8(output.text, COLLECT_TEXT_BYTES, "...");
		const qualifier = output.state === "partial" ? " (partial; the run did not complete this message)" : "";
		const truncatedNote = output.truncated ? ` (stored output truncated; full text was ${output.bytes} bytes)` : "";
		lines.push(`  agent output${qualifier}${truncatedNote}:`, ...capped.split("\n").map((line) => `  ${line}`));
		if (row.evidence.receipt) {
			lines.push(
				...workerTextNonEvidenceNotices(row.evidence.receipt, row.evidence.trustStatus, output.text).map(
					(notice) => `  ${notice}`,
				),
			);
		}
	} else if (row.evidence.integrity.ok) {
		lines.push("  (no assistant text captured)");
	}
	return lines;
}

function resolveCollectRow(deps: MonitorToolDeps, originalRunId: string, agentId: string): CollectRow {
	const original = deps.dispatch.getRun(originalRunId);
	const rootRunId = original?.lineage?.rootRunId ?? originalRunId;
	// The durable assignment record is written asynchronously at admission, so a
	// collect issued in that window sees none yet and reads the attempt directly.
	// terminalRunId is null while the assignment is still running.
	const assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
	const runId = assignment?.terminalRunId ?? originalRunId;
	const run = deps.dispatch.getRun(runId) ?? original;
	return {
		runId,
		assignmentId: assignment?.assignmentId ?? null,
		attemptRunIds: assignment?.attempts ?? [originalRunId],
		assignmentStatus: assignment?.status ?? null,
		agentId: run?.agentId ?? agentId,
		run,
	};
}

/**
 * Batch barrier over a durable batch id or an explicit run-id list. Never
 * blocks: while any run is in flight it returns a pending snapshot; once all
 * are terminal it returns the full results and marks the batch collected so
 * completion nudges stop. A ledger row pruned from the bounded ring counts as
 * terminal (it can never complete) and is reported as missing.
 */
async function runCollect(
	deps: MonitorToolDeps,
	batchId: string,
	runIds: ReadonlyArray<string>,
	timeoutWasPassed: boolean,
): Promise<ToolResult> {
	let rows: CollectRow[];
	let scope: string;
	let ledgerId: string | null = null;
	if (batchId.length > 0) {
		const detached = deps.dispatch.detached;
		if (!detached) return { kind: "error", message: "monitor: no detached batch records are available in this context" };
		const record = detached.get(batchId);
		if (!record) return { kind: "error", message: `monitor: unknown batch '${batchId}'` };
		ledgerId = record.ledgerId ?? null;
		rows = record.runs.map((entry) => resolveCollectRow(deps, entry.assignmentId, entry.agentId));
		scope = `batch ${batchId}${record.collectedAt !== null ? " (already collected)" : ""}`;
	} else {
		rows = runIds.map((runId) => resolveCollectRow(deps, runId, "unknown"));
		scope = `${rows.length} run(s)`;
	}
	// A durably-running assignment is never collectable: a genuinely in-flight
	// one still has an active attempt or a queued retry, and an orphaned one is
	// reconciled to terminal at startup. Reporting it complete while its status
	// is still "running" would let a caller consume a non-final attempt.
	const pending = rows.filter((row) => {
		if (row.assignmentStatus === null) return row.run !== null && !isTerminalRunEnvelope(row.run);
		return row.assignmentStatus === "running";
	});
	if (pending.length > 0) {
		const lines = [
			`collect pending: ${pending.length} of ${rows.length} run(s) still in flight for ${scope}`,
			...rows.map((row) => {
				const state = row.run === null ? "missing" : (row.run.outcome ?? row.run.status);
				return `- ${row.assignmentId ?? row.runId} agent=${row.agentId} state=${row.assignmentStatus ?? state}`;
			}),
			"",
			'Collect again later, or block on a single run with mode="wait".',
			...(timeoutWasPassed ? ["", COLLECT_TIMEOUT_NOTICE] : []),
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
				pendingRunIds: pending.map((row) => row.assignmentId ?? row.runId),
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
	// Every run is terminal here, so the board is what the peers finished with.
	// It is read before the collect that closes it, and a closed board still
	// renders, so a repeated collect answers the same way as the first.
	const board = ledgerId === null ? null : renderAgentLedgerBoard(ledgerId);
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
	const collectedRows: CollectedRunRow[] = rows.map((row) => ({ ...row, evidence: durableRunEvidence(row.run) }));
	const lines = [
		`collect complete for ${scope}: total=${rows.length} failed=${failed.length}${missing.length > 0 ? ` missing=${missing.length}` : ""}`,
		...collectedRows.flatMap((row) => collectRunLine(row)),
		...(board !== null ? ["", board] : []),
		...(batchId.length > 0 && !collected
			? ["", "note: the batch record could not be marked collected; it stays open for a later collect."]
			: []),
		...(timeoutWasPassed ? ["", COLLECT_TIMEOUT_NOTICE] : []),
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "collect",
			...(batchId.length > 0 ? { batchId, collected } : {}),
			...(board !== null ? { agentLedgerBoard: board } : {}),
			complete: true,
			runCount: rows.length,
			failedCount: failed.length,
			runs: collectedRows.map((row) => {
				const output = row.evidence.output;
				return {
					runId: row.runId,
					...(row.assignmentId !== null
						? {
								assignmentId: row.assignmentId,
								assignmentStatus: row.assignmentStatus,
								attemptRunIds: [...row.attemptRunIds],
								terminalRunId: row.runId,
							}
						: {}),
					agentId: row.agentId,
					state: row.run === null ? "missing" : (row.run.outcome ?? row.run.status),
					exitCode: row.run?.exitCode ?? null,
					receiptPath: row.run?.receiptPath ?? null,
					receiptIntegrity: row.evidence.integrity,
					trustStatus: row.evidence.trustStatus,
					evidenceVerification: row.evidence.verification,
					hostVerification: row.evidence.receipt?.hostVerification ?? null,
					briefing: row.evidence.receipt?.briefing ?? null,
					projectContext: row.evidence.receipt?.projectContext ?? null,
					...(output ? { output: { state: output.state, bytes: output.bytes, truncated: output.truncated } } : {}),
				};
			}),
		},
	};
}

export function createMonitorTool(deps: MonitorToolDeps): ToolSpec {
	return {
		...monitorToolSurface,
		async run(args, options): Promise<ToolResult> {
			const explicitRunId = typeof args.run_id === "string" ? args.run_id.trim() : "";
			const rawRunIds = Array.isArray(args.run_ids) ? args.run_ids : null;
			const singletonRunId = rawRunIds?.length === 1 && typeof rawRunIds[0] === "string" ? rawRunIds[0].trim() : "";
			const runId = explicitRunId.length > 0 ? explicitRunId : singletonRunId;
			const mode = typeof args.mode === "string" ? args.mode : runId.length > 0 ? "status" : "list";
			if (
				mode !== "status" &&
				mode !== "peek" &&
				mode !== "receipt" &&
				mode !== "list" &&
				mode !== "wait" &&
				mode !== "collect" &&
				mode !== "tools"
			) {
				return {
					kind: "error",
					message: `monitor: mode must be status, peek, receipt, list, wait, collect, or tools; got '${mode}'`,
				};
			}
			if (mode === "list") return listRuns(deps, options);
			if (mode === "collect") {
				const batchId = typeof args.batch_id === "string" ? args.batch_id.trim() : "";
				const runIds = rawRunIds
					? rawRunIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
					: [];
				if (batchId.length === 0 && runIds.length === 0) {
					return { kind: "error", message: "monitor: mode=collect requires batch_id or a non-empty run_ids array" };
				}
				return runCollect(deps, batchId, runIds, Object.hasOwn(args, "timeout_ms"));
			}
			if (runId.length === 0) {
				if (rawRunIds !== null) {
					const entryLabel = rawRunIds.length === 1 ? "entry" : "entries";
					return {
						kind: "error",
						message: `monitor: mode=${mode} observes one run; got run_ids with ${rawRunIds.length} ${entryLabel} — pass run_id=<one id>, or use mode=collect run_ids=[...] for a batch`,
					};
				}
				return {
					kind: "error",
					message: `monitor: mode=${mode} observes one run and needs run_id; call monitor(mode="list") first to see the run ids this session knows about`,
				};
			}
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
			if (mode === "tools") return runTools(deps, runId);
			return runReceipt(deps, runId);
		},
	};
}
