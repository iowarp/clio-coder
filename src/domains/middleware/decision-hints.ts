import type { TurnConstraints } from "../../core/turn-constraints.js";
import type { MiddlewareHookRegistration } from "./runtime.js";
import type { MiddlewareEffect } from "./types.js";

/**
 * Delivers the turn site's hint lines to the main agent.
 *
 * The hints ride in the submitted user message, the same channel every
 * turn_start reminder uses, so the cached prefix (tools, system prompt,
 * earlier turns) never changes because a decision model had an opinion. A
 * hint informs the main agent and nothing else: no tool is removed, no call is
 * gated, and the agent stays responsible for what it does with the line.
 *
 * The lines arrive already rendered and already past the site's fitted cuts,
 * so an unbound, slow or unfitted site simply hands over nothing.
 */

export const DECISION_HINTS_REGISTRATION_ID = "observer.decision-hints";

/** The hint lines a turn verdict carries; each is null when the site's policy stayed silent. */
export interface DecisionHintLines {
	readonly scope: string | null;
	readonly plan: string | null;
}

export interface DecisionHintsDeps {
	/** This turn's hint lines, or null when no site answered. */
	getHints(): DecisionHintLines | null;
	/** True when the turn controller already started harness work for this turn. */
	controllerActed?: () => boolean;
	/** Explicit host scope for the turn; when present it already says what the turn is. */
	getTurnConstraints?(): TurnConstraints | undefined;
}

const NO_EFFECTS: ReadonlyArray<MiddlewareEffect> = [];

export function createDecisionHintsRegistration(deps: DecisionHintsDeps): MiddlewareHookRegistration {
	return {
		id: DECISION_HINTS_REGISTRATION_ID,
		description: "passes the turn site's hints to the main agent",
		hooks: ["turn_start"],
		evaluate(input) {
			// A continuation carries a nudge rather than the operator's request, so a
			// judgment about the request would be a judgment about the nudge.
			if (input.metadata?.requestContinuation === true) return NO_EFFECTS;
			// A host that scoped the turn explicitly has already said what it is. A
			// second opinion on the same question could only contradict it.
			if (deps.getTurnConstraints?.() !== undefined) return NO_EFFECTS;
			const lines: string[] = [];
			try {
				const hints = deps.getHints();
				if (hints === null) return NO_EFFECTS;
				if (hints.scope !== null) lines.push(hints.scope);
				// A controller that already ran the orientation or collected the batch
				// has made the plan for the turn; a delegation hint would second-guess it.
				if (hints.plan !== null && deps.controllerActed?.() !== true) lines.push(hints.plan);
			} catch {
				return NO_EFFECTS;
			}
			if (lines.length === 0) return NO_EFFECTS;
			return [{ kind: "inject_reminder", severity: "info", message: lines.join("\n") }];
		},
	};
}
