import { createHash } from "node:crypto";
import type { PinnedPromptPrefix } from "./anthropic-system-split.js";

type Payload = Record<string, unknown>;

function record(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pinnedSplit(text: unknown, prefix: PinnedPromptPrefix): [string, string] | null {
	if (typeof text !== "string" || text.length <= prefix.chars) return null;
	const pinned = text.slice(0, prefix.chars);
	return createHash("sha256").update(pinned).digest("hex") === prefix.hash ? [pinned, text.slice(prefix.chars)] : null;
}

const developerText = (text: string): Payload => ({
	type: "message",
	role: "developer",
	content: [{ type: "input_text", text }],
});

/**
 * Keep the install prefix reusable on the Codex backend when the rest of the system prompt changes. The backend reuses
 * its cache at input-item granularity and pays a changed item in full from its first byte, so the pinned part becomes
 * an item of its own and the rest follows it as a second developer message, ahead of the whole history. On the stock
 * shape (no continuation key, or SSE) `instructions` keeps the pinned part and the rest is the first input item.
 *
 * Measured on gpt-6-luna, 2026-11-11: with the whole prompt in one block, a changed tail after an unchanged
 * 4.6k-token prefix read 0 of 5,645 prompt tokens; split at the prefix it read 4,608 of 5,654. The backend rejects
 * `prompt_cache_breakpoint` on that model. Through Clio, a turn after a project handbook edit read 0 of 5,947 prompt
 * tokens before the split and 4,352 of 5,955 after it. Anything that does not match is returned unchanged.
 */
export function splitCodexInstructions(payload: unknown, prefix: PinnedPromptPrefix): unknown {
	if (!record(payload) || !Array.isArray(payload.input) || !Number.isSafeInteger(prefix.chars) || prefix.chars <= 0) {
		return payload;
	}
	const input: unknown[] = payload.input;
	const fromInstructions = pinnedSplit(payload.instructions, prefix);
	if (fromInstructions !== null) {
		const [pinned, rest] = fromInstructions;
		return { ...payload, instructions: pinned, input: [developerText(rest), ...input] };
	}
	// The prompt item `withCodexPromptItems` built: a one-part developer message among the leading prompt items.
	const leading = input.findIndex((item) => !(record(item) && item.role === "developer"));
	const prompts = leading < 0 ? input : input.slice(0, leading);
	const index = prompts.findIndex(
		(item) =>
			record(item) &&
			item.type === "message" &&
			Array.isArray(item.content) &&
			item.content.length === 1 &&
			record(item.content[0]) &&
			item.content[0].type === "input_text" &&
			pinnedSplit(item.content[0].text, prefix) !== null,
	);
	if (index < 0) return payload;
	const item = input[index] as Payload & { content: [Payload & { text: string }] };
	const [pinned, rest] = pinnedSplit(item.content[0].text, prefix) as [string, string];
	const part = item.content[0];
	return {
		...payload,
		input: [
			...input.slice(0, index),
			{ ...item, content: [{ ...part, text: pinned }] },
			{ ...item, content: [{ ...part, text: rest }] },
			...input.slice(index + 1),
		],
	};
}
