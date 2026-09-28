import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

export const CI_DISPUTE_REMINDER =
	"[CI evidence] This question is about a reported red CI run. Check whether the alleged earlier assistant claim appears in this conversation; do not own an unseen claim. Inspect the specific CI run through the available CI capability. Local tests cannot establish why CI is red, so do not run them for this answer unless the operator asks for a local comparison. If one targeted CI lookup cannot identify the run, state the limit and request its link or ID through ask_user when available. Do not search unrelated local files or session history for a substitute explanation.";

function isCiDispute(text: string): boolean {
	return (
		/\b(?:ci|continuous integration)\b/iu.test(text) &&
		/\b(?:red|fail(?:ed|ing|ure)?|broken)\b/iu.test(text) &&
		/\b(?:tests?|passed?|green)\b/iu.test(text)
	);
}

/** A narrow turn reminder keeps a disputed CI claim tied to CI evidence. */
export function createCiDisputeRegistration(): MiddlewareHookRegistration {
	return {
		id: "nudge.ci-dispute",
		description: "route disputed CI claims to the CI run before local tests",
		hooks: ["turn_start"],
		evaluate(input): ReadonlyArray<MiddlewareEffect> {
			if (input.hook !== "turn_start" || input.metadata?.requestContinuation === true) return [];
			return isCiDispute(input.text ?? "") ? [{ kind: "inject_reminder", message: CI_DISPUTE_REMINDER }] : [];
		},
	};
}
