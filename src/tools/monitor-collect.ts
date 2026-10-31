import { join } from "node:path";
import type { RunTelemetryV1 } from "../core/telemetry/dto.js";
import { clioStateDir } from "../core/xdg.js";
import { projectLedgerAssignments, projectReceiptFindings } from "../domains/dispatch/agent-ledger.js";
import { readAgentLedger, renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
import type { DurableAssignmentRecord } from "../domains/dispatch/assignment-store.js";
import type { DispatchOwnership } from "../domains/dispatch/ownership.js";
import { UNVERIFIABLE_RECEIPT_VERIFICATION } from "../domains/dispatch/receipt-findings.js";
import type { RunEnvelope } from "../domains/dispatch/types.js";
import { isTerminalRunEnvelope } from "../domains/dispatch/types.js";
import type { CanonicalTrustStatus } from "../domains/evidence/trust-status.js";
import { inspectRunTrustStatus, type RunIntegrity } from "../domains/evidence/trust-status.js";
import { mergeFlowRestrictions } from "../domains/safety/information-flow.js";
import { loadRunRecord } from "../domains/session/telemetry-source.js";
import {
	COST_NOT_MEASURED,
	costAggregateForAmount,
	formatCostAggregate,
	readVerifiedRun,
} from "../domains/telemetry/index.js";
import { telemetryObjectsDirectory, telemetryRunDirectory } from "../domains/telemetry/paths.js";
import { flowRestrictionsOfRuns } from "./dispatch-runner.js";
import type { MonitorToolDeps } from "./monitor.js";
import type { ToolResult } from "./registry.js";
import { FLOW_RESTRICTIONS_DETAIL } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import {
	compactHelperResultLines,
	type FinishedRun,
	runEvidenceLabels,
	runHelperResult,
	workerTextLabel,
	workerTextNonEvidenceNotices,
} from "./worker-evidence.js";

const COLLECT_TEXT_BYTES = 2000;
/** Pending/completed rows, text and board remain in the monitor's existing result/details shape. */
export type CollectOutcome = ToolResult;

export async function collectDetachedBatch(
	deps: MonitorToolDeps,
	batchId: string,
	ownership: DispatchOwnership,
): Promise<CollectOutcome> {
	return collectRuns(deps, batchId, [], ownership);
}

export interface DurableRunEvidence {
	/** The run's settled facts and result object, present only when its seal verifies. */
	run: FinishedRun | null;
	integrity: RunIntegrity;
	trustStatus: CanonicalTrustStatus;
	/** Why the record cannot be read as evidence; null when it can. */
	integrityNote: string | null;
	integrityFailure: boolean;
	/** The result object's file in the run scope, which holds the full captured answer. */
	resultPath: string | null;
}

/**
 * Read one terminal run's durable evidence boundary exactly once, from its sealed run scope. Settled facts and worker
 * text become renderable only under a seal that verifies. Every other state returns unknown verification plus an
 * explicit note; unauthenticated prose is withheld (#434).
 */
export function durableRunEvidence(envelope: RunEnvelope | null): DurableRunEvidence {
	let record: RunTelemetryV1 | null = null;
	if (envelope !== null) {
		try {
			record = loadRunRecord(clioStateDir(), envelope.id);
		} catch {
			// An unreadable run scope reads as a run with no record.
			record = null;
		}
	}
	const inspection = inspectRunTrustStatus(record);
	const integrity = inspection.integrity;
	const settled = record?.settled ?? null;
	if (record === null || settled === null || integrity.state !== "verified") {
		const reason =
			envelope === null
				? "run ledger envelope unavailable"
				: integrity.state === "verified"
					? "the run has not settled"
					: integrity.reason;
		return {
			run: null,
			integrity: integrity.state === "verified" ? { state: "unsealed", reason } : integrity,
			trustStatus: inspection.status,
			integrityNote: `run record unavailable as evidence: ${reason}; worker text is ${integrity.state === "failed" ? "withheld as untrusted" : "unavailable"} and validation is unknown.`,
			integrityFailure: integrity.state === "failed",
			resultPath: null,
		};
	}
	return {
		run: {
			runId: record.row.runId,
			digest: settled.digest,
			facts: settled,
			delivered: record.result?.state === "resolved" ? record.result.value : null,
		},
		integrity,
		trustStatus: inspection.status,
		integrityNote: null,
		integrityFailure: false,
		resultPath: join(
			telemetryObjectsDirectory(telemetryRunDirectory(clioStateDir(), record.row.runId)),
			`${settled.result.id}.json`,
		),
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

function collectRunLine(row: CollectedRunRow): string[] {
	if (row.evidence.run !== null) {
		const helperLines = compactHelperResultLines(row.evidence.run, row.evidence.integrity, COLLECT_TEXT_BYTES);
		if (helperLines !== null) return helperLines;
	}
	const run = row.run;
	const lines = run
		? [
				`- ${run.id} agent=${run.agentId} state=${run.outcome ?? run.status} node=${run.node?.id ?? "local"} exit=${run.exitCode ?? "n/a"} tokens=${run.tokenCount} cost=${formatCostAggregate(costAggregateForAmount(run.costUsd, run.costProvenance, run.costSummary)) ?? COST_NOT_MEASURED}${run.outcomeDetail ? ` detail=${run.outcomeDetail}` : ""}`,
			]
		: [`- ${row.runId} agent=${row.agentId} state=missing (ledger row pruned; its run journal may still exist)`];
	if (row.assignmentId !== null) {
		lines.unshift(
			`- assignment=${row.assignmentId} status=${row.assignmentStatus ?? "unknown"} terminal=${row.runId}`,
			`  attempts=${row.attemptRunIds.join(",") || "none"}`,
		);
	}
	if (row.evidence.run !== null) {
		lines.push(...runEvidenceLabels(row.evidence.run, row.evidence.integrity).map((label) => `  ${label}`));
	} else {
		const reason = row.evidence.integrity.state === "verified" ? "no settled record" : row.evidence.integrity.reason;
		lines.push(
			row.evidence.integrityFailure
				? `  RUN SEAL FAILED for ${row.runId} (${reason}); its settled facts and worker text are untrusted.`
				: `  run_integrity=unavailable reason=${JSON.stringify(reason)}`,
		);
	}
	if (row.evidence.integrityNote) lines.push(`  ${row.evidence.integrityNote}`);
	lines.push(`  ${workerTextLabel(row.evidence.trustStatus)}`);
	const output = row.evidence.run?.delivered?.output ?? null;
	if (output) {
		const capped = truncateUtf8(
			output.text,
			COLLECT_TEXT_BYTES,
			`\n[preview clipped at ${COLLECT_TEXT_BYTES} bytes; the complete captured text is output.text in ${row.evidence.resultPath ?? "the run's result object"}]`,
		);
		const qualifier = output.state === "partial" ? " (partial; the run did not complete this message)" : "";
		const truncatedNote = output.truncated ? ` (stored output truncated; full text was ${output.bytes} bytes)` : "";
		lines.push(`  agent output${qualifier}${truncatedNote}:`, ...capped.split("\n").map((line) => `  ${line}`));
		if (row.evidence.run) {
			lines.push(
				...workerTextNonEvidenceNotices(row.evidence.run, row.evidence.trustStatus, output.text).map(
					(notice) => `  ${notice}`,
				),
			);
		}
	} else if (row.evidence.run !== null) {
		lines.push("  (no assistant text captured)");
	}
	return lines;
}

function resolveCollectRow(deps: MonitorToolDeps, originalRunId: string, agentId: string): CollectRow {
	const original = deps.dispatch.getRun(originalRunId);
	// The durable assignment record is written asynchronously at admission, so a
	// collect issued in that window sees none yet and reads the attempt directly.
	// terminalRunId is null while the assignment is still running.
	const assignment = deps.dispatch.assignments?.getStored(originalRunId) ?? null;
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
export async function collectRuns(
	deps: MonitorToolDeps,
	batchId: string,
	runIds: ReadonlyArray<string>,
	ownership: DispatchOwnership,
): Promise<ToolResult> {
	let rows: CollectRow[];
	let scope: string;
	let ledgerId: string | null = null;
	if (batchId.length > 0) {
		const detached = deps.dispatch.detached;
		if (!detached) return { kind: "error", message: "monitor: no detached batch records are available in this context" };
		const record = detached.get(batchId);
		if (!record) return { kind: "error", message: `monitor: unknown batch '${batchId}'` };
		// Collecting marks the batch collected and closes its agent ledger, which
		// silences the owner's nudge and ends its peers' board. Only the session
		// that dispatched the batch may do that.
		if (!ownership.ownsBatch(record)) {
			return {
				kind: "error",
				message: `monitor: batch '${batchId}' belongs to another session; only the session that dispatched it can collect it`,
			};
		}
		ledgerId = record.ledgerId ?? null;
		rows = record.runs.map((entry) => resolveCollectRow(deps, entry.assignmentId, entry.agentId));
		scope = `batch ${batchId}${record.collectedAt !== null ? " (already collected)" : ""}`;
	} else {
		rows = runIds.map((runId) => resolveCollectRow(deps, runId, "unknown"));
		const foreign = rows.find((row) => row.run !== null && !ownership.ownsRun(row.run));
		if (foreign !== undefined) {
			return {
				kind: "error",
				message: `monitor: run '${foreign.assignmentId ?? foreign.runId}' belongs to another session; collect only runs this session dispatched`,
			};
		}
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
			'Collect again to keep waiting, or block on a single run with mode="wait".',
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
	const ledgerRuns =
		ledgerId === null ? [] : deps.dispatch.listRuns().filter((run) => run.projection?.ledgerId === ledgerId);
	const settledRuns = new Map(ledgerRuns.map((run) => [run.id, readVerifiedRun(clioStateDir(), run.id)]));
	const readRun = (run: RunEnvelope) => settledRuns.get(run.id) ?? null;
	const board =
		ledgerId === null
			? null
			: renderAgentLedgerBoard(ledgerId, {
					assignments: projectLedgerAssignments(ledgerRuns, readRun),
					receiptFindings: projectReceiptFindings(ledgerRuns, readRun),
				});
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
	];
	return {
		kind: "ok",
		output: lines.join("\n"),
		details: {
			mode: "collect",
			...(() => {
				const carried = mergeFlowRestrictions(
					flowRestrictionsOfRuns(collectedRows.map((row) => row.evidence.run?.facts.flowRestrictions ?? null)),
					...(ledgerId ? (readAgentLedger(ledgerId)?.entries ?? []).map((entry) => entry.flowRestrictions) : []),
				);
				return carried !== null ? { [FLOW_RESTRICTIONS_DETAIL]: carried } : {};
			})(),
			...(batchId.length > 0 ? { batchId, collected } : {}),
			...(board !== null ? { agentLedgerBoard: board } : {}),
			complete: true,
			runCount: rows.length,
			failedCount: failed.length,
			runs: collectedRows.map((row) => {
				const evidenceRun = row.evidence.run;
				const output = evidenceRun?.delivered?.output ?? null;
				const helperResult = evidenceRun === null ? null : runHelperResult(evidenceRun, row.evidence.integrity);
				return {
					...(helperResult !== null ? { helperResult } : {}),
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
					runIntegrity: row.evidence.integrity,
					trustStatus: row.evidence.trustStatus,
					evidenceVerification: evidenceRun?.facts.verification ?? UNVERIFIABLE_RECEIPT_VERIFICATION,
					hostVerification: evidenceRun?.facts.hostVerification ?? null,
					context: evidenceRun?.facts.context ?? null,
					...(output ? { output: { state: output.state, bytes: output.bytes, truncated: output.truncated } } : {}),
				};
			}),
		},
	};
}
