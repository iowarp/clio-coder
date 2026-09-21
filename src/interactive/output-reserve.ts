/**
 * The one preflight output reservation a turn asks for.
 *
 * Extracted from the submit guard in `chat-loop.ts` so the guard and the live
 * budget view quote the same number instead of growing a second formula. It
 * resolves through `resolveReservedOutputTokens`, which applies the configured
 * output budget, the model's advertised cap, and the remaining-context clamp
 * the `openai-completions` and `ollama-native` transports already perform on
 * the wire. The capability-resolved cap is the input, because that is what the
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

import { resolveReservedOutputTokens } from "../engine/apis/output-budget.js";
import type { AgentRuntime } from "./turn-state.js";

export function resolveTurnOutputReserve(agentRuntime: AgentRuntime, inputTokens: number): number {
	// A runtime resolution always carries capability decisions in production. The
	// optional read is for a partially built runtime: an absent cap is the
	// resolver's own "no advertised limit" case, which falls back to the
	// configured budget and then the product floor, rather than a crash on a path
	// that now runs during ordinary accounting.
	return resolveReservedOutputTokens(agentRuntime.runtimeResolution.capabilityDecisions?.maxTokens, {
		api: agentRuntime.agent.state.model?.api ?? "",
		contextWindow: agentRuntime.runtimeResolution.contextWindowDetails.effectiveContextWindow,
		inputTokens,
	});
}
