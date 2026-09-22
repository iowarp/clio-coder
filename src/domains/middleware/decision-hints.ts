import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

/**
 * Delivers the pre-turn decision sites' hints to the main agent.
 *
 * The hints ride in the submitted user message, the same channel every
 * turn_start reminder uses, so the cached prefix (tools, system prompt,
 * earlier turns) never changes because a decision model had an opinion. A
 * hint informs the main agent and nothing else: no tool is removed, no call is
 * gated, and the agent stays responsible for what it does with the line.
 *
 * This registration knows nothing about which sites exist. The composition
 * root hands it the rendered lines for the turn, so a new site adds a hint
 * without touching middleware.
 */

export const DECISION_HINTS_REGISTRATION_ID = "observer.decision-hints";

export interface DecisionHintsDeps {
	/** This turn's hint lines, already rendered. Empty when no site had one. */
	getHints(): ReadonlyArray<string>;
	/** Explicit host scope for the turn; when present it already says what the turn is. */
	getTurnConstraints?(): TurnConstraints | undefined;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

export function createDecisionHintsRegistration(deps: DecisionHintsDeps): MiddlewareHookRegistration {
	return {
		id: DECISION_HINTS_REGISTRATION_ID,
		description: "passes the bound decision sites' pre-turn hints to the main agent",
		hooks: ["turn_start"],
		evaluate(input) {
			// A continuation carries a nudge rather than the operator's request, so a
			// judgment about the request would be a judgment about the nudge.
			if (input.metadata?.requestContinuation === true) return NO_EFFECTS;
			// A host that scoped the turn explicitly has already said what it is. A
			// second opinion on the same question could only contradict it.
			if (deps.getTurnConstraints?.() !== undefined) return NO_EFFECTS;
			let hints: ReadonlyArray<string>;
			try {
				hints = deps.getHints();
			} catch {
				return NO_EFFECTS;
			}
			if (hints.length === 0) return NO_EFFECTS;
			return [{ kind: "inject_reminder", severity: "info", message: hints.join("\n") }];
		},
	};
}
