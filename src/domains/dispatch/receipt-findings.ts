/**
 * Cheap, pure findings classifier for the durable receipt summary (v0.2.7
 * Slice 3). It maps the signals already present on a receipt draft and its
 * ledger envelope -- outcome, outcomeDetail, exitCode, toolStats, toolActivity
 * -- to a conservative subset of the canonical EvidenceTag taxonomy.
 *
 * This is deliberately NOT buildEvidence. The forensic aggregator reads the
 * persisted receipt, so calling it at record time would create a cycle. This
 * classifier only inspects in-memory draft fields, emits a tag only when the
 * data justifies it, and keeps the result JSON-clean (stably ordered tag array,
 * boolean firstPassSuccess, finite findingCount) so the v3 integrity digest can
 * fold it without hitting a non-finite or undefined value.
 */

import { type EvidenceTag, FAILURE_CAUSE_TAG_ORDER, FAILURE_CAUSE_TAGS } from "../evidence/index.js";
import type { RunEnvelope, RunReceiptDraft, RunReceiptFindingsSummary, RunReceiptVerification } from "./types.js";

function lower(value: string | null | undefined): string {
	return (value ?? "").toLowerCase();
}

function toolNamesLower(draft: RunReceiptDraft): string[] {
	return draft.toolStats.map((stat) => stat.tool.toLowerCase());
}

function anyToolMatches(toolNames: string[], needles: readonly string[]): boolean {
	return toolNames.some((name) => needles.some((needle) => name.includes(needle)));
}

function blockedCount(draft: RunReceiptDraft): number {
	const fromStats = draft.toolStats.reduce((total, stat) => total + stat.blocked, 0);
	const fromActivity = draft.toolActivity?.blocked ?? 0;
	return Math.max(fromStats, fromActivity);
}

const TEST_TOOL_NEEDLES = ["pytest", "ctest", "jest", "vitest", "test", "lint", "typecheck"] as const;
const BUILD_TOOL_NEEDLES = ["build", "compile", "make", "cmake", "cargo", "gradle", "ninja", "tsc"] as const;
const VALIDATION_TOOL_NEEDLES = [
	"pytest",
	"ctest",
	"jest",
	"vitest",
	"test",
	"lint",
	"typecheck",
	"check",
	"ci",
	"validate",
	"verify",
] as const;

/**
 * Emit the conservative failure-cause tags justified by the draft + envelope.
 * Only signals that are unambiguous in the available data produce a tag.
 */
function classifyTags(draft: RunReceiptDraft, envelope: RunEnvelope): Set<EvidenceTag> {
	const tags = new Set<EvidenceTag>();
	const outcome = draft.outcome ?? envelope.outcome ?? null;
	const detail = lower(draft.outcomeDetail ?? envelope.outcomeDetail);
	const failureText = `${lower(draft.failureMessage)} ${detail}`;
	const exitCode = draft.exitCode;
	const nonzeroExit = Number.isFinite(exitCode) && exitCode !== 0;
	const toolNames = toolNamesLower(draft);

	// Timeout: an explicit timed_out/stalled outcome, or timeout language in the
	// detail/failure text.
	if (outcome === "timed_out" || outcome === "stalled") {
		tags.add("timeout");
	} else if (failureText.includes("timed out") || failureText.includes("timeout")) {
		tags.add("timeout");
	}

	// Auth failure: credential/api-key/auth language in the failure text.
	if (
		failureText.includes("auth") ||
		failureText.includes("api key") ||
		failureText.includes("credential") ||
		failureText.includes("unauthorized")
	) {
		tags.add("auth-failure");
	}

	// Missing dependency: explicit dependency/module-not-found language.
	if (
		failureText.includes("module not found") ||
		failureText.includes("missing package") ||
		failureText.includes("missing dependency")
	) {
		tags.add("missing-dependency");
	}

	// Blocked tool: any blocked attempt recorded in stats or activity totals.
	if (blockedCount(draft) > 0) {
		tags.add("blocked-tool");
	}

	// Build/test failure: a nonzero exit paired with a build/test command in the
	// tool stats. Build takes precedence when both appear, matching the forensic
	// classifier's ordering.
	if (nonzeroExit) {
		if (anyToolMatches(toolNames, BUILD_TOOL_NEEDLES)) {
			tags.add("build-failure");
		} else if (anyToolMatches(toolNames, TEST_TOOL_NEEDLES)) {
			tags.add("test-failure");
		}
	}

	return tags;
}

export function hasValidationEvidence(draft: Pick<RunReceiptDraft, "toolStats">): boolean {
	return draft.toolStats.some((stat) => {
		if (stat.ok <= 0 || stat.errors > 0) return false;
		const tool = stat.tool.toLowerCase();
		return VALIDATION_TOOL_NEEDLES.some((needle) => tool.includes(needle));
	});
}

/**
 * Derive the receipt's descriptive evidence-confidence marker without
 * changing execution semantics. ACP agents may validate externally, so lack
 * of Clio-observed validation is unknown rather than a negative assertion.
 */
export function deriveReceiptVerification(
	draft: Pick<RunReceiptDraft, "toolStats">,
	context: { capabilityClass?: string | null; acpDelegation?: boolean } = {},
): RunReceiptVerification {
	if (context.capabilityClass === "read-only") {
		return { state: "not_applicable", basis: "read-only-agent" };
	}
	if (hasValidationEvidence(draft)) {
		return { state: "verified", basis: "validation-tool" };
	}
	if (context.acpDelegation === true) {
		return { state: "unknown", basis: "acp-external-unobserved" };
	}
	return { state: "unverified", basis: "no-validation-tool" };
}

/**
 * Evidence confidence when no sealed receipt can be read: the run has none, or
 * its integrity check failed, so nothing it claims may be reported as verified.
 */
export const UNVERIFIABLE_RECEIPT_VERIFICATION: RunReceiptVerification = {
	state: "unknown",
	basis: "receipt-unavailable",
};

/**
 * Compute the durable findings summary for a receipt draft. Pure and cheap:
 * inspects only in-memory fields, never reads disk or calls buildEvidence.
 *
 * firstPassSuccess (per spec section 7) requires a succeeded outcome, zero
 * dispatch retries (lineage.attempt === 0), a cheap positive validation signal
 * in the receipt stats, and no failure-cause tag. Absent draft lineage falls
 * back to the envelope before treating the run as attempt 0.
 */
export function computeReceiptFindingsSummary(
	draft: RunReceiptDraft,
	envelope: RunEnvelope,
): RunReceiptFindingsSummary {
	const detected = classifyTags(draft, envelope);
	const tags = FAILURE_CAUSE_TAG_ORDER.filter((tag) => detected.has(tag));

	const outcome = draft.outcome ?? envelope.outcome ?? null;
	const attempt = draft.lineage?.attempt ?? envelope.lineage?.attempt ?? 0;
	const hasFailureCause = tags.some((tag) => FAILURE_CAUSE_TAGS.has(tag));
	const firstPassSuccess = outcome === "succeeded" && attempt === 0 && hasValidationEvidence(draft) && !hasFailureCause;

	return {
		tags,
		firstPassSuccess,
		findingCount: tags.length,
	};
}
