import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { ToolNames } from "../core/tool-names.js";
import type { DurableAssignmentRecord } from "../domains/dispatch/assignment-store.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import { UNVERIFIABLE_RECEIPT_VERIFICATION } from "../domains/dispatch/receipt-findings.js";
import { type ReceiptIntegrityResult, verifyReceiptIntegrity } from "../domains/dispatch/receipt-integrity.js";
import {
	isTerminalRunEnvelope,
	type RunEnvelope,
	type RunReceipt,
	type RunReceiptVerification,
} from "../domains/dispatch/types.js";
import { COST_NOT_MEASURED, costAggregateForAmount, formatCostAggregate } from "../domains/observability/index.js";
import type { DispatchRunEventRegistry } from "./dispatch.js";
import type { ToolInvokeOptions, ToolResult, ToolSpec } from "./registry.js";
import { stringEnum } from "./string-enum.js";
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
	try {
		receipt = JSON.parse(raw) as RunReceipt;
		receiptIntegrity = verifyReceiptIntegrity(receipt, run);
	} catch (err) {
		receiptIntegrity = {
			ok: false,
			reason: `receipt invalid: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	return {
		kind: "ok",
		output: body,
		details: {
			mode: "receipt",
			runId,
			receiptPath: run.receiptPath,
			receiptIntegrity,
			...(receipt !== null && receiptIntegrity.ok
				? {
						evidenceVerification: receipt.verification,
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
	integrityNote: string | null;
	integrityFailure: boolean;
}

function unavailableRunEvidence(reason: string, note: string, integrityFailure = false): DurableRunEvidence {
	return {
		receipt: null,
		output: null,
		verification: UNVERIFIABLE_RECEIPT_VERIFICATION,
		integrity: { ok: false, reason },
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
	let integrity: ReceiptIntegrityResult;
	try {
		integrity = verifyReceiptIntegrity(receipt, run);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return unavailableRunEvidence(
			`receipt invalid: ${detail}`,
			`receipt integrity failed: invalid receipt (${detail}); worker text is withheld as untrusted and validation is unknown.`,
			true,
		);
	}
	if (!integrity.ok) {
		return unavailableRunEvidence(
			integrity.reason,
			`receipt integrity failed: ${integrity.reason}; worker text is withheld as untrusted and validation is unknown.`,
			true,
		);
	}
	return {
		receipt,
		output: receipt.output ?? null,
		verification: receipt.verification,
		integrity,
		integrityNote: null,
		integrityFailure: false,
	};
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
	lines.push(`  ${workerTextLabel(row.evidence.verification)}`);
	const output = row.evidence.output;
	if (output) {
		const capped = truncateUtf8(output.text, COLLECT_TEXT_BYTES, "...");
		const qualifier = output.state === "partial" ? " (partial; the run did not complete this message)" : "";
		const truncatedNote = output.truncated ? ` (stored output truncated; full text was ${output.bytes} bytes)` : "";
		lines.push(`  agent output${qualifier}${truncatedNote}:`, ...capped.split("\n").map((line) => `  ${line}`));
		if (row.evidence.receipt) {
			lines.push(
				...workerTextNonEvidenceNotices(row.evidence.receipt, row.evidence.verification, output.text).map(
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
	if (batchId.length > 0) {
		const detached = deps.dispatch.detached;
		if (!detached) return { kind: "error", message: "monitor: no detached batch records are available in this context" };
		const record = detached.get(batchId);
		if (!record) return { kind: "error", message: `monitor: unknown batch '${batchId}'` };
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
					evidenceVerification: row.evidence.verification,
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
		name: ToolNames.Monitor,
		description:
			"Inspect known dispatched runs. Parent-model mid-run observation requires detach:true because ordinary dispatch auto-waits. wait observes without collecting. collect is the authoritative terminal batch operation; collect detached runs before final synthesis. receipt exposes stored evidence. Receipt integrity, evidence verification, briefing provenance, and project-context provenance are separate fields.",
		parameters: Type.Object({
			run_id: Type.Optional(
				Type.String({ description: "Run id from dispatch output or monitor list; omit with mode=list." }),
			),
			mode: Type.Optional(
				stringEnum(
					["status", "peek", "receipt", "list", "wait", "collect"],
					"What to return. Defaults to status when run_id is present and list when it is absent. status, peek, receipt, and wait each observe one run and require a run_id; list takes none.",
				),
			),
			batch_id: Type.Optional(Type.String({ description: "Detached batch id from dispatch detach:true (mode=collect)." })),
			run_ids: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Explicit run ids for mode=collect; a one-element array is also accepted by single-run modes when run_id is absent.",
				}),
			),
			timeout_ms: Type.Optional(
				Type.Number({
					description:
						"mode=wait: max ms to block (default 60000, capped at 600000); mode=collect never blocks and ignores this value with a notice.",
				}),
			),
		}),
		baseActionClass: "read",
		executionMode: "parallel",
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
			return runReceipt(deps, runId);
		},
	};
}
