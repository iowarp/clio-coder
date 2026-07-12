/**
 * Receipt-derived evidence metrics for the eval bridge. The sealed receipt is
 * the only source of truth here: dispatch/monitor prose labels are rendering
 * and are never parsed. Every reader is total and fails closed; a missing or
 * malformed receipt yields no metric, so gates on `evidence.*` fail rather
 * than silently pass.
 */

import { readReceiptVerification } from "../../dispatch/receipt-findings.js";
import type { RunReceipt } from "../../dispatch/types.js";

/**
 * Extract the sealed RunReceipt that `clio run --agent … --json` prints after
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
 * Evidence metrics for one sealed receipt. `evidence.verification` reads the
 * integrity-covered field through the shared legacy-safe reader (absent field
 * → "unknown", never "verified"). `evidence.firstPassSuccess` mirrors the
 * durable findings summary and is omitted when the receipt predates it, so a
 * gate on the metric fails closed instead of inventing a value.
 */
export function evidenceMetricsFromReceipt(receipt: RunReceipt): Record<string, string | boolean | number> {
	return {
		"evidence.verification": readReceiptVerification(receipt).state,
		...(receipt.findingsSummary === undefined
			? {}
			: { "evidence.firstPassSuccess": receipt.findingsSummary.firstPassSuccess === true }),
		...(typeof receipt.costUsd === "number" && Number.isFinite(receipt.costUsd) ? { "cost.usd": receipt.costUsd } : {}),
	};
}

/**
 * Count terminal dispatch tool calls in a `clio run --json` stream: the
 * decomposition checkpoint. Mirrors the dedup rules of the tool-call metric
 * fold (canonical clio finishes win over pi execution ends when both exist).
 * An absent or eventless stream counts zero.
 */
export function dispatchCountFromJsonl(stdout: string): number {
	let executionEnds = 0;
	let canonicalFinishes = 0;
	const seenExecutionEnds = new Set<string>();
	const seenCanonicalFinishes = new Set<string>();
	let sawCanonicalFinishEvent = false;
	for (const event of jsonlEvents(stdout)) {
		if (event.type === "tool_execution_end") {
			if (stringField(event, "toolName") !== "dispatch") continue;
			const callId = stringField(event, "toolCallId");
			if (callId !== undefined) {
				if (seenExecutionEnds.has(callId)) continue;
				seenExecutionEnds.add(callId);
			}
			executionEnds += 1;
			continue;
		}
		if (event.type !== "clio_tool_finish" || !isRecord(event.payload)) continue;
		sawCanonicalFinishEvent = true;
		if (stringField(event.payload, "tool") !== "dispatch") continue;
		const callId = stringField(event.payload, "toolCallId") ?? stringField(event, "toolCallId");
		if (callId !== undefined) {
			if (seenCanonicalFinishes.has(callId)) continue;
			seenCanonicalFinishes.add(callId);
		}
		canonicalFinishes += 1;
	}
	return sawCanonicalFinishEvent ? canonicalFinishes : executionEnds;
}

/**
 * Stale-wiki behavioral checkpoint: true when the stream shows a live source
 * read (read/grep start) AFTER a `code_nav mode=wiki` start, i.e. the model
 * did not answer from the wiki alone. Absent either half → false.
 */
export function wikiStaleAcknowledgedFromJsonl(stdout: string): boolean {
	let sawWikiLookup = false;
	for (const event of jsonlEvents(stdout)) {
		if (event.type !== "tool_execution_start") continue;
		const toolName = stringField(event, "toolName");
		if (toolName === "code_nav" && isRecord(event.args) && event.args.mode === "wiki") {
			sawWikiLookup = true;
			continue;
		}
		if (sawWikiLookup && (toolName === "read" || toolName === "grep")) return true;
	}
	return false;
}

function* jsonlEvents(stdout: string): Generator<Record<string, unknown>> {
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) yield parsed;
		} catch {
			// Non-JSON noise (including the pretty receipt tail) is not an event.
		}
	}
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
