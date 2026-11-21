/**
 * The thinking level a call asked for and the reasoning effort its request carried, so an effort fix can be confirmed
 * from the journal (FX-49). The level is known when the call opens and rides `call.started`. The effort is only
 * decided where a route builds its request, so it is read off the request handed to the provider, rides the terminal
 * message the way the request size does, and reaches `call.settled`. Nothing here throws into the request path.
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

/** One property read; a throwing getter reads as absent. */
const field = (value: unknown, key: string): unknown => {
	if (value === null || typeof value !== "object") return undefined;
	try {
		return (value as Record<string, unknown>)[key];
	} catch {
		return undefined;
	}
};
const effortToken = (value: unknown): string | undefined =>
	typeof value === "string" && WIRE_EFFORT.test(value) ? value : undefined;

/** The effort the last managed-effort entry of a request list names. */
function trailingEffort(list: unknown, effortOfEntry: (entry: unknown) => unknown): string | undefined {
	if (!Array.isArray(list)) return undefined;
	for (let index = list.length - 1; index >= 0; index -= 1) {
		const effort = effortToken(effortOfEntry(list[index]));
		if (effort !== undefined) return effort;
	}
	return undefined;
}

function bodyEffort(body: unknown): string | undefined {
	// A managed-effort body pins its top-level effort for the prompt cache and puts the effort in force in a trailing
	// entry: Anthropic a `system` message with `output_config.effort`, Responses and Codex a `configuration_update`.
	return (
		trailingEffort(field(body, "messages"), (entry) =>
			field(entry, "role") === "system" ? field(field(entry, "output_config"), "effort") : undefined,
		) ??
		trailingEffort(field(body, "input"), (entry) =>
			field(entry, "type") === "configuration_update" ? field(field(entry, "reasoning"), "effort") : undefined,
		) ??
		[
			field(body, "reasoning_effort"),
			field(field(body, "reasoning"), "effort"),
			field(field(body, "output_config"), "effort"),
			field(body, "reasoningEffort"),
			field(field(body, "thinkingConfig"), "thinkingLevel"),
			field(field(field(body, "config"), "thinkingConfig"), "thinkingLevel"),
			field(body, "thinking"),
			field(body, "think"),
		]
			.map(effortToken)
			.find((effort) => effort !== undefined)
	);
}

/**
 * The effort in force for a request body, in the spelling it was sent: a trailing managed-effort entry first, then
 * chat completions `reasoning_effort`, Responses and OpenRouter `reasoning.effort`, Anthropic `output_config.effort`,
 * a Copilot SDK request's `reasoningEffort`, Gemini `thinkingConfig.thinkingLevel`, and the string `thinking` or
 * `think` some chat-completions backends take; Bedrock Converse carries the same fields under
 * `additionalModelRequestFields`. A token budget is not an effort.
 */
export function wireEffortOf(payload: unknown): string | undefined {
	try {
		return bodyEffort(payload) ?? bodyEffort(field(payload, "additionalModelRequestFields"));
	} catch {
		return undefined;
	}
}

/** Set one message fact, skipping a message that cannot take it (null, frozen, sealed or guarded). */
function setFact(message: unknown, key: string, value: unknown): void {
	if (message === null || typeof message !== "object") return;
	try {
		if (Object.isExtensible(message)) (message as Record<string, unknown>)[key] = value;
	} catch {
		// The fact is telemetry; the message is the reply.
	}
}

/**
 * A route that states its own effort claims its terminal message first, so the payload seam never infers one for it:
 * a claimed message carries an effort only once the route stamps it.
 */
export function claimWireEffort(message: unknown): void {
	setFact(message, "clioCoderWireEffortClaimed", true);
}

/** The route's own statement of the effort a request it dispatched ran under, `omitted` when it named none. */
export function stampWireEffort(message: unknown, effort: string | undefined): void {
	setFact(message, "clioCoderWireEffort", effortToken(effort) ?? WIRE_EFFORT_OMITTED);
}

/** The payload seam's reading, for a message no route claimed or stamped. */
export function observeWireEffort(message: unknown, effort: string | undefined): void {
	if (field(message, "clioCoderWireEffortClaimed") === true || field(message, "clioCoderWireEffort") !== undefined)
		return;
	stampWireEffort(message, effort);
}

/** The settled `wireEffort` fact; empty when no request was seen, so an unsent call claims no effort. */
export function wireEffortFact(message: unknown): { wireEffort?: string } {
	const effort = effortToken(field(message, "clioCoderWireEffort"));
	return effort === undefined ? {} : { wireEffort: effort };
}
