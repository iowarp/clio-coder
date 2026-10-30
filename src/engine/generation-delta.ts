import { readDiffusionFrame } from "./apis/diffusion-frames.js";

/** The first generated text, thinking or tool-call delta starts TTFT for main and worker calls alike (#434). */
export function hasAssistantGenerationDelta(update: unknown): boolean {
	if (typeof update !== "object" || update === null) return false;
	const event = update as { type?: unknown; delta?: unknown };
	return (
		event.type === "toolcall_start" ||
		// A diffusion frame empties its delta so accumulators see no append, but
		// it is still generated text: the first one is the call's first token.
		(event.type === "text_delta" && readDiffusionFrame(event) !== null) ||
		((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
			typeof event.delta === "string" &&
			event.delta.length > 0)
	);
}
