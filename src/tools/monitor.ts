import { readFileSync } from "node:fs";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
} from "../domains/dispatch/budget-envelope.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { type DispatchOwnership, dispatchOwnerOf, dispatchOwnership } from "../domains/dispatch/ownership.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import { isTerminalRunEnvelope, type RunEnvelope, type RunReceipt } from "../domains/dispatch/types.js";
import { summarizeTrustStatus, trustStateWord } from "../domains/evidence/trust-projection.js";
import {
	adaptRunReceiptTrustStatus,
	type CanonicalTrustStatus,
	inspectRunReceiptTrustStatus,
} from "../domains/evidence/trust-status.js";
import { COST_NOT_MEASURED, costAggregateForAmount, formatCostAggregate } from "../domains/observability/index.js";
import type { DispatchRunEventRegistry } from "./dispatch.js";
import { grantRequestLines, pendingRequestsFor, requestsAwaitingMain } from "./grant-request-text.js";
import type { JobOperations } from "./job-types.js";
import { collectDetachedBatch, collectRuns, durableRunEvidence } from "./monitor-collect.js";
import { listJobMonitor, runJobMonitor } from "./monitor-jobs.js";
import { monitorToolSurface } from "./monitor-surface.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

/**
 * The monitor tool: read-only visibility into known synchronous and detached
 * dispatched runs. The interactive operator/TUI can inspect an active sync
 * run through the dispatch contract; parent-model mid-run observation requires
 * detach because a sequential synchronous dispatch call auto-waits. mode=list
 * enumerates this session's runs, status reports one run's state and progress counters, peek
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
 *
 * Those stores are machine-wide, so every mode checks the row against this
 * session first (ownership.ts): list and collect see only what this session
 * dispatched, and the single-run modes read runs of this session or this
 * project. A run another project dispatched is refused by name rather than
 * reported unknown, so the model stops asking about it.
 */

const LIST_LIMIT = 20;
const PEEK_MAX_BYTES = 8 * 1024;
const RECEIPT_MAX_BYTES = 14 * 1024;
const WAIT_DEFAULT_TIMEOUT_MS = 60_000;
const WAIT_MAX_TIMEOUT_MS = 10 * 60_000;
/**
 * Collect blocks while its runs are in flight. A non-blocking collect answered
 * "collect again later" instantly, so a coordinator polling it tripped the
 * identical-call loop guard on the third call and lost its tools for the turn
 * (D3). Blocking turns each poll into real elapsed time.
 */
const COLLECT_DEFAULT_TIMEOUT_MS = 30_000;

export interface MonitorToolDeps {
	dispatch: DispatchContract;
	runEvents?: Pick<DispatchRunEventRegistry, "eventTail">;
	jobs?: JobOperations;
}

/** A revision fence retains changes that land while a durable snapshot is being read. */
function observeDispatchChanges(dispatch: DispatchContract): {
	revision(): number;
	wait(revision: number, timeoutMs: number, signal: AbortSignal | undefined): Promise<void>;
	dispose(): void;
} {
	let revision = 0;
	let wake: (() => void) | null = null;
	const changed = (): void => {
		revision += 1;
		wake?.();
	};
	const unsubscribes: Array<() => void> = [];
	try {
		if (dispatch.subscribeChanges) unsubscribes.push(dispatch.subscribeChanges(changed));
		if (dispatch.grants) unsubscribes.push(dispatch.grants.onPending(changed));
	} catch (error) {
		for (const unsubscribe of unsubscribes) unsubscribe();
		throw error;
	}
	return {
		revision: () => revision,
		async wait(observed, timeoutMs, signal) {
			if (observed !== revision || signal?.aborted) return;
			const waitingAt = performance.now();
			const Effect = await import("effect/Effect");
			if (observed !== revision || signal?.aborted) return;
			const remainingMs = timeoutMs - (performance.now() - waitingAt);
			if (remainingMs <= 0) return;
			const changed = Effect.ensuring(Effect.callback<void>((resume) => {
				wake = () => resume(Effect.void);
				if (observed !== revision) wake();
			}), Effect.sync(() => {
				wake = null;
			}));
			await Effect.runPromiseExit(Effect.raceFirst(changed, Effect.sleep(remainingMs)), { signal });
		},
		dispose() {
			for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
			wake?.();
		},
	};
}

function runLine(run: RunEnvelope): string {
	const state = run.outcome ?? run.status;
	const receipt = run.receiptPath ?? "n/a";
	return `- ${run.id} agent=${run.agentId} state=${state} node=${run.node?.id ?? "local"} started=${run.startedAt} tokens=${run.tokenCount} receipt=${receipt}`;
}

function ownershipFor(deps: MonitorToolDeps, options: ToolInvokeOptions | undefined): DispatchOwnership {
	return dispatchOwnership(dispatchOwnerOf(deps.dispatch, options?.sessionId));
}

/** The refusal for a run this session may not read, or null when it may. */
function unseenRunError(ownership: DispatchOwnership, requestedId: string, run: RunEnvelope | null): ToolResult | null {
	if (run === null || ownership.seesRun(run)) return null;
	return {
		kind: "error",
		message: `monitor: run '${requestedId}' belongs to another project; only sessions in that project can inspect it`,
	};
}

/**
 * This session's runs only. It used to fall back to every session's runs when
 * this one had none, and because worker runs never recorded their session it
 * always did: a fresh session was handed another project's run ids and
 * receipt paths as if they were its own.
 */
function listRuns(deps: MonitorToolDeps, options: ToolInvokeOptions | undefined): ToolResult {
	let runs: ReadonlyArray<RunEnvelope>;
	try {
		runs = deps.dispatch.listRuns();
	} catch (err) {
		return { kind: "error", message: `monitor: ${err instanceof Error ? err.message : String(err)}` };
	}
	const ownership = ownershipFor(deps, options);
	const scoped = runs.filter((run) => ownership.ownsRun(run));
	const shown = scoped.slice(0, LIST_LIMIT);
	if (shown.length === 0) {
		return {
			kind: "ok",
			output: "No dispatched runs recorded for this session.",
			details: { mode: "list", runCount: 0 },
		};
	}
	const lines = [`dispatched runs (this session, newest first, ${shown.length} of ${scoped.length}):`];
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

function runStatus(deps: MonitorToolDeps, runId: string, ownership: DispatchOwnership): ToolResult {
	const requestedRun = deps.dispatch.getRun(runId);
	const assignment = deps.dispatch.assignments?.getStored(runId) ?? null;
	const rootRunId = assignment?.assignmentId ?? requestedRun?.lineage?.rootRunId ?? runId;
	const resolvedRunId = assignment?.terminalRunId ?? runId;
	const run = deps.dispatch.getRun(resolvedRunId) ?? requestedRun;
	if (!run && !assignment) return { kind: "error", message: `monitor: unknown run or assignment '${runId}'` };
	if (!run) return { kind: "error", message: `monitor: assignment '${runId}' has no available attempt` };
	const unseen = unseenRunError(ownership, runId, run);
	if (unseen !== null) return unseen;
	const live =
		deps.dispatch
			.snapshot()
			.running.find(
				(entry) =>
					(deps.dispatch.assignments?.getStored(entry.runId)?.assignmentId ?? entry.lineage.rootRunId) === rootRunId,
			) ?? null;
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
	// A worker ask routed to the main agent waits here until it is answered (Phase D).
	const pendingPermissions = pendingRequestsFor(deps.dispatch, [run.id, rootRunId]);
	if (pendingPermissions.length > 0) {
		lines.push("pending permission requests:", ...pendingPermissions.flatMap((view) => grantRequestLines(view)));
	}
	const trust = isTerminalRunEnvelope(run) ? summarizeTrustStatus(durableRunEvidence(run).trustStatus) : null;
	if (trust)
		lines.push(
			`quality: ${trustStateWord("validationGrounding", trust.axes.validationGrounding)}`,
			`trust: ${trust.text}`,
		);
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "status",
			...(trust ? { trust } : {}),
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
			...(pendingPermissions.length > 0 ? { pendingPermissions: pendingPermissions.map((view) => ({ ...view })) } : {}),
		},
	};
}

function runPeek(deps: MonitorToolDeps, runId: string, ownership: DispatchOwnership): ToolResult {
	const run = deps.dispatch.getRun(runId);
	const unseen = unseenRunError(ownership, runId, run);
	if (unseen !== null) return unseen;
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
 * Tail event types that describe one tool call. `clio_coder_tool_finish` is the
 * authoritative per-call outcome (it distinguishes a permission block from a
 * command that ran and exited nonzero); the engine's own `tool_execution_end`
 * is kept only when the tail recorded a detail for it, since a bare type line
 * says nothing the finish event does not.
 */
const TOOL_CALL_EVENT_TYPES: ReadonlySet<string> = new Set([
	"clio_coder_tool_finish",
	"clio_coder_permission_resolved",
	"clio_coder_permission_escalated",
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
function runTools(deps: MonitorToolDeps, runId: string, ownership: DispatchOwnership): ToolResult {
	const requestedRun = deps.dispatch.getRun(runId);
	const assignment = deps.dispatch.assignments?.getStored(runId) ?? null;
	const resolvedRunId = assignment?.terminalRunId ?? runId;
	const run = deps.dispatch.getRun(resolvedRunId) ?? requestedRun ?? null;
	if (run === null && assignment === null) return { kind: "error", message: `monitor: unknown run '${runId}'` };
	const unseen = unseenRunError(ownership, runId, run);
	if (unseen !== null) return unseen;
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

function runReceipt(deps: MonitorToolDeps, runId: string, ownership: DispatchOwnership): ToolResult {
	const run = deps.dispatch.getRun(runId);
	if (!run) return { kind: "error", message: `monitor: unknown run '${runId}'` };
	const unseen = unseenRunError(ownership, runId, run);
	if (unseen !== null) return unseen;
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
			trust: summarizeTrustStatus(trustStatus),
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
	ownership: DispatchOwnership,
): Promise<ToolResult> {
	const changes = observeDispatchChanges(deps.dispatch);
	try {
		const startedAt = performance.now();
		let revision = changes.revision();
		let run = deps.dispatch.getRun(runId);
		if (!run) return { kind: "error", message: `monitor: unknown run '${runId}'` };
		const unseen = unseenRunError(ownership, runId, run);
		if (unseen !== null) return unseen;
		let assignment = deps.dispatch.assignments?.getStored(runId) ?? null;
		const rootRunId = assignment?.assignmentId ?? runId;
		while (assignment?.status === "running" || (assignment === null && !isTerminalRunEnvelope(run))) {
			if (signal?.aborted) return { kind: "error", message: "monitor: wait aborted" };
			const elapsed = Math.round(performance.now() - startedAt);
			// Waiting on a run whose worker waits on this caller would only run the
			// request out, so the wait stops and says what to answer (Phase D).
			const awaiting = requestsAwaitingMain(deps.dispatch, [runId, rootRunId, run.id]);
			if (awaiting.length > 0) {
				return {
					kind: "ok",
					output: [
						`wait stopped after ${elapsed}ms: run ${runId} is waiting for your permission decision and keeps running.`,
						...awaiting.flatMap((view) => grantRequestLines(view)),
					].join("\n"),
					details: {
						mode: "wait",
						runId,
						timedOut: false,
						permissionPending: true,
						state: assignment?.status ?? run.status,
						waitedMs: elapsed,
						pendingPermissions: awaiting.map((view) => ({ ...view })),
					},
				};
			}
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
			await changes.wait(revision, timeoutMs - elapsed, signal);
			if (signal?.aborted) return { kind: "error", message: "monitor: wait aborted" };
			revision = changes.revision();
			assignment = deps.dispatch.assignments?.getStored(rootRunId) ?? null;
			const resolvedRunId = assignment?.terminalRunId ?? runId;
			run = deps.dispatch.getRun(resolvedRunId) ?? run;
			if (!run) return { kind: "error", message: `monitor: run '${runId}' disappeared from the ledger while waiting` };
		}
		const status = runStatus(deps, runId, ownership);
		if (status.kind !== "ok") return status;
		const waitedMs = Math.round(performance.now() - startedAt);
		return {
			kind: "ok",
			output: `wait complete after ${waitedMs}ms:\n${status.output}`,
			details: { ...status.details, mode: "wait", timedOut: false, waitedMs },
		};
	} finally {
		changes.dispose();
	}
}

function boundedTimeout(raw: unknown, fallback: number): number {
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0
		? Math.min(Math.floor(raw), WAIT_MAX_TIMEOUT_MS)
		: fallback;
}

async function runCollect(
	deps: MonitorToolDeps,
	batchId: string,
	runIds: ReadonlyArray<string>,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	ownership: DispatchOwnership,
): Promise<ToolResult> {
	const changes = observeDispatchChanges(deps.dispatch);
	try {
		const startedAt = performance.now();
		const collectOnce = () =>
			batchId.length > 0 ? collectDetachedBatch(deps, batchId, ownership) : collectRuns(deps, batchId, runIds, ownership);
		let revision = changes.revision();
		let result = await collectOnce();
		while (result.kind === "ok" && result.details?.complete === false) {
			if (signal?.aborted) return { kind: "error", message: "monitor: collect aborted" };
			const elapsed = Math.round(performance.now() - startedAt);
			const pendingRunIds = Array.isArray(result.details?.pendingRunIds)
				? result.details.pendingRunIds.filter((entry): entry is string => typeof entry === "string")
				: [];
			const awaiting = requestsAwaitingMain(deps.dispatch, pendingRunIds);
			if (awaiting.length > 0) {
				return {
					...result,
					output: [
						result.output,
						"",
						"A worker in this batch is waiting for your permission decision; collect stopped so you can answer it:",
						...awaiting.flatMap((view) => grantRequestLines(view)),
					].join("\n"),
					details: {
						...result.details,
						timedOut: false,
						permissionPending: true,
						waitedMs: elapsed,
						pendingPermissions: awaiting.map((view) => ({ ...view })),
					},
				};
			}
			if (elapsed >= timeoutMs) {
				return {
					...result,
					output: `${result.output}\n\ncollect waited ${elapsed}ms; the runs keep running normally.`,
					details: { ...result.details, timedOut: true, waitedMs: elapsed },
				};
			}
			await changes.wait(revision, timeoutMs - elapsed, signal);
			if (signal?.aborted) return { kind: "error", message: "monitor: collect aborted" };
			revision = changes.revision();
			result = await collectOnce();
		}
		if (result.kind !== "ok") return result;
		return {
			...result,
			details: { ...result.details, timedOut: false, waitedMs: Math.round(performance.now() - startedAt) },
		};
	} finally {
		changes.dispose();
	}
}

export function createMonitorTool(deps: MonitorToolDeps): ToolSpec {
	return {
		...monitorToolSurface,
		async run(args, options): Promise<ToolResult> {
			const jobResult = await runJobMonitor(deps.jobs, args, options);
			if (jobResult !== null) return jobResult;
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
			if (mode === "list") {
				const runs = listRuns(deps, options);
				if (!deps.jobs || runs.kind === "error") return runs;
				const jobs = listJobMonitor(deps.jobs);
				return jobs.kind === "error"
					? runs
					: { kind: "ok", output: `${runs.output}\n\n${jobs.output}`, details: { ...runs.details, ...jobs.details } };
			}
			if (mode === "collect") {
				const batchId = typeof args.batch_id === "string" ? args.batch_id.trim() : "";
				const runIds = rawRunIds
					? rawRunIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
					: [];
				if (batchId.length === 0 && runIds.length === 0) {
					return { kind: "error", message: "monitor: mode=collect requires batch_id or a non-empty run_ids array" };
				}
				return runCollect(
					deps,
					batchId,
					runIds,
					boundedTimeout(args.timeout_ms, COLLECT_DEFAULT_TIMEOUT_MS),
					options?.signal,
					ownershipFor(deps, options),
				);
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
				return runWait(
					deps,
					runId,
					boundedTimeout(args.timeout_ms, WAIT_DEFAULT_TIMEOUT_MS),
					options?.signal,
					ownershipFor(deps, options),
				);
			}
			const ownership = ownershipFor(deps, options);
			if (mode === "status") return runStatus(deps, runId, ownership);
			if (mode === "peek") return runPeek(deps, runId, ownership);
			if (mode === "tools") return runTools(deps, runId, ownership);
			return runReceipt(deps, runId, ownership);
		},
	};
}
