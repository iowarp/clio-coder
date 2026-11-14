import { assistantOutputChars } from "../core/assistant-output.js";
import { ceilChars } from "../domains/session/context-accounting.js";
import type { TokenThroughputSnapshot } from "../domains/telemetry/index.js";
import { hasAssistantGenerationDelta } from "../engine/generation-delta.js";

type TimingEvent = {
	type: string;
	message?: {
		role?: string;
		usage?: { input?: number; output?: number; totalTokens?: number; estimated?: boolean };
	};
	assistantMessageEvent?: unknown;
};

/**
 * A delta window shorter than this arrived in one burst after work the stream
 * never showed, such as reasoning a provider returns whole. Its tokens are
 * still counted, so dividing by the burst alone reported 21432 Tk/s for 241
 * tokens delivered in 11ms; the whole call is the honest window then.
 */
const MIN_DECODE_WINDOW_MS = 250;

/**
 * A rate is shown only when the tokens it divides arrived over at least this much generation time. One burst after a
 * silent wait, or a short reply a fast route returns at once, lands within tens of milliseconds and measures the
 * delivery, not the model, so `2196 tps` says nothing an operator can use. A real 96-token reply that streamed for
 * 994 ms is a rate worth showing, which is why the window is not a full second. Below it the figure is left out.
 */
export const RATE_MIN_WINDOW_MS = 500;

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
		/** Null until the first delta. A call's TTFT is the read model's, from send to first token (#434). */
		snapshot(at: number): { durationMs: number } | null {
			if (startedAt === null || firstDeltaAt === null) return null;
			return { durationMs: Math.max(1, settledMs + (activeSince === null ? 0 : Math.max(0, at - activeSince))) };
		},
	};
}

export type AssistantGenerationTiming = ReturnType<typeof createAssistantGenerationTiming>;

/** The streaming run's rate and output count at `at`, or null before the first token. */
export function liveThroughput(timing: AssistantGenerationTiming, at: number): TokenThroughputSnapshot | null {
	const snapshot = timing.snapshot(at);
	if (!snapshot) return null;
	const { outputTokens, estimated } = timing.output();
	if (outputTokens <= 0) return null;
	const { durationMs } = snapshot;
	// Zero reads as no rate; the output count still shows while the window is too short to divide (RATE_MIN_WINDOW_MS).
	const tokensPerSecond = durationMs >= RATE_MIN_WINDOW_MS ? outputTokens / (durationMs / 1000) : 0;
	return { tokensPerSecond, outputTokens, estimated, durationMs };
}

/** A rate as it reads: `≈` when any of it is estimated, a whole number at 10 or above, else one decimal. */
export function tokensPerSecondText(rate: number, estimated: boolean): string {
	return `${estimated ? "≈" : ""}${rate >= 10 ? Math.round(rate) : Math.round(rate * 10) / 10}`;
}
