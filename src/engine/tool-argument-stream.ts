import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { remainingContextMaxTokens } from "./apis/output-budget.js";

// CLB-1: silence timers cannot bound an actively repeating argument stream.
// A long, short-cycle run must also persist for a minute: ordinary repeated
// file content delivered in a burst does not qualify, nor does slow new content.
const MAX_REPEAT_PERIOD = 64;
const MIN_REPEAT_CHARS = 16 * 1024;
const MIN_REPEAT_MS = 60_000;
// This is a transport safety ceiling, not a character-derived token limit.
// Leave ample room for UTF-8 and JSON escaping within the request's allowance.
const ARGUMENT_BYTES_PER_OUTPUT_TOKEN = 32;

class RepeatedArgumentRun {
	private readonly tail: number[] = [];
	private readonly matches = new Array<number>(MAX_REPEAT_PERIOD + 1).fill(0);
	private readonly since = new Array<number>(MAX_REPEAT_PERIOD + 1).fill(0);
	private chars = 0;

	observe(delta: string, at: number): { period: number; chars: number; elapsedMs: number } | null {
		for (let index = 0; index < delta.length; index++) {
			const char = delta.charCodeAt(index);
			for (let period = 1; period <= MAX_REPEAT_PERIOD; period++) {
				if (this.chars >= period && char === this.tail[(this.chars - period) % MAX_REPEAT_PERIOD]) {
					this.matches[period] = (this.matches[period] ?? 0) + 1;
				} else {
					this.matches[period] = 0;
					this.since[period] = at;
				}
			}
			this.tail[this.chars % MAX_REPEAT_PERIOD] = char;
			this.chars++;
		}
		for (let period = 1; period <= MAX_REPEAT_PERIOD; period++) {
			const chars = (this.matches[period] ?? 0) + period;
			const elapsedMs = Math.max(0, at - (this.since[period] ?? at));
			if (chars >= MIN_REPEAT_CHARS && elapsedMs >= MIN_REPEAT_MS) return { period, chars, elapsedMs };
		}
		return null;
	}
}

function argumentBytes(message: AssistantMessage): number {
	return message.content.reduce((sum, block) => {
		if (block.type !== "toolCall") return sum;
		const args = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments);
		return sum + Buffer.byteLength(args ?? "", "utf8");
	}, 0);
}

/** Bound tool generation before any surface or tool-dispatch barrier sees completion. */
export function guardToolArgumentStream<T extends StreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
	invoke: (options: T) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	monotonicNow: () => number = () => performance.now(),
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const byteLimit = remainingContextMaxTokens(model, context, options) * ARGUMENT_BYTES_PER_OUTPUT_TOKEN;
	const repeats = new Map<number, RepeatedArgumentRun>();
	let bytes = 0;
	let lastPartial: AssistantMessage | undefined;
	const aborted = (reason: string): AssistantMessage => ({
		...(lastPartial
			? structuredClone(lastPartial)
			: {
					role: "assistant" as const,
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				}),
		stopReason: "aborted",
		errorMessage: reason,
	});
	const stop = (detail: string): void => {
		const reason = `Tool argument generation stopped: ${detail}. No tools from this response were executed.`;
		const message = { ...aborted(reason), clioCoderAbortReason: "tool_argument_generation" };
		// Settle immediately even if a provider ignores abort or sends a late
		// successful terminal event. "aborted" bypasses both Pi dispatch and the
		// host transient retry ladder; this is not a retryable stream timeout.
		output.push({ type: "error", reason: "aborted", error: message });
		output.end(message);
		controller.abort(reason);
	};
	void (async () => {
		try {
			if (signal.aborted) {
				const message = aborted("Request was aborted.");
				output.push({ type: "error", reason: "aborted", error: message });
				output.end(message);
				return;
			}
			const source = await invoke({ ...options, signal } as T);
			for await (const event of source) {
				if ("partial" in event) lastPartial = event.partial;
				if (event.type === "toolcall_delta") {
					bytes += Buffer.byteLength(event.delta, "utf8");
					if (bytes > byteLimit) {
						stop(`arguments exceeded the ${byteLimit}-byte safety ceiling for this response's output allowance`);
						return;
					}
					const run = repeats.get(event.contentIndex) ?? new RepeatedArgumentRun();
					repeats.set(event.contentIndex, run);
					const repeated = run.observe(event.delta, monotonicNow());
					if (repeated) {
						stop(
							`arguments repeated a ${repeated.period}-character cycle for ${repeated.chars} characters over ${Math.round(repeated.elapsedMs / 1000)}s`,
						);
						return;
					}
				}
				if (event.type === "toolcall_end") repeats.delete(event.contentIndex);
				if (event.type === "done" || event.type === "error") {
					lastPartial = event.type === "done" ? event.message : event.error;
					if (argumentBytes(lastPartial) > byteLimit) {
						stop(`arguments exceeded the ${byteLimit}-byte safety ceiling for this response's output allowance`);
						return;
					}
					// A provider's late success must not execute a cancelled partial
					// batch. Retain its usage if it reported any before settlement.
					if (signal.aborted && event.type === "done") {
						const message = aborted("Request was aborted.");
						output.push({ type: "error", reason: "aborted", error: message });
						output.end(message);
						return;
					}
				}
				output.push(event);
				if (event.type === "done" || event.type === "error") return;
			}
			lastPartial = await source.result();
			if (argumentBytes(lastPartial) > byteLimit) {
				stop(`arguments exceeded the ${byteLimit}-byte safety ceiling for this response's output allowance`);
				return;
			}
			output.end(signal.aborted ? aborted("Request was aborted.") : lastPartial);
		} catch (cause) {
			const message = aborted(cause instanceof Error ? cause.message : String(cause));
			const reason = signal.aborted || (cause instanceof Error && cause.name === "AbortError") ? "aborted" : "error";
			message.stopReason = reason;
			output.push({ type: "error", reason, error: message });
			output.end(message);
		}
	})();
	return output;
}
