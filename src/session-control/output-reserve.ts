/**
 * The one preflight output reservation a turn asks for.
 *
 * Extracted from the submit guard in `chat-loop.ts` so the guard and the live
 * budget view quote the same number instead of growing a second formula. It
 * resolves through `resolveReservedOutputTokens`, which applies the configured
 * output budget, the model's advertised cap, and the remaining-context clamp
 * the `openai-completions` and `ollama-native` transports already perform on
 * the wire, bounded below by a usable response floor plus that clamp's margin.
 * The capability-resolved cap is the input, because that is what the
 * runtime resolution decided this target may actually be asked for.
 *
 * This is a preflight reservation, not a guarantee of the final wire ceiling:
 * `remainingContextMaxTokens` re-derives the ceiling at request time against
 * the context the transport is about to send.
 *
 * It is not the compaction-threshold reserve. `ContextSnapshot.categories.reserve`
 * is window headroom held back so auto-compaction fires before a request is
 * refused, and the two figures are unrelated.
 */

import { runOverrides } from "../core/run-overrides.js";
import { fitOutputReserve } from "../domains/context/fold/pressure.js";
import {
	ADMISSIBLE_OUTPUT_RESERVE,
	configuredMaxOutputTokens,
	requestOutputReserve,
} from "../engine/apis/output-budget.js";
import type { AgentRuntime } from "./turn-state.js";

type ReserveRuntime = {
	runtimeResolution: AgentRuntime["runtimeResolution"];
	agent: { state: { model: AgentRuntime["agent"]["state"]["model"] } };
};

export function resolveTurnOutputReserve(agentRuntime: ReserveRuntime, inputTokens: number): number {
	// A runtime resolution always carries capability decisions in production. The
	// optional read is for a partially built runtime: an absent cap is the
	// resolver's own "no advertised limit" case, which falls back to the
	// configured budget and then the product floor, rather than a crash on a path
	// that now runs during ordinary accounting.
	return requestOutputReserve(
		agentRuntime.agent.state.model,
		agentRuntime.runtimeResolution.capabilityDecisions?.maxTokens,
		agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
		inputTokens,
	);
}

/**
 * The output reserve every physical fit check counts: the post-tool guard and its
 * stop, the fold's fit checks, the live view and pre-stream admission. It is the
 * turn reserve except on an uncapped window under 52,428 tokens, where it is the
 * admissible reserve, so the fit line sits above the automatic trigger the turn
 * reserve still drives (ContextFold A5).
 */
export function resolveFitOutputReserve(agentRuntime: ReserveRuntime, inputTokens: number): number {
	return fitOutputReserve({
		window: agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
		turnReserve: resolveTurnOutputReserve(agentRuntime, inputTokens),
		admissibleReserve: ADMISSIBLE_OUTPUT_RESERVE,
		hardReserve: configuredMaxOutputTokens() !== null,
	});
}

/**
 * What the operator can change when a turn does not fit its window (bt-13).
 * A configured chat.maxOutputTokens above half the window, or a window this run
 * capped with --max-context-tokens, is named; otherwise the prompt itself is too
 * large for the window.
 */
export function turnAdmissionRemedy(agentRuntime: ReserveRuntime, inputTokens: number): string {
	const details = agentRuntime.runtimeResolution.contextWindowDetails;
	const window = details.effectiveContextWindow;
	const remedies: string[] = [];
	const configured = configuredMaxOutputTokens();
	const reserve = resolveTurnOutputReserve(agentRuntime, inputTokens);
	if (configured !== null && reserve > Math.floor(window / 2)) {
		remedies.push(`chat.maxOutputTokens reserves ${reserve} of the ${window}-token window; lower it.`);
	}
	const cap = runOverrides().maxContextTokens;
	if (
		cap !== undefined &&
		cap === window &&
		(details.desiredContextWindow === 0 || cap < details.desiredContextWindow)
	) {
		remedies.push(`This run caps the window at ${cap} tokens; raise --max-context-tokens.`);
	}
	return remedies.length > 0 ? remedies.join(" ") : "Trim the prompt or reduce active tools.";
}
