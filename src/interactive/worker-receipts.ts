/**
 * Sealed-receipt reader for worker transcript blocks.
 *
 * The receipt under `<state>/receipts/<runId>.json` is the terminal truth for a
 * dispatched run: the domain writes it before it publishes the run's terminal
 * event, so by the time a transcript wants a footer the file is there. This is
 * the one place that turns it into the compact facts the worker entry renders,
 * shared by the live subscription and by session replay, so both draw the same
 * numbers from the same bytes.
 *
 * Every failure path returns null rather than throwing. A missing or corrupt
 * receipt is an operator-visible state (`receipt unavailable`), never a reason
 * to take down a render.
 */

import { readFileSync } from "node:fs";
import { clioStateDir } from "../core/xdg.js";
import { receiptFilePath } from "./view/artifacts.js";
import type { WorkerReceiptFacts, WorkerResultContract } from "./worker-stream.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function elapsedMsFrom(receipt: Record<string, unknown>): number | undefined {
	const startedAt = Date.parse(String(receipt.startedAt ?? ""));
	const endedAt = Date.parse(String(receipt.endedAt ?? ""));
	if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return undefined;
	return Math.max(0, endedAt - startedAt);
}

/**
 * Result-contract conformance, plus the "unmeasured" case the receipt spells as
 * a null contract fact: a run that never had a typed contract to conform to.
 */
function contractFrom(receipt: Record<string, unknown>): WorkerResultContract | undefined {
	const quality = isRecord(receipt.quality) ? receipt.quality : null;
	if (quality === null) return undefined;
	if (!Object.hasOwn(quality, "resultContract")) return undefined;
	const fact = quality.resultContract;
	if (fact === null) return "unmeasured";
	if (!isRecord(fact)) return undefined;
	const conformance = fact.conformance;
	return conformance === "pass" || conformance === "fail" || conformance === "not-reached" ? conformance : undefined;
}

/**
 * Project a parsed receipt onto the facts a worker block renders. The input is
 * whatever JSON the file held, not a typed {@link RunReceipt}: receipts written
 * by older versions of Clio are still valid history, so every field is read
 * structurally and a missing one degrades the footer rather than the render.
 */
export function workerReceiptFacts(receipt: Record<string, unknown>): WorkerReceiptFacts | null {
	const outcome = optionalString(receipt.outcome);
	if (outcome === undefined) return null;
	const output = isRecord(receipt.output) ? receipt.output : null;
	const contract = contractFrom(receipt);
	const text = optionalString(output?.text);
	const failureMessage = optionalString(receipt.failureMessage);
	const outcomeCode = optionalString(receipt.outcomeCode);
	const exitCode = optionalNumber(receipt.exitCode);
	const tokenCount = optionalNumber(receipt.tokenCount);
	const durationMs = elapsedMsFrom(receipt);
	const toolCalls = optionalNumber(receipt.toolCalls);
	return {
		outcome,
		...(outcomeCode !== undefined ? { outcomeCode } : {}),
		...(failureMessage !== undefined ? { failureMessage } : {}),
		...(exitCode !== undefined ? { exitCode } : {}),
		...(tokenCount !== undefined ? { tokenCount } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(toolCalls !== undefined ? { toolCalls } : {}),
		...(contract !== undefined ? { contract } : {}),
		...(text !== undefined ? { text } : {}),
	};
}

/** Read and project `<state>/receipts/<runId>.json`; null when it is absent or unreadable. */
export function readWorkerReceiptFacts(runId: string, stateDir = clioStateDir()): WorkerReceiptFacts | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(receiptFilePath(stateDir, runId), "utf8"));
		return isRecord(parsed) ? workerReceiptFacts(parsed) : null;
	} catch {
		return null;
	}
}
