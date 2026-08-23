import { mentionsWorkerToolCallCap } from "../core/guardrails.js";
import {
	formatBudgetPolicy,
	formatBudgetReasons,
	formatBudgetRequest,
	formatEffectiveBudget,
} from "../domains/dispatch/budget-envelope.js";
import type { ReceiptIntegrityResult } from "../domains/dispatch/receipt-integrity.js";
import type { RunReceipt, RunReceiptVerification } from "../domains/dispatch/types.js";
import { adaptRunReceiptTrustStatus, type CanonicalTrustStatus } from "../domains/evidence/trust-status.js";
import { receiptResponseModelIdObservationLabel } from "./dispatch-event-text.js";

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
 * Whether this run was dispatched as work that has to change the tree. Read
 * from sealed fields only: the execution role a mutation-capable recipe
 * derives, or a mutation-shaped result contract. A verifier asked to edit
 * keeps its own role, so this is deliberately narrow; the activity and
 * first-pass labels below carry the honest signal for every other class.
 */
function isMutationClassRun(receipt: RunReceipt, status: CanonicalTrustStatus): boolean {
	// A read-only agent seals `not_applicable`; recon that changes nothing is
	// the expected outcome there, not a missing effect.
	if (status.validationGrounding.state === "not_applicable") return false;
	if (receipt.executionRole === "builder" || receipt.executionRole === "recovery") return true;
	return receipt.quality?.resultContract?.sourceId?.startsWith("agent-result-contract:mutation-report") === true;
}

/**
 * Facts the harness knew before or independently of the worker's account of
 * itself: the capability/task pairing it was admitted under, and how many of
 * its passing validation claims correspond to a command it actually ran. Both
 * exist because a live verifier run sealed `exit=0 ... failed=0` on a
 * fabricated `npm run typecheck` for a script that does not exist, and neither
 * honest signal reached the line the orchestrator reads.
 */
function receiptAdmissionLabels(receipt: RunReceipt): string[] {
	const labels: string[] = [];
	const mismatch = receipt.capabilityMismatch;
	if (mismatch !== undefined) {
		labels.push(
			`capability_mismatch=${mismatch.capabilityClass}/${mismatch.taskType}${
				mismatch.suggestedAgentId === null ? "" : ` suggested:${mismatch.suggestedAgentId}`
			}`,
		);
	}
	const grounding = receipt.validationGrounding;
	if (grounding !== undefined) {
		labels.push(
			`validations=claimed:${grounding.claimed} grounded:${grounding.grounded}${
				grounding.ungrounded.length > 0
					? ` ${grounding.basis === "no-command-executed" ? "unverifiable" : "unmatched"}:${grounding.ungrounded
							.map((name) => JSON.stringify(name))
							.join(",")}`
					: ""
			}`,
		);
	}
	return labels;
}

/**
 * Sealed work facts for the run line. `exit=0` alone has proven to be a
 * misleading headline: a worker that never executed a call, or whose every
 * mutating call was blocked, still exits 0 and still claims in prose that it
 * fixed the file. These labels are the receipt's own counters, so the parent
 * sees the shape of the run before it reads the worker's account of it.
 */
function receiptActivityLabels(receipt: RunReceipt, status: CanonicalTrustStatus): string[] {
	const labels: string[] = [];
	const activity = receipt.toolActivity;
	if (activity !== undefined) {
		labels.push(
			`work=calls:${activity.calls} ok:${activity.succeeded} failed:${activity.failed} blocked:${activity.blocked} mutations:${
				activity.mutatingSucceeded ? "yes" : "no"
			}`,
		);
		// The case this whole label set exists for: the task was to change
		// something and nothing changed, under an exit code that says success.
		if (!activity.mutatingSucceeded && isMutationClassRun(receipt, status)) labels.push("mutation_effect=none");
	}
	const findings = receipt.findingsSummary;
	if (findings !== undefined) {
		if (!findings.firstPassSuccess) labels.push("first_pass=false");
		if (findings.tags.length > 0) labels.push(`findings=${[...findings.tags].sort().join(",")}`);
	}
	return labels;
}

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
	const status = adaptRunReceiptTrustStatus({ ...receipt, verification }, { integrity });
	const canonical = canonicalTrustLabel(status);
	if (!integrity.ok) {
		return [canonical, `receipt_integrity=FAILED reason=${JSON.stringify(integrity.reason)}`];
	}
	const briefing =
		receipt.briefing === undefined
			? "briefing=none"
			: `briefing=bytes:${receipt.briefing.bytes} sha256:${receipt.briefing.contentHash}`;
	let projectContext = "project_context=absent";
	if (receipt.projectContext !== undefined) {
		const sections = receipt.projectContext.sections ?? [];
		projectContext = `project_context=${receipt.projectContext.tier} chars:${receipt.projectContext.chars ?? 0}${
			sections.length > 0 ? ` sections:${[...sections].sort().join(",")}` : ""
		}${receipt.projectContext.contentHash !== undefined ? ` sha256:${receipt.projectContext.contentHash}` : ""}`;
	}
	const responseModelIdObservation = receiptResponseModelIdObservationLabel(receipt);
	const budget =
		receipt.budget === undefined
			? []
			: [
					`budget_recipe_policy=${JSON.stringify(formatBudgetPolicy(receipt.budget))}`,
					`budget_requested=${JSON.stringify(formatBudgetRequest(receipt.budget))}`,
					`budget_effective=${JSON.stringify(formatEffectiveBudget(receipt.budget))}`,
					`budget_reason=${JSON.stringify(formatBudgetReasons(receipt.budget))}`,
				];
	return [
		canonical,
		`receipt_integrity=verified/v${receipt.integrity.version}/${receipt.integrity.algorithm}`,
		`evidence_verification=${verification.state}/${verification.basis}`,
		...(responseModelIdObservation ? [responseModelIdObservation] : []),
		...budget,
		...receiptAdmissionLabels(receipt),
		...receiptActivityLabels(receipt, status),
		briefing,
		projectContext,
	];
}

function canonicalTrustLabel(status: CanonicalTrustStatus): string {
	return [
		`trust_status=v${status.version}`,
		`artifactIntegrity:${status.artifactIntegrity.state}`,
		`validationGrounding:${status.validationGrounding.state}`,
		`independentReview:${status.independentReview.state}`,
		`contextProvenance:${status.contextProvenance.state}`,
		`autonomyEnforcement:${status.autonomyEnforcement.state}`,
		`completionEvidence:${status.completionEvidence.state}`,
	].join(" ");
}

/**
 * Header for delegated worker text, keyed only on integrity-checked receipt
 * verification. The string is shared by dispatch and monitor so detached
 * collection cannot silently assign a different evidence meaning.
 */
export function workerTextLabel(status: CanonicalTrustStatus): string {
	switch (status.validationGrounding.state) {
		case "validated":
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
	status: CanonicalTrustStatus,
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
	} else if (receipt.toolActivity?.mutatingSucceeded === false && isMutationClassRun(receipt, status)) {
		// A live verifier run returned {"verdict":"pass"} for a check it never
		// ran, on a script that does not exist, at exit 0. The parent recovered
		// only because it independently diffed the tree; say so on the line.
		notices.push(
			"non-evidence: this run was dispatched as work that changes the tree, but no mutating tool call succeeded. Nothing was written. Confirm with a diff before repeating any claim that something was fixed.",
		);
	}
	const grounding = receipt.validationGrounding;
	if (grounding !== undefined && grounding.ungrounded.length > 0) {
		const named = grounding.ungrounded.map((name) => JSON.stringify(name)).join(", ");
		notices.push(
			grounding.basis === "no-command-executed"
				? `non-evidence: this run reported ${named} as passing and executed no command at all. Re-run the check yourself before repeating the claim.`
				: `non-evidence: this run reported ${named} as passing through a command the harness cannot identify as that check. Re-run it before repeating the claim.`,
		);
	}
	if (receipt.capabilityMismatch !== undefined) {
		notices.push(
			`non-evidence: '${receipt.capabilityMismatch.agentId}' is a ${receipt.capabilityMismatch.capabilityClass} recipe and cannot write to the workspace, but this task classified as ${receipt.capabilityMismatch.taskType}. Nothing it reports as changed can have been changed by it.`,
		);
	}
	if (
		!failedRun &&
		status.validationGrounding.state === "not_applicable" &&
		answerText.length > 0 &&
		!hasSourceCitation(answerText)
	) {
		notices.push(
			"non-evidence: this reconnaissance answer cites no file:line locations; treat its leads as unconfirmed.",
		);
	}
	return notices;
}
