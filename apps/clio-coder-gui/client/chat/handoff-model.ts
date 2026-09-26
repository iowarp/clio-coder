// What a handoff says at each step, before any of it is drawn. Refusal codes come from the shared
// session service; the words here tell a person what happened and what, if anything, was written.

import type { HandoffRefused } from "../../contracts/handoff.js";

/** The runtime's own floor (`HANDOFF_MIN_GOAL_LENGTH`); the button waits for it rather than spending a round. */
export const HANDOFF_MIN_GOAL = 12;

const TITLES: Record<string, string> = {
	goal: "Say what the next conversation should accomplish",
	turn_in_flight: "Wait for the current turn to finish",
	no_session: "There is no conversation to hand off",
	extraction: "Clio Coder could not draw up the handoff",
	provider: "The model round failed",
	empty: "The reviewed document is empty",
	stale: "The conversation moved on",
	busy: "A handoff is already being drawn up",
	seed_failed: "The new conversation could not be started",
	too_large: "The handoff document is too large",
	unavailable: "Handoff is not available here",
};

export function handoffRefusal(refusal: HandoffRefused): { tone: "warning" | "error"; title: string; detail: string } {
	const sentence = refusal.reason.charAt(0).toUpperCase() + refusal.reason.slice(1);
	return {
		tone: refusal.level === "error" ? "error" : "warning",
		title: TITLES[refusal.code] ?? "Clio Coder refused the handoff",
		detail: /[.!?]$/.test(sentence) ? sentence : `${sentence}.`,
	};
}

export function handoffDone(warnings: readonly string[]): {
	title: string;
	detail: string;
	warning: { title: string; detail: string } | null;
} {
	return {
		title: "Handed off",
		detail: "The new conversation starts from the reviewed document.",
		warning:
			warnings.length === 0
				? null
				: {
						title: "The earlier conversation was not fully updated",
						detail: `${warnings.join("; ")}. The new conversation is seeded and is where to continue.`,
					},
	};
}
