/**
 * Degraded-inference watchdog for local runtimes.
 *
 * A local server whose weights or KV cache spilled to CPU does not fail: it
 * answers, at roughly a hundredth of the speed, and the operator sees only a
 * spinner. The observed case was 2m18s of streaming for 25 tokens with no
 * indication that anything was wrong. This watchdog turns that silence into a
 * notice: once a prediction has run past a grace period, a sustained token rate
 * below the floor is reported once per turn, along with what is resident on the
 * target so the cause is visible in the same line.
 *
 * The watchdog observes; it never cancels a turn. A slow model is still a
 * working model, and the operator decides whether to abort.
 */

import {
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { rawDurationMs } from "../../core/timers.js";
import { ceilChars } from "../../domains/session/context-accounting.js";
import { declareRuntimeNoticeProducer } from "./residency.js";
import type { ResidentModelInfo } from "./resident-models.js";

/** Time a prediction gets before its rate is judged. */
export const DEGRADED_GRACE_MS = 30_000;
/** Sustained output tokens per second below which inference is reported as degraded. */
export const DEGRADED_FLOOR_TOKENS_PER_SECOND = 2;

const emitDegradedNotice = declareRuntimeNoticeProducer("degraded-inference", ["degraded"]);

export interface DegradedInferenceReport {
	elapsedMs: number;
	tokens: number;
	tokensPerSecond: number;
}

export interface DegradedInferenceTiming {
	graceMs?: number;
	floorTokensPerSecond?: number;
	/** Sampling interval; the watchdog checks the rate this often. */
	pollMs?: number;
	/**
	 * Monotonic clock for the turn's span, defaulting to `performance.now`. A
	 * stepped wall clock would fake a collapse on a forward step and hide one on
	 * a backward step.
	 */
	monotonicNow?: () => number;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
}

export interface DegradedInferenceOptions extends DegradedInferenceTiming {
	/** Called at most once, when the observed rate stays under the floor past the grace period. */
	onDegraded: (report: DegradedInferenceReport) => void;
}

export interface DegradedInferenceWatchdog {
	/** Record generated tokens (output plus reasoning; both are work the server did). */
	addTokens: (count: number) => void;
	stop: () => void;
}

function defaultTimer(fn: () => void, ms: number): { cancel: () => void } {
	const handle = setInterval(fn, ms);
	handle.unref?.();
	return { cancel: () => clearInterval(handle) };
}

/**
 * Start watching a prediction's token rate. Call {@link
 * DegradedInferenceWatchdog.addTokens} as fragments arrive and `stop()` when the
 * turn ends, in a `finally`, so a failed turn never leaves a timer behind.
 */
function startDegradedInferenceWatchdog(options: DegradedInferenceOptions): DegradedInferenceWatchdog {
	const monotonicNow = options.monotonicNow ?? (() => performance.now());
	const graceMs = options.graceMs ?? DEGRADED_GRACE_MS;
	const floor = options.floorTokensPerSecond ?? DEGRADED_FLOOR_TOKENS_PER_SECOND;
	const pollMs = options.pollMs ?? 5_000;
	const startedAt = monotonicNow();
	let tokens = 0;
	let reported = false;
	let stopped = false;

	const check = (): void => {
		if (reported || stopped) return;
		const elapsedMs = rawDurationMs(startedAt, monotonicNow());
		if (elapsedMs < graceMs) return;
		const tokensPerSecond = tokens / (elapsedMs / 1000);
		if (tokensPerSecond >= floor) return;
		reported = true;
		timer.cancel();
		try {
			options.onDegraded({ elapsedMs, tokens, tokensPerSecond });
		} catch {
			// A notice sink failure must never escape into the turn it describes.
		}
	};

	const timer = (options.setTimer ?? defaultTimer)(check, pollMs);

	return {
		addTokens: (count) => {
			if (Number.isFinite(count) && count > 0) tokens += count;
		},
		stop: () => {
			if (stopped) return;
			stopped = true;
			timer.cancel();
		},
	};
}

export interface WatchDegradedInferenceOptions {
	targetId: string;
	runtimeId: string;
	model: string;
	signal?: AbortSignal;
	/** Lists what is resident on the target when the notice fires. */
	listResident?: () => Promise<ResidentModelInfo[]>;
	timing?: DegradedInferenceTiming;
}

function describeResident(entry: ResidentModelInfo): string {
	const { sizeBytes, sizeVramBytes } = entry;
	if (sizeBytes === undefined || sizeVramBytes === undefined || sizeBytes <= 0 || sizeVramBytes >= sizeBytes) {
		return entry.modelId;
	}
	return `${entry.modelId} (${Math.round((sizeVramBytes / sizeBytes) * 100)}% on GPU)`;
}

// A server crawling on CPU can answer its listing slowly too; the notice must
// not wait on it indefinitely.
const RESIDENT_LISTING_TIMEOUT_MS = 3_000;

async function residentSummary(options: WatchDegradedInferenceOptions): Promise<string | undefined> {
	const listResident = options.listResident;
	if (!listResident) return undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const resident = await Promise.race([
			listResident(),
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => reject(new Error("resident listing timed out")), RESIDENT_LISTING_TIMEOUT_MS);
				timeout.unref?.();
			}),
		]);
		return resident.length > 0 ? resident.map(describeResident).join(", ") : "none reported";
	} catch {
		return undefined;
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function generatedChars(event: AssistantMessageEvent): number {
	if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
		return event.delta.length;
	}
	return 0;
}

/**
 * Pass a local runtime's stream through unchanged while watching its token
 * rate. The clock starts at the `start` event, which both local paths push
 * once the server has answered the request, so a model load is never judged as
 * slow generation. Text, reasoning, and tool-call fragments all count. The
 * watch ends at `done`, `error`, or abort, and an abort also suppresses a
 * notice still waiting on its resident listing.
 */
export function watchDegradedInference(
	source: AssistantMessageEventStream,
	options: WatchDegradedInferenceOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	let watchdog: DegradedInferenceWatchdog | null = null;
	const aborted = (): boolean => options.signal?.aborted === true;
	const onAbort = (): void => watchdog?.stop();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	const onDegraded = (report: DegradedInferenceReport): void => {
		void residentSummary(options).then((residents) => {
			if (aborted()) return;
			const seconds = Math.round(report.elapsedMs / 1000);
			const rate = report.tokensPerSecond.toFixed(2);
			const residentLine =
				residents === undefined
					? "The resident models on the target could not be listed."
					: `Resident there: ${residents}.`;
			emitDegradedNotice({
				kind: "degraded",
				level: "warning",
				targetId: options.targetId,
				runtimeId: options.runtimeId,
				model: options.model,
				message: `'${options.model}' on '${options.targetId}' has generated ${report.tokens} tokens in ${seconds}s (${rate} tok/s); inference is running far below GPU speed, which is what a spill to CPU looks like. ${residentLine} Unload a co-resident model or lower the context window.`,
				detail: {
					tokens: report.tokens,
					elapsedMs: report.elapsedMs,
					tokensPerSecond: Number(rate),
					...(residents !== undefined ? { residents } : {}),
				},
			});
		});
	};
	(async () => {
		try {
			for await (const event of source) {
				if (event.type === "start" && watchdog === null && !aborted()) {
					watchdog = startDegradedInferenceWatchdog({ ...options.timing, onDegraded });
				}
				const chars = generatedChars(event);
				if (chars > 0) watchdog?.addTokens(ceilChars(chars));
				if (event.type === "done" || event.type === "error") watchdog?.stop();
				stream.push(event);
			}
			stream.end();
		} finally {
			watchdog?.stop();
			options.signal?.removeEventListener("abort", onAbort);
		}
	})();
	return stream;
}
