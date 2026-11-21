/**
 * The thinking level a call asked for and the reasoning effort its request carried, so an effort fix can be confirmed
 * from the journal (FX-49). The level is known when the call opens and rides `call.started`. The effort is only
 * decided where a route builds its request, so it is read off the request handed to the provider, rides the terminal
 * message the way the request size does, and reaches `call.settled`.
 */

export const REQUESTED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type RequestedThinkingLevel = (typeof REQUESTED_THINKING_LEVELS)[number];

/** The journaled effort when the request named none. */
export const WIRE_EFFORT_OMITTED = "omitted";
/** An effort as a provider spells it: one short token, never content. */
export const WIRE_EFFORT_PATTERN = "^[A-Za-z0-9_.-]{1,32}$";
const WIRE_EFFORT = new RegExp(WIRE_EFFORT_PATTERN);

/** The `thinkingLevel` fact for a call's start, empty when the value names no level. */
export function requestedThinking(level: unknown): { thinkingLevel?: RequestedThinkingLevel } {
	return typeof level === "string" && (REQUESTED_THINKING_LEVELS as readonly string[]).includes(level)
		? { thinkingLevel: level as RequestedThinkingLevel }
		: {};
}

const field = (value: unknown, key: string): unknown =>
	value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;

/**
 * The effort a request body names, in the spelling it was sent: chat completions `reasoning_effort`, Responses and
 * OpenRouter `reasoning.effort`, Anthropic `output_config.effort`, a Copilot SDK request's `reasoningEffort`, Gemini
 * `thinkingConfig.thinkingLevel`, and the string `thinking` or `think` some chat-completions backends take. A token
 * budget is not an effort.
 */
export function wireEffortOf(payload: unknown): string | undefined {
	const candidates = [
		field(payload, "reasoning_effort"),
		field(field(payload, "reasoning"), "effort"),
		field(field(payload, "output_config"), "effort"),
		field(payload, "reasoningEffort"),
		field(field(payload, "thinkingConfig"), "thinkingLevel"),
		field(field(field(payload, "config"), "thinkingConfig"), "thinkingLevel"),
		field(payload, "thinking"),
		field(payload, "think"),
	];
	return candidates.find((value): value is string => typeof value === "string" && WIRE_EFFORT.test(value));
}

/**
 * Record on a terminal message the effort its request ran under, `omitted` when it named none. A route that states its
 * own effort stamps first and keeps it; the payload seam fills in only an unstamped message.
 */
export function stampWireEffort(message: object, effort: string | undefined): void {
	const stamped = message as { clioCoderWireEffort?: string };
	if (stamped.clioCoderWireEffort !== undefined) return;
	stamped.clioCoderWireEffort = effort !== undefined && WIRE_EFFORT.test(effort) ? effort : WIRE_EFFORT_OMITTED;
}

/** The settled `wireEffort` fact; empty when no request was seen, so an unsent call claims no effort. */
export function wireEffortFact(message: unknown): { wireEffort?: string } {
	const effort = field(message, "clioCoderWireEffort");
	return typeof effort === "string" && WIRE_EFFORT.test(effort) ? { wireEffort: effort } : {};
}
