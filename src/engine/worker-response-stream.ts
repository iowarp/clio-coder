import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	Model,
	StreamOptions,
} from "@earendil-works/pi-ai";
import { calculateCost, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { CallUsage } from "../core/token-split.js";
import { normalizeCallUsage } from "../core/token-split.js";
import { remainingContextMaxTokens } from "./apis/output-budget.js";
import { RESPONSE_DEADLINE } from "./response-deadline.js";

export type WorkerResponseLimitCode = "worker_turn_timeout" | "worker_output_cap_exhausted";

/** A native worker must settle locally even when its provider ignores cancellation. */
export function boundWorkerResponse<T extends StreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
	limits: {
		locked: boolean;
		responseSeconds: number;
		round: number;
		onLimit: (code: WorkerResponseLimitCode, detail: string) => void;
	},
	invoke: (options: T) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
	monotonicNow: () => number = () => performance.now(),
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	const controller = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const seconds = Math.min(limits.responseSeconds, limits.locked ? 120 : Number.POSITIVE_INFINITY);
	const maxTokens = remainingContextMaxTokens(model, context, {
		...options,
		...(limits.locked ? { maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, 4096) } : {}),
	});
	let settled = false;
	let partial: AssistantMessage | undefined;
	let reportedUsage: CallUsage | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const cleanup = (): void => {
		clearTimeout(timer);
		signal.removeEventListener("abort", cancel);
	};
	// A failed call keeps the usage its provider streamed, or says it is unknown;
	// the stream's initial zeros read as a free call (#423).
	const settleUsage = (message: AssistantMessage): void => {
		if (normalizeCallUsage({ ...message.usage }).observed) return;
		if (reportedUsage) {
			message.usage = { ...reportedUsage, cost: message.usage.cost };
			calculateCost(model, message.usage);
		} else {
			message.usage = { ...message.usage, observed: false } as AssistantMessage["usage"];
		}
	};
	const stop = (detail: string, code?: WorkerResponseLimitCode, reason: "aborted" | "error" = "aborted"): void => {
		if (settled) return;
		settled = true;
		cleanup();
		const message = {
			...(partial
				? structuredClone(partial)
				: {
						role: "assistant" as const,
						content: [],
						api: model.api,
						provider: model.provider,
						model: model.id,
						timestamp: Date.now(),
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					}),
			stopReason: reason,
			...(code ? { clioCoderAbortReason: code } : {}),
			errorMessage: detail,
		};
		settleUsage(message);
		if (code) limits.onLimit(code, detail);
		// An aborted terminal message bypasses Pi tool execution and transient retries.
		output.push({ type: "error", reason, error: message });
		output.end(message);
		controller.abort(detail);
	};
	const cancel = (): void => stop("Worker response aborted.");
	signal.addEventListener("abort", cancel, { once: true });
	let deadline = Number.POSITIVE_INFINITY;
	const expire = (): void => {
		const remaining = deadline - monotonicNow();
		if (remaining > 0) {
			timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
			return;
		}
		stop(
			`worker_turn_timeout: round ${limits.round} exceeded the ${seconds} second response limit`,
			"worker_turn_timeout",
		);
	};
	const startDeadline = (): void => {
		if (settled) return;
		clearTimeout(timer);
		deadline = monotonicNow() + seconds * 1000;
		timer = setTimeout(expire, Math.min(seconds * 1000, 2_147_483_647));
	};
	const deferDeadline = (): (() => void) => {
		clearTimeout(timer);
		deadline = Number.POSITIVE_INFINITY;
		return startDeadline;
	};
	startDeadline();
	void (async () => {
		try {
			if (signal.aborted) {
				cancel();
				return;
			}
			const onProviderStreamEvent: NonNullable<StreamOptions["onProviderStreamEvent"]> = async (data, eventModel) => {
				if (
					data !== null &&
					typeof data === "object" &&
					"usage" in data &&
					data.usage !== null &&
					typeof data.usage === "object"
				) {
					const usage = normalizeCallUsage(data.usage as Record<string, unknown>);
					if (usage.observed) reportedUsage = usage;
				}
				await options?.onProviderStreamEvent?.(data, eventModel);
			};
			const boundedOptions = { ...options, maxTokens, signal, onProviderStreamEvent } as T;
			const source = await invoke({ ...boundedOptions, [RESPONSE_DEADLINE]: deferDeadline });
			for await (const event of source) {
				if (settled) return;
				if ("partial" in event) partial = event.partial;
				if (event.type === "done" || event.type === "error") partial = event.type === "done" ? event.message : event.error;
				if (monotonicNow() >= deadline) {
					expire();
					return;
				}
				if (event.type === "done" || event.type === "error") {
					partial = event.type === "done" ? event.message : event.error;
					if (limits.locked && partial.stopReason === "length") {
						stop(
							`worker_output_cap_exhausted: round ${limits.round} exhausted the ${maxTokens} token output limit`,
							"worker_output_cap_exhausted",
						);
						return;
					}
					if (event.type === "error") settleUsage(event.error);
					settled = true;
					cleanup();
					output.push(event);
					output.end(partial);
					return;
				}
				output.push(event);
			}
			const message = await source.result();
			if (settled) return;
			partial = message;
			if (monotonicNow() >= deadline) {
				expire();
				return;
			}
			if (limits.locked && message.stopReason === "length") {
				stop(
					`worker_output_cap_exhausted: round ${limits.round} exhausted the ${maxTokens} token output limit`,
					"worker_output_cap_exhausted",
				);
				return;
			}
			settled = true;
			cleanup();
			output.end(message);
		} catch (error) {
			stop(error instanceof Error ? error.message : String(error), undefined, signal.aborted ? "aborted" : "error");
		}
	})();
	return output;
}
