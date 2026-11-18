import { THINKING_LEVELS, type ThinkingLevel } from "../core/defaults.js";
import { markHostAuthored } from "../core/message-accounting.js";
import type { ResolvedThinkingCapability } from "../domains/providers/model-runtime-capabilities.js";
import type { AgentMessage } from "../engine/types.js";

/**
 * A local reasoning model can spend its whole output cap thinking and stop on
 * `length` with no text and no tool call (WTF-P 0.8.4, nemotron on LM Studio:
 * 57K to 68K characters of re-drafting, then the run failed). Once per
 * operator turn the chat loop drops that reply, reminds the model to act or
 * answer, and runs it one step lower on thinking where the route controls
 * thinking. A second such stop ends the turn (`THINKING_LENGTH_STOP_REASON`).
 */
const THINKING_LENGTH_RECOVERY_TOOL = "clio_thinking_length_reprompt";
export const THINKING_LENGTH_RECOVERY_NOTICE_KEY = "turn.thinking-length-recovery";
export const THINKING_LENGTH_STOP_NOTICE_KEY = "turn.thinking-length-stop";

/**
 * The reminder rides the message tail as a paired synthetic tool exchange, as
 * the repetition nudge does, so the system prompt, the tool schemas and the
 * last user message stay byte-identical for the prompt cache.
 */
export function thinkingLengthRecoveryMessages(origin: {
	provider: string;
	api: string;
	model: string;
}): ReadonlyArray<AgentMessage> {
	const id = `clio-thinking-length-reprompt-${Date.now()}`;
	const timestamp = Date.now();
	return [
		markHostAuthored({
			role: "assistant",
			content: [{ type: "toolCall", id, name: THINKING_LENGTH_RECOVERY_TOOL, arguments: {} }],
			stopReason: "toolUse",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				// Clio wrote this message; no provider was called for it.
				callInvoked: false,
			},
			...origin,
			timestamp,
		} as AgentMessage),
		{
			role: "toolResult",
			toolCallId: id,
			toolName: THINKING_LENGTH_RECOVERY_TOOL,
			content: [
				{
					type: "text",
					text:
						"Your last response hit the output limit while still thinking, before any answer or tool call, so it was discarded. " +
						"Think briefly. Make the next tool call the task needs, or answer now from what you already have.",
				},
			],
			isError: true,
			timestamp,
		},
	] as unknown as ReadonlyArray<AgentMessage>;
}

/**
 * The next supported level below `level`, or `level` itself when the route has
 * no thinking control (`none`, `always-on`) or nothing lower to offer.
 */
export function lowerThinkingLevel(
	level: ThinkingLevel,
	thinking: Pick<ResolvedThinkingCapability, "mechanism" | "supportedLevels">,
): ThinkingLevel {
	if (thinking.mechanism === "none" || thinking.mechanism === "always-on") return level;
	const rank = THINKING_LEVELS.indexOf(level);
	for (let index = rank - 1; index >= 0; index--) {
		const candidate = THINKING_LEVELS[index];
		if (candidate !== undefined && thinking.supportedLevels.includes(candidate)) return candidate;
	}
	return level;
}
