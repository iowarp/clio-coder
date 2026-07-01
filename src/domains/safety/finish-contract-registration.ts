/**
 * Finish-contract assessor, packaged as a turn_end hook registration.
 *
 * The chat-loop fires `turn_end` with the final assistant text and this
 * registration emits an advisory `inject_reminder` (severity "warn") when the
 * turn mutated workspace state but recorded no validation evidence and no
 * explicit limitation. The trigger is the observed mutation, not the wording of
 * the assistant's text. The chat-loop's generic effect application renders the
 * notice, persists the session entry, and flushes the reminder into the next
 * model request. Every decision is also written to the audit ledger.
 */

import { VERIFICATION_SCRIPT_FAMILY_HINT } from "../../core/verification-scripts.js";
import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import type { CompletionContractAuditInput } from "./audit.js";
import { assessFinishContract, type FinishContractAssessment } from "./finish-contract.js";
import type { Rigor } from "./rigor.js";

export const FINISH_CONTRACT_REGISTRATION_ID = "assessor.finish-contract";

/**
 * High-rigor re-prompt directive. Injected dynamically via effects (never added
 * to the static system prompt) so the prompt prefix stays byte-stable. It tells
 * the model to validate with a verification-family command or to state what
 * could not be verified before claiming done. The command hint mirrors the
 * vocabulary `detectValidationCommand` and `isVerificationScriptName` accept.
 */
export const HIGH_RIGOR_REVALIDATION_MESSAGE =
	`[Clio Coder] high-rigor finish gate: this completion claim has no validation evidence. ` +
	`Before claiming done, run a verification command (the ${VERIFICATION_SCRIPT_FAMILY_HINT} family, ` +
	`e.g. "npm run test", "npm run lint", "npm run build") or explicitly state what could not be verified ` +
	`and why. Do not end the turn until you have validated or recorded the limitation.`;

export interface CreateFinishContractRegistrationOptions {
	/**
	 * Current session entries for evidence collection, or null when no session
	 * is active. A null return disables assessment for the turn, matching the
	 * former chat-loop guard (`!deps.session?.current()`).
	 */
	readSessionEntries: () => ReadonlyArray<unknown> | null;
	/**
	 * Resolve the effective rigor for the current turn. Optional; defaults to
	 * `"normal"` (today's soft advisory) when absent. At `"high"` an
	 * unvalidated mutation re-prompts the model to validate or state a
	 * limitation instead of merely warning.
	 */
	resolveRigor?: () => Rigor;
	/**
	 * Record the contract's decision to the audit ledger. Optional; when wired
	 * (production passes the safety audit sink), every turn_end decision — each
	 * OK reason and each engagement — is written so the outcome is replayable
	 * from the JSONL alone. Failures here never affect the returned effects.
	 */
	recordDecision?: (input: CompletionContractAuditInput) => void;
}

export function createFinishContractRegistration(
	options: CreateFinishContractRegistrationOptions,
): MiddlewareHookRegistration {
	return {
		id: FINISH_CONTRACT_REGISTRATION_ID,
		description: "advise when a turn mutated files without validation evidence or an explicit limitation",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput, context): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
			if (context?.priorEffects.some(isHardBlockEffect) === true) return [];
			// Only settled stop turns make completion claims; aborted and error
			// turns (including tool-prose interruptions) carry no finish contract.
			// An absent stopReason is treated as "stop", mirroring
			// finalAssistantStopMessage.
			const stopReason = input.metadata?.stopReason;
			if (stopReason !== undefined && stopReason !== "stop") return [];
			const assistantText = input.text?.trim() ?? "";
			if (assistantText.length === 0) return [];
			let entries: ReadonlyArray<unknown> | null;
			try {
				entries = options.readSessionEntries();
			} catch {
				return [];
			}
			if (entries === null) return [];
			const assessment = assessFinishContract({
				assistantText,
				sessionEntries: entries,
				assistantTurnId: input.turnId ?? null,
			});
			const rigor = options.resolveRigor?.() ?? "normal";
			recordDecision(options, input.turnId ?? null, assessment, rigor);
			if (assessment.kind !== "engage") return [];
			if (rigor === "high") {
				// Withhold the completion and force a re-prompt: a continuation
				// request carries the turn onward, and the paired reminder gives
				// the directive its own visible system-reminder line.
				return [
					{ kind: "request_continuation", message: HIGH_RIGOR_REVALIDATION_MESSAGE },
					{ kind: "inject_reminder", message: HIGH_RIGOR_REVALIDATION_MESSAGE, severity: "warn" },
				];
			}
			return [{ kind: "inject_reminder", message: assessment.message, severity: "warn" }];
		},
	};
}

function isHardBlockEffect(effect: MiddlewareEffect): boolean {
	return effect.kind === "block_tool" || (effect.kind === "inject_reminder" && effect.severity === "hard-block");
}

function recordDecision(
	options: CreateFinishContractRegistrationOptions,
	turnId: string | null,
	assessment: FinishContractAssessment,
	rigor: Rigor,
): void {
	if (options.recordDecision === undefined) return;
	const evidenceKinds = Array.from(new Set(assessment.evidence.map((item) => item.kind)));
	try {
		options.recordDecision({
			turnId,
			decision: assessment.kind,
			reason: assessment.reason,
			rigor,
			mutatedPaths: assessment.mutatedPaths,
			evidenceKinds,
		});
	} catch {
		// Audit must never break the hot path; a failed ledger write is silent.
	}
}
