import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "../context.js";
import type { CodexConfiguration } from "../types.js";

type Payload = Record<string, unknown>;
function record(value: unknown): value is Payload {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Host metadata survives Pi's user-message copies but is omitted by its wire converter (#423). */
export function codexUserTurn(message: unknown): string | undefined {
	return record(message) && message.role === "user" && typeof message.clioCodexTurnId === "string"
		? message.clioCodexTurnId
		: undefined;
}

export function bindCodexUserTurn(message: unknown, turnId: string): void {
	if (record(message) && message.role === "user") message.clioCodexTurnId = turnId;
}

/**
 * Replay updates before their user boundary, including full resends and retries (#423).
 *
 * Measured on gpt-6-luna over SSE, 2026-10-30: a body that differed from the previous one only in top-level
 * reasoning.effort read 0 of 5,635 prompt tokens, and switching the effort back read 0 again, so the backend keeps
 * one entry per prompt_cache_key tagged with the top-level effort. With the effort pinned to the generation's
 * initial value and the change carried by a configuration_update item, the next request read 5,504 of 5,686
 * (the full 128-aligned prefix), as did the identical requests after it.
 */
export function withCodexConfiguration<T extends StreamOptions | SimpleStreamOptions>(
	model: Model<Api>,
	options: T | undefined,
	context?: Context,
): T | undefined {
	const configuration = (options as (T & { codexConfiguration?: CodexConfiguration }) | undefined)?.codexConfiguration;
	if (model.api !== "openai-codex-responses" || !configuration) return options;
	const previous = options?.onPayload;
	// Resolve identities against the final native request, after reminders/steering (#423).
	const users = context
		? normalizeContext(context).messages.filter(
				(message) => message.role === "user" && (typeof message.content === "string" || message.content.length > 0),
			)
		: [];
	const updates = new Map(configuration.updates.map((update) => [update.position, update.effort]));
	return {
		...options,
		onPayload: async (payload: unknown, currentModel: Model<Api>) => {
			const base = (await previous?.(payload, currentModel)) ?? payload;
			if (!record(base) || !Array.isArray(base.input) || !record(base.reasoning)) return base;
			const input: unknown[] = [];
			let position = 0;
			let effective = configuration.initialEffort;
			for (const item of base.input) {
				if (record(item) && item.role === "user") {
					const turnId = codexUserTurn(users[position]);
					const desired = turnId === undefined ? effective : (updates.get(turnId) ?? effective);
					if (desired !== effective) {
						input.push({ type: "configuration_update", reasoning: { effort: desired } });
						effective = desired;
					}
					position += 1;
				}
				input.push(item);
			}
			return { ...base, reasoning: { ...base.reasoning, effort: configuration.initialEffort }, input };
		},
	} as T;
}
