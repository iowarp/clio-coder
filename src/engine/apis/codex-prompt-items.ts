import type { Api, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Move the Codex request's top-level `instructions` and `tools` into leading
 * input items, the shape Codex CLI 0.159.1 sends (DF-0).
 *
 * The Responses API never carries top-level `instructions` or `tools` across
 * `previous_response_id`, so a continuation frame had to repeat them: about
 * 25 KB of system prompt and tool schemas on every call of a headless run,
 * with only the new tool outputs as real delta. Input items do chain. Pi's
 * WebSocket continuation diffs the full body against the last one and sends
 * only the input past the stored prefix, so once these two leading items sit
 * in that prefix they reach the server once per connection. A full resend
 * (continuation rejected, a changed prompt or tool surface, SSE fallback)
 * still carries both items, so the server sees the same prompt either way.
 */
function moveCodexPromptIntoInput(payload: Payload): Payload {
	const input = payload.input;
	if (!Array.isArray(input)) return payload;
	const instructions = typeof payload.instructions === "string" ? payload.instructions : "";
	const tools = Array.isArray(payload.tools) ? payload.tools : [];
	if (instructions.length === 0 && tools.length === 0) return payload;
	const { instructions: _instructions, tools: _tools, ...rest } = payload;
	const leading: Payload[] = [];
	// Codex wraps its function tools in the `functions` namespace, which is how
	// the top-level `tools` field renders to the model.
	if (tools.length > 0) {
		leading.push({
			type: "additional_tools",
			role: "developer",
			tools: [{ type: "namespace", name: "functions", description: "", tools }],
		});
	}
	if (instructions.length > 0) {
		leading.push({ type: "message", role: "developer", content: [{ type: "input_text", text: instructions }] });
	}
	return { ...rest, input: [...leading, ...input] };
}

/**
 * Pi keys a Codex WebSocket continuation on the session that also becomes
 * `prompt_cache_key`, so a body without one (no session id, cache retention
 * off) is a full request every call, as is SSE. Those keep the stock shape.
 */
function codexCanContinue(payload: Payload): boolean {
	return typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0;
}

/** Run every caller patch first, then reshape the finished Codex body. */
export function withCodexPromptItems<T extends StreamOptions | SimpleStreamOptions>(
	model: Model<Api>,
	options: T | undefined,
): T | undefined {
	if (model.api !== "openai-codex-responses" || options?.transport === "sse") return options;
	const previous = options?.onPayload;
	return {
		...options,
		onPayload: async (payload: unknown, currentModel: Model<Api>) => {
			const base = (await previous?.(payload, currentModel)) ?? payload;
			return isRecord(base) && codexCanContinue(base) ? moveCodexPromptIntoInput(base) : base;
		},
	} as T;
}
