import { mentionsWorkerToolCallCap } from "../core/guardrails.js";
import type { RunReceipt, RunReceiptVerification } from "../domains/dispatch/types.js";

/** Matches a source citation the parent can independently spot-check. */
const SOURCE_CITATION_PATTERN = /[\w./~-]+:\d+/;

/**
 * Header for delegated worker text, keyed only on integrity-checked receipt
 * verification. The string is shared by dispatch and monitor so detached
 * collection cannot silently assign a different evidence meaning.
 */
export function workerTextLabel(verification: RunReceiptVerification): string {
	switch (verification.state) {
		case "verified":
			return "worker output (tool-verified):";
		case "not_applicable":
			return "reconnaissance output (advisory leads, not validation evidence):";
		case "unknown":
			return "worker claims (validation not observable at this layer):";
		default:
			return "worker claims (unverified prose):";
	}
}

/**
 * Deterministic framing for text that must not be consumed as results. Every
 * trigger reads sealed receipt fields or machine-written guard diagnostics,
 * never the worker's claims.
 */
export function workerTextNonEvidenceNotices(
	receipt: RunReceipt,
	verification: RunReceiptVerification,
	answerText: string,
): string[] {
	const notices: string[] = [];
	const failedRun = receipt.exitCode !== 0 || (receipt.outcome !== undefined && receipt.outcome !== "succeeded");
	if (mentionsWorkerToolCallCap(receipt.failureMessage) || mentionsWorkerToolCallCap(receipt.outcomeDetail)) {
		notices.push(
			"non-evidence: the worker exhausted its tool-call cap; the text above is a partial synthesis, not verified results.",
		);
	} else if (failedRun) {
		notices.push(
			"non-evidence: this run did not succeed; treat the text above as an unsubstantiated report, not results.",
		);
	}
	if (receipt.toolActivity !== undefined && receipt.toolActivity.succeeded === 0) {
		notices.push("non-evidence: no tool call succeeded in this run; the text above was written without observed work.");
	}
	if (
		!failedRun &&
		verification.state === "not_applicable" &&
		answerText.length > 0 &&
		!SOURCE_CITATION_PATTERN.test(answerText)
	) {
		notices.push(
			"non-evidence: this reconnaissance answer cites no file:line locations; treat its leads as unconfirmed.",
		);
	}
	return notices;
}
