import { mentionsWorkerToolCallCap } from "../core/guardrails.js";
import type { RunReceipt, RunReceiptVerification } from "../domains/dispatch/types.js";

/** Matches a source citation the parent can independently spot-check. */
const SOURCE_CITATION_PATTERN = /([\w./~-]+):(\d+)/g;

export interface SourceCitation {
	path: string;
	line: number;
}

export function sourceCitations(text: string): SourceCitation[] {
	const citations: SourceCitation[] = [];
	for (const match of text.matchAll(SOURCE_CITATION_PATTERN)) {
		const path = match[1];
		const line = Number(match[2]);
		if (path && Number.isSafeInteger(line) && line > 0) citations.push({ path, line });
	}
	return citations;
}

export function hasSourceCitation(text: string): boolean {
	return sourceCitations(text).length > 0;
}

function normalizeSourcePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function sameSourcePath(left: string, right: string): boolean {
	const a = normalizeSourcePath(left);
	const b = normalizeSourcePath(right);
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** True only when the cited path belongs to a read that succeeded in this worker run. */
export function hasVerifiedLiveReadCitation(text: string, liveReadAnchors: ReadonlyArray<string>): boolean {
	const anchorPaths = sourceCitations(liveReadAnchors.join("\n")).map((citation) => citation.path);
	if (anchorPaths.length === 0) return false;
	return sourceCitations(text).some((citation) => anchorPaths.some((path) => sameSourcePath(citation.path, path)));
}

/**
 * Scout handoff grounding contract. Every finding bullet must cite a path
 * observed by a successful live read from this run. Prose-only compact
 * handoffs are accepted when they contain at least one such citation; the
 * `Unresolved gaps:` tail is excluded because it reports non-claims.
 */
export function hasVerifiedScoutGrounding(text: string, liveReadAnchors: ReadonlyArray<string>): boolean {
	if (!hasVerifiedLiveReadCitation(text, liveReadAnchors)) return false;
	const findingText = text.split(/^\s*(?:#{1,6}\s*)?(?:\*\*)?Unresolved gaps:(?:\*\*)?\s*$/im, 1)[0] ?? text;
	const bullets = findingText.split("\n").filter((line) => /^\s*(?:[-*]|\d+[.)])\s+/.test(line));
	if (bullets.length === 0) return true;
	return bullets.every((line) => hasVerifiedLiveReadCitation(line, liveReadAnchors));
}

const UNRESOLVED_GAPS_HEADING = /^\s*(?:#{1,6}\s*)?(?:\*\*)?Unresolved gaps:(?:\*\*)?\s*$/i;
const FINDING_BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/;

/**
 * Preserve useful Scout work without laundering uncited orientation into
 * findings. Mixed handoffs are normalized deterministically: finding bullets
 * backed by successful live-read paths remain in place; every other bullet is
 * moved to `Unresolved gaps:` and labeled as an unverified lead. A handoff
 * with no verified citation still fails the grounding contract.
 */
export function quarantineUnverifiedScoutBullets(text: string, liveReadAnchors: ReadonlyArray<string>): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	const quarantined: string[] = [];
	let unresolved = false;
	for (const line of lines) {
		if (UNRESOLVED_GAPS_HEADING.test(line)) {
			unresolved = true;
			kept.push(line);
			continue;
		}
		const bullet = FINDING_BULLET.exec(line);
		if (!unresolved && bullet) {
			if (hasVerifiedLiveReadCitation(line, liveReadAnchors)) kept.push(line);
			else quarantined.push(bullet[1] ?? line.trim());
			continue;
		}
		kept.push(line);
	}
	if (quarantined.length === 0) return text;
	while (kept.length > 0 && kept[kept.length - 1]?.trim().length === 0) kept.pop();
	if (!kept.some((line) => UNRESOLVED_GAPS_HEADING.test(line))) kept.push("", "Unresolved gaps:");
	for (const lead of quarantined) {
		kept.push(`- Unverified lead (not confirmed by a successful live read): ${lead}`);
	}
	return kept.join("\n");
}

/**
 * Canonical parent spot-check sentence. Dispatch renders it head-anchored;
 * the operating contract, agent catalog, and docs align to it byte-exact so
 * every surface teaches the same discipline.
 */
export const SPOT_CHECK_GUIDANCE =
	'Spot-check delegated claims before repeating them: re-read any cited file:line location, and re-run or inspect the named validation before repeating a "tests pass" claim.';

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
