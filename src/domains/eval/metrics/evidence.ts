/**
 * Receipt-derived evidence metrics for the eval bridge. The sealed receipt is
 * the only source of truth here: dispatch/monitor prose labels are rendering
 * and are never parsed. Every reader is total and fails closed; a missing or
 * malformed receipt yields no metric, so gates on `evidence.*` fail rather
 * than silently pass.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunEnvelope, RunReceipt } from "../../dispatch/types.js";
import { formatTrustSummary, summarizeTrustStatus } from "../../evidence/trust-projection.js";
import {
	adaptRunReceiptTrustStatus,
	inspectRunReceiptTrustStatus,
	TRUST_STATUS_AXES,
} from "../../evidence/trust-status.js";

function dispatchScopeMetrics(receipt: RunReceipt): Record<string, string | boolean | number> {
	const scope = receipt.pathScope;
	if (scope === undefined) return {};
	const entries = [...scope.workingContextPaths, ...scope.writeBoundaries];
	const evidence = entries.flatMap((entry) => entry.evidence);
	const count = (source: string): number => evidence.filter((entry) => entry.source === source).length;
	return {
		"dispatch.scope.mode": scope.mode,
		"dispatch.scope.inferredPathCount": entries.filter((entry) =>
			entry.evidence.some((item) => item.provenance === "inferred"),
		).length,
		"dispatch.scope.derivedPathCount": entries.filter((entry) =>
			entry.evidence.some((item) => item.provenance === "derived"),
		).length,
		"dispatch.scope.source.task": count("task"),
		"dispatch.scope.source.briefing": count("briefing"),
		"dispatch.scope.source.writeRoots": count("writeRoots"),
	};
}

/**
 * Extract the sealed RunReceipt that `clio-coder run --agent … --json` prints after
 * its single-line JSONL event stream. The receipt is the only multi-line,
 * pretty-printed JSON block in that output, so the last parseable block that
 * carries the receipt's load-bearing fields wins. Returns null (never throws)
 * when no such block exists.
 */
export function receiptFromRunJsonStdout(stdout: string): RunReceipt | null {
	let searchEnd = stdout.length;
	while (searchEnd > 0) {
		const start = stdout.lastIndexOf("\n{", searchEnd - 1);
		if (start === -1) break;
		const candidate = stdout.slice(start + 1);
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (isReceiptShaped(parsed)) return parsed;
		} catch {
			// A JSONL event line or truncated block; keep scanning earlier starts.
		}
		// lastIndexOf clamps a negative fromIndex to 0, so a match at offset 0
		// would repeat forever without this explicit stop.
		if (start === 0) break;
		searchEnd = start;
	}
	return null;
}

function isReceiptShaped(value: unknown): value is RunReceipt {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.runId === "string" &&
		typeof record.agentId === "string" &&
		typeof record.exitCode === "number" &&
		typeof record.integrity === "object" &&
		record.integrity !== null
	);
}

/**
 * Evidence metrics for one sealed receipt. `evidence.verification` is read
 * strictly from `receipt.verification.state`. `evidence.firstPassSuccess`
 * mirrors the durable findings summary and is omitted when that summary is
 * absent, so a gate on the metric fails closed instead of inventing a value.
 */
export function evidenceMetricsFromReceipt(
	receipt: RunReceipt,
	options: { envelope?: RunEnvelope | null } = {},
): Record<string, string | boolean | number> {
	return {
		"evidence.verification": receipt.verification.state,
		...dispatchScopeMetrics(receipt),
		...evidenceTrustMetrics(receipt, options.envelope ?? null),
		...(receipt.findingsSummary === undefined
			? {}
			: { "evidence.firstPassSuccess": receipt.findingsSummary.firstPassSuccess === true }),
		"evidence.quality.typedValidationCount": receipt.quality.typedValidations.length,
		"evidence.responseSchema.digest": receipt.quality.responseSchema.schemaDigest ?? "none",
		...(typeof receipt.costUsd === "number" && Number.isFinite(receipt.costUsd) ? { "cost.usd": receipt.costUsd } : {}),
	};
}

/**
 * The canonical trust status as metrics, so a benchmark table reads the same
 * verdict as every operator surface instead of the raw receipt marker. The
 * receipt is authenticated against its ledger row when the caller can supply
 * one; without a row the canonical model reports the seal unchecked and the
 * receipt-owned axes unobserved, which is the honest answer for a receipt
 * that only ever arrived through stdout.
 */
function evidenceTrustMetrics(
	receipt: RunReceipt,
	envelope: RunEnvelope | null,
): Record<string, string | boolean | number> {
	// A missing row means the seal was never checked, not that it failed:
	// only a row that exists and disagrees can break a seal.
	const status =
		envelope === null ? adaptRunReceiptTrustStatus(receipt) : inspectRunReceiptTrustStatus(receipt, envelope).status;
	const summary = summarizeTrustStatus(status);
	return {
		"evidence.trust.version": summary.version,
		"evidence.trust.verdict": summary.verdict,
		"evidence.trust.summary": formatTrustSummary(status),
		...Object.fromEntries(TRUST_STATUS_AXES.map((axis) => [`evidence.trust.${axis}`, status[axis].state])),
	};
}

/**
 * The ledger row a stdout receipt was sealed from, read from the state dir
 * the run wrote to. Null when the ledger or the row cannot be read; the
 * caller then reports the seal unchecked rather than guessing.
 */
export function readRunEnvelopeForReceipt(receipt: RunReceipt, stateDir: string): RunEnvelope | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(stateDir, "runs.json"), "utf8"));
		if (!Array.isArray(parsed)) return null;
		const row = parsed.find(
			(entry): entry is RunEnvelope =>
				typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === receipt.runId,
		);
		return row ?? null;
	} catch {
		return null;
	}
}
