import { readFileSync } from "node:fs";
import { projectLedgerAssignments, projectReceiptFindings } from "../domains/dispatch/agent-ledger.js";
import { readAgentLedger, renderAgentLedgerBoard } from "../domains/dispatch/agent-ledger-store.js";
import type { DurableAssignmentRecord } from "../domains/dispatch/assignment-store.js";
import type { DispatchOwnership } from "../domains/dispatch/ownership.js";
import { UNVERIFIABLE_RECEIPT_VERIFICATION } from "../domains/dispatch/receipt-findings.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import type { RunEnvelope, RunReceipt, RunReceiptVerification } from "../domains/dispatch/types.js";
import { isTerminalRunEnvelope } from "../domains/dispatch/types.js";
import type { CanonicalTrustStatus } from "../domains/evidence/trust-status.js";
import { adaptRunReceiptTrustStatus, inspectRunReceiptTrustStatus } from "../domains/evidence/trust-status.js";
import { COST_NOT_MEASURED, costAggregateForAmount, formatCostAggregate } from "../domains/observability/index.js";
import { mergeFlowRestrictions } from "../domains/safety/information-flow.js";
import { flowRestrictionsOfRuns } from "./dispatch-runner.js";
import type { MonitorToolDeps } from "./monitor.js";
import type { ToolResult } from "./registry.js";
import { FLOW_RESTRICTIONS_DETAIL } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";
import {
	compactHelperResultLines,
	receiptEvidenceLabels,
	receiptHelperResult,
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
export function durableRunEvidence(run: RunEnvelope | null): DurableRunEvidence {
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
		// A retired seal is set aside unread, as a missing receipt is. It is
		// not a failed one, so it never reads as tampering here either.
		if (integrity.retired !== undefined) {
			return {
				...unavailableRunEvidence(
					integrity.reason,
					`${integrity.reason}; worker text is unavailable and validation is unknown.`,
				),
				trustStatus: inspection.status,
			};
		}
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
	if (row.evidence.receipt !== null) {
		const helperLines = compactHelperResultLines(row.evidence.receipt, row.evidence.integrity, COLLECT_TEXT_BYTES);
		if (helperLines !== null) return helperLines;
	}
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
		const capped = truncateUtf8(
			output.text,
			COLLECT_TEXT_BYTES,
			`\n[preview clipped at ${COLLECT_TEXT_BYTES} bytes; the complete sealed text is output.text in ${row.run?.receiptPath ?? "the receipt"}]`,
		);
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
	const receipts = new Map(ledgerRuns.map((run) => [run.id, durableRunEvidence(run).receipt]));
	const readReceipt = (run: RunEnvelope) => receipts.get(run.id) ?? null;
	const board =
		ledgerId === null
			? null
			: renderAgentLedgerBoard(ledgerId, {
					assignments: projectLedgerAssignments(ledgerRuns, readReceipt),
					receiptFindings: projectReceiptFindings(ledgerRuns, readReceipt),
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
					flowRestrictionsOfRuns(collectedRows.map((row) => row.evidence.receipt)),
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
				const output = row.evidence.output;
				const helperResult =
					row.evidence.receipt === null ? null : receiptHelperResult(row.evidence.receipt, row.evidence.integrity);
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
