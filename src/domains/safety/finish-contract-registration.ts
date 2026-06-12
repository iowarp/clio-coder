/**
 * Finish-contract assessor, packaged as a turn_end hook registration.
 *
 * Replaces the chat-loop's bespoke `emitFinishContractAdvisory` call site: the
 * chat-loop fires `turn_end` with the final assistant text and this
 * registration emits an advisory `inject_reminder` (severity "warn") when a
 * completion claim has no recent validation evidence and no explicit
 * limitation. The chat-loop's generic effect application renders the notice,
 * persists the session entry, and flushes the reminder into the next model
 * request.
 */

import type { MiddlewareEffect, MiddlewareHookInput, MiddlewareHookRegistration } from "../middleware/index.js";
import { assessFinishContract } from "./finish-contract.js";

export const FINISH_CONTRACT_REGISTRATION_ID = "assessor.finish-contract";

export interface CreateFinishContractRegistrationOptions {
	/**
	 * Current session entries for evidence collection, or null when no session
	 * is active. A null return disables assessment for the turn, matching the
	 * former chat-loop guard (`!deps.session?.current()`).
	 */
	readSessionEntries: () => ReadonlyArray<unknown> | null;
}

export function createFinishContractRegistration(
	options: CreateFinishContractRegistrationOptions,
): MiddlewareHookRegistration {
	return {
		id: FINISH_CONTRACT_REGISTRATION_ID,
		description: "advise when a completion claim lands without validation evidence or an explicit limitation",
		hooks: ["turn_end"],
		evaluate(input: MiddlewareHookInput): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_end") return [];
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
			if (assessment.kind !== "advisory") return [];
			return [{ kind: "inject_reminder", message: assessment.message, severity: "warn" }];
		},
	};
}
