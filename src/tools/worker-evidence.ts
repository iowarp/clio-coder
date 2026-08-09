import { mentionsWorkerToolCallCap } from "../core/guardrails.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import type { RunReceipt, RunReceiptVerification } from "../domains/dispatch/types.js";

/** Matches a source citation the parent can independently spot-check. */
const SOURCE_CITATION_PATTERN = /([\w./~-]+):(\d+)/g;

export interface SourceCitation {
	path: string;
	line: number;
}

function sourceCitations(text: string): SourceCitation[] {
	const citations: SourceCitation[] = [];
	for (const match of text.matchAll(SOURCE_CITATION_PATTERN)) {
		const path = match[1];
		const line = Number(match[2]);
		if (path && Number.isSafeInteger(line) && line > 0) citations.push({ path, line });
	}
	return citations;
}

function hasSourceCitation(text: string): boolean {
	return sourceCitations(text).length > 0;
}

/**
 * Canonical parent spot-check sentence. Dispatch renders it head-anchored;
 * the operating contract, agent catalog, and docs align to it byte-exact so
 * every surface teaches the same discipline.
 */
export const SPOT_CHECK_GUIDANCE =
	'Spot-check delegated claims before repeating them: re-read any cited file:line location, and re-run or inspect the named validation before repeating a "tests pass" claim.';

/**
 * Model-facing receipt facts. The positive integrity label is reachable only
 * when the caller supplies the result of a successful integrity verification;
 * an embedded digest by itself is never described as verified. Briefing and
 * project context stay separate, and neither line includes prompt prose.
 */
export function receiptEvidenceLabels(
	receipt: RunReceipt,
	verification: RunReceiptVerification,
	integrity: ReceiptIntegrityResult,
): string[] {
	if (!integrity.ok) return [`receipt_integrity=FAILED reason=${JSON.stringify(integrity.reason)}`];
	const briefing =
		receipt.briefing === undefined
			? "briefing=none"
			: `briefing=bytes:${receipt.briefing.bytes} sha256:${receipt.briefing.contentHash}`;
	let projectContext = "project_context=absent";
	if (receipt.projectContext?.tier === "none") {
		projectContext = "project_context=none";
	} else if (receipt.projectContext?.tier === "bounded") {
		projectContext = `project_context=bounded chars:${receipt.projectContext.chars ?? 0}${
			receipt.projectContext.contentHash !== undefined ? ` sha256:${receipt.projectContext.contentHash}` : ""
		}`;
	}
	return [
		`receipt_integrity=verified/v${receipt.integrity.version}/${receipt.integrity.algorithm}`,
		`evidence_verification=${verification.state}/${verification.basis}`,
		briefing,
		projectContext,
	];
}

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
			answerText.length > 0
				? "non-evidence: the worker exhausted its tool-call cap; the text above is a partial synthesis, not verified results."
				: "non-evidence: the worker exhausted its tool-call cap before a final synthesis was captured.",
		);
	} else if (failedRun) {
		notices.push(
			"non-evidence: this run did not succeed; treat the text above as an unsubstantiated report, not results.",
		);
	}
	if (receipt.toolActivity !== undefined && receipt.toolActivity.succeeded === 0) {
		notices.push("non-evidence: no tool call succeeded in this run; the text above was written without observed work.");
	}
	if (!failedRun && verification.state === "not_applicable" && answerText.length > 0 && !hasSourceCitation(answerText)) {
		notices.push(
			"non-evidence: this reconnaissance answer cites no file:line locations; treat its leads as unconfirmed.",
		);
	}
	return notices;
}
