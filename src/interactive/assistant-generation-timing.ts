import { assistantOutputChars } from "../core/assistant-output.js";
import { ceilChars } from "../domains/session/context-accounting.js";
import { readDiffusionFrame } from "../engine/apis/diffusion-frames.js";

type TimingEvent = {
	type: string;
	message?: {
		role?: string;
		usage?: { input?: number; output?: number; totalTokens?: number; estimated?: boolean };
	};
	assistantMessageEvent?: unknown;
};

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

/**
 * A delta window shorter than this arrived in one burst after work the stream
 * never showed, such as reasoning a provider returns whole. Its tokens are
 * still counted, so dividing by the burst alone reported 21432 Tk/s for 241
 * tokens delivered in 11ms; the whole call is the honest window then.
 */
const MIN_DECODE_WINDOW_MS = 250;

/** Monotonic generation spans; tool waits and each call's prefill stay outside Tk/s. */
export function createAssistantGenerationTiming() {
	let startedAt: number | null = null;
	let firstDeltaAt: number | null = null;
	let activeSince: number | null = null;
	let callStartedAt: number | null = null;
	let settledMs = 0;
	let settledOutput = 0;
	let partialOutput = 0;
	let estimatedOutput = false;
	const settle = (at: number): void => {
		if (activeSince !== null) {
			const window = Math.max(0, at - activeSince);
			settledMs += window < MIN_DECODE_WINDOW_MS && callStartedAt !== null ? Math.max(window, at - callStartedAt) : window;
		}
		activeSince = null;
		callStartedAt = null;
	};
	return {
		record(event: TimingEvent, at: number): void {
			if (event.type === "agent_start") {
				startedAt = at;
				firstDeltaAt = null;
				activeSince = null;
				callStartedAt = null;
				settledMs = 0;
				settledOutput = 0;
				partialOutput = 0;
				estimatedOutput = false;
			} else if (startedAt !== null) {
				if (event.type === "message_start" && event.message?.role === "assistant") {
					callStartedAt = at;
					partialOutput = 0;
				} else if (event.type === "message_update" && hasAssistantGenerationDelta(event.assistantMessageEvent)) {
					firstDeltaAt ??= at;
					activeSince ??= at;
					const update = event.assistantMessageEvent as { partial?: unknown };
					partialOutput = ceilChars(assistantOutputChars(update.partial ?? event.message));
				} else if (event.type === "message_end" && event.message?.role === "assistant") {
					const usage = event.message.usage;
					const output = usage?.output;
					const reported =
						typeof output === "number" &&
						Number.isFinite(output) &&
						output >= 0 &&
						((usage?.input ?? 0) > 0 || (usage?.totalTokens ?? 0) > 0 || output > 0);
					// Replace this call's live estimate, then add it once to the run.
					// Earlier calls remain settled while the next call streams.
					settledOutput += reported ? output : ceilChars(assistantOutputChars(event.message));
					estimatedOutput ||= !reported || usage?.estimated === true;
					partialOutput = 0;
					settle(at);
				} else if (event.type === "agent_end") {
					settle(at);
				}
			}
		},
		output(): { outputTokens: number; estimated: boolean } {
			return { outputTokens: settledOutput + partialOutput, estimated: estimatedOutput || partialOutput > 0 };
		},
		snapshot(at: number): { durationMs: number; ttftMs: number } | null {
			if (startedAt === null || firstDeltaAt === null) return null;
			return {
				durationMs: Math.max(1, settledMs + (activeSince === null ? 0 : Math.max(0, at - activeSince))),
				ttftMs: Math.max(0, firstDeltaAt - startedAt),
			};
		},
	};
}
