/**
 * Presentation-local adaptive pacing for streamed assistant text.
 *
 * This module deliberately knows nothing about the event bus, ChatPanel, or
 * the terminal. It owns only the ordered display-mutation queue. Callers keep
 * canonical events and persistence synchronous, then apply the slices emitted
 * here directly to their presentation model.
 */

export type SmoothStreamingMode = "off" | "auto" | "on";

export type StreamEventClass =
	| "transparent-mirror"
	| "paced-display-content"
	| "ordered-content-boundary"
	| "cumulative-live-state"
	| "non-transcript-input";

export interface StreamSemanticEvent {
	type: string;
	assistantMessageEvent?: { type?: unknown };
}

const NON_TRANSCRIPT_INPUT_TYPES: ReadonlySet<string> = new Set([
	"cursor_move",
	"editor_mutation",
	"input",
	"overlay_action",
	"scroll",
]);

/**
 * Classify an ingress event by the ordering action its presentation consumer
 * must take. Unknown events are boundaries: an extra synchronous drain is
 * safer than allowing delayed assistant text to cross a new mutation kind.
 */
export function classifyStreamEvent(event: StreamSemanticEvent): StreamEventClass {
	if (event.type === "message_update") {
		const innerType = event.assistantMessageEvent?.type;
		if (innerType === "text_delta" || innerType === "thinking_delta") return "transparent-mirror";
	}
	if (event.type === "text_delta" || event.type === "thinking_delta") return "paced-display-content";
	if (event.type === "tool_execution_update") return "cumulative-live-state";
	if (NON_TRANSCRIPT_INPUT_TYPES.has(event.type)) return "non-transcript-input";
	return "ordered-content-boundary";
}

export type StreamContentKind = "text" | "thinking";
export type StreamPacerGeneration = string | number;
export type StreamPacerSliceReason = "first" | "tick" | "deadline" | "capacity" | "flush" | "off" | "folded";

export interface StreamPacerAdmission {
	/** Canonical ingress sequence. Values must increase for accepted items. */
	sequence: number;
	generation: StreamPacerGeneration;
	kind: StreamContentKind;
	contentIndex: number;
	text: string;
	/** Canonical monotonic ingress time. Defaults to the injected clock. */
	ingressAt?: number;
	/**
	 * Folded thinking still mutates the panel's complete backing state and live
	 * counter, but is consumed as one item instead of spending animation ticks.
	 */
	folded?: boolean;
	/** Reject work captured before a boundary/reset instead of crossing epochs. */
	epoch?: number;
}

export interface StreamPacerSlice {
	sequence: number;
	generation: StreamPacerGeneration;
	epoch: number;
	kind: StreamContentKind;
	contentIndex: number;
	text: string;
	ingressAt: number;
	reason: StreamPacerSliceReason;
	graphemes: number;
	bytes: number;
	remainingGraphemes: number;
	finalForItem: boolean;
}

export interface StreamPacerSnapshot {
	mode: SmoothStreamingMode;
	epoch: number;
	queuedItems: number;
	queuedGraphemes: number;
	queuedBytes: number;
	oldestAgeMs: number;
	credit: number;
	timerPending: boolean;
	disposed: boolean;
}

export interface StreamPacerFlushResult {
	reason: string;
	fromEpoch: number;
	toEpoch: number;
	items: number;
	graphemes: number;
	bytes: number;
}

export interface StreamPacerOptions {
	mode: SmoothStreamingMode;
	onSlice: (slice: StreamPacerSlice) => void;
	/** Balances external queue accounting when a reset intentionally discards content. */
	onDiscard?: (sequence: number) => void;
	now?: () => number;
	setTimer?: (callback: () => void, delayMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Re-evaluated at admission/tick time. Defaults false for conservative auto. */
	isAutoPacingAllowed?: () => boolean;
	tickMs?: number;
	baseGraphemesPerSecond?: number;
	/** Fraction of measured arrivals granted as fractional display credit. */
	arrivalCreditRatio?: number;
	/** Additional convergence rate, expressed as one backlog per this window. */
	catchUpWindowMs?: number;
	maxElapsedMs?: number;
	maxOldestAgeMs?: number;
	maxQueueGraphemes?: number;
	maxQueueBytes?: number;
	maxSliceGraphemes?: number;
	maxSliceBytes?: number;
	firstSliceGraphemes?: number;
}

export interface StreamPacer {
	readonly epoch: number;
	readonly mode: SmoothStreamingMode;
	enqueue(admission: StreamPacerAdmission): { accepted: boolean; epoch: number };
	/** Consume at most one bounded visible slice (a folded item is intentionally whole). */
	dequeue(maxGraphemes?: number, reason?: StreamPacerSliceReason): StreamPacerSlice | null;
	/** Invalidate scheduled callbacks, then synchronously drain all prior-epoch content. */
	flush(reason: string): StreamPacerFlushResult;
	/** Drop queued content after a reset/session switch, making captured work stale. */
	invalidateEpoch(): number;
	/** Changing to a bypass mode synchronously settles existing content first. */
	setMode(mode: SmoothStreamingMode): void;
	snapshot(): StreamPacerSnapshot;
	dispose(reason?: string): StreamPacerFlushResult;
}

interface QueueItem {
	sequence: number;
	generation: StreamPacerGeneration;
	epoch: number;
	kind: StreamContentKind;
	contentIndex: number;
	ingressAt: number;
	folded: boolean;
	graphemes: string[];
	graphemeBytes: number[];
	offset: number;
}

const DEFAULT_TICK_MS = 25;
const DEFAULT_RATE = 40;
const DEFAULT_ARRIVAL_CREDIT_RATIO = 0.25;
const DEFAULT_CATCH_UP_WINDOW_MS = 250;
const DEFAULT_MAX_ELAPSED_MS = 100;
const DEFAULT_MAX_AGE_MS = 60;
const DEFAULT_MAX_QUEUE_GRAPHEMES = 8_192;
const DEFAULT_MAX_QUEUE_BYTES = 512 * 1_024;
const DEFAULT_MAX_SLICE_GRAPHEMES = 64;
const DEFAULT_MAX_SLICE_BYTES = 16 * 1_024;
const DEFAULT_FIRST_SLICE_GRAPHEMES = 1;

function positiveFinite(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonnegativeFinite(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function createStreamPacer(options: StreamPacerOptions): StreamPacer {
	const now = options.now ?? (() => performance.now());
	const setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
	const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
	const tickMs = positiveFinite(options.tickMs, DEFAULT_TICK_MS);
	const baseRate = positiveFinite(options.baseGraphemesPerSecond, DEFAULT_RATE);
	const arrivalCreditRatio = nonnegativeFinite(options.arrivalCreditRatio, DEFAULT_ARRIVAL_CREDIT_RATIO);
	const catchUpWindowMs = positiveFinite(options.catchUpWindowMs, DEFAULT_CATCH_UP_WINDOW_MS);
	const maxElapsedMs = positiveFinite(options.maxElapsedMs, DEFAULT_MAX_ELAPSED_MS);
	const maxOldestAgeMs = positiveFinite(options.maxOldestAgeMs, DEFAULT_MAX_AGE_MS);
	const maxQueueGraphemes = Math.max(
		1,
		Math.floor(positiveFinite(options.maxQueueGraphemes, DEFAULT_MAX_QUEUE_GRAPHEMES)),
	);
	const maxQueueBytes = Math.max(1, Math.floor(positiveFinite(options.maxQueueBytes, DEFAULT_MAX_QUEUE_BYTES)));
	const maxSliceGraphemes = Math.max(
		1,
		Math.floor(positiveFinite(options.maxSliceGraphemes, DEFAULT_MAX_SLICE_GRAPHEMES)),
	);
	const maxSliceBytes = Math.max(1, Math.floor(positiveFinite(options.maxSliceBytes, DEFAULT_MAX_SLICE_BYTES)));
	const firstSliceGraphemes = Math.max(
		0,
		Math.floor(nonnegativeFinite(options.firstSliceGraphemes, DEFAULT_FIRST_SLICE_GRAPHEMES)),
	);
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

	let mode = options.mode;
	let epoch = 0;
	let disposed = false;
	let timer: unknown = null;
	let timerToken = 0;
	let queue: QueueItem[] = [];
	let queuedGraphemes = 0;
	let queuedBytes = 0;
	let credit = 0;
	let lastTickAt = now();
	let lastSequence = -Infinity;
	let activeGeneration: StreamPacerGeneration | null = null;
	let emittedInEpoch = false;

	const pacingAllowed = (): boolean => mode === "on" || (mode === "auto" && (options.isAutoPacingAllowed?.() ?? false));

	const cancelTimer = (): void => {
		if (timer === null) return;
		clearTimer(timer);
		timer = null;
		timerToken += 1;
	};

	const oldestAge = (at: number): number => {
		const head = queue[0];
		return head ? Math.max(0, at - head.ingressAt) : 0;
	};

	const schedule = (): void => {
		if (disposed || timer !== null || queue.length === 0 || !pacingAllowed()) return;
		const capturedEpoch = epoch;
		const capturedTimerToken = ++timerToken;
		const untilDeadline = Math.max(0, maxOldestAgeMs - oldestAge(now()));
		const delay = !emittedInEpoch && firstSliceGraphemes > 0 ? 0 : Math.min(tickMs, untilDeadline);
		timer = setTimer(() => {
			if (disposed || capturedEpoch !== epoch || capturedTimerToken !== timerToken) return;
			timer = null;
			if (!pacingAllowed()) {
				flush("auto-bypass");
				return;
			}
			if (!emittedInEpoch && firstSliceGraphemes > 0) {
				const first = dequeueInternal(firstSliceGraphemes, "first");
				if (first && first.reason !== "folded") credit = Math.max(0, credit - first.graphemes);
				consumeFoldedHeads();
				schedule();
				return;
			}
			const tickAt = now();
			const elapsedMs = Math.min(maxElapsedMs, Math.max(0, tickAt - lastTickAt));
			lastTickAt = tickAt;
			const catchUpRate = queuedGraphemes * (1_000 / catchUpWindowMs);
			credit += (elapsedMs / 1_000) * (baseRate + catchUpRate);

			// Every overdue item is settled now. Per-slice limits remain intact, so
			// mutation consumers never receive an unexpectedly giant visible chunk.
			while (queue[0] && oldestAge(tickAt) >= maxOldestAgeMs) {
				const head = queue[0];
				if (!head) break;
				const before = head.offset;
				const overdue = dequeueInternal(maxSliceGraphemes, "deadline");
				if (overdue && overdue.reason !== "folded") credit = Math.max(0, credit - overdue.graphemes);
				if (queue[0] === head && head.offset === before) break;
			}

			const budget = Math.min(maxSliceGraphemes, Math.floor(credit));
			if (budget > 0 && queue.length > 0) {
				const slice = dequeueInternal(budget, "tick");
				if (slice && slice.reason !== "folded") credit = Math.max(0, credit - slice.graphemes);
			}
			consumeFoldedHeads();
			schedule();
		}, delay);
	};

	const dequeueInternal = (requestedGraphemes: number, reason: StreamPacerSliceReason): StreamPacerSlice | null => {
		const head = queue[0];
		if (!head) return null;
		const remaining = head.graphemes.length - head.offset;
		if (remaining <= 0) return null;

		let take = head.folded
			? remaining
			: Math.max(1, Math.min(remaining, maxSliceGraphemes, Math.floor(requestedGraphemes)));
		let bytes = 0;
		if (!head.folded) {
			take = 0;
			const limit = Math.max(1, Math.min(remaining, maxSliceGraphemes, Math.floor(requestedGraphemes)));
			while (take < limit) {
				const nextBytes = head.graphemeBytes[head.offset + take];
				if (nextBytes === undefined) break;
				if (take > 0 && bytes + nextBytes > maxSliceBytes) break;
				bytes += nextBytes;
				take += 1;
			}
		} else {
			for (let index = head.offset; index < head.graphemes.length; index += 1) {
				bytes += head.graphemeBytes[index] ?? 0;
			}
		}

		const start = head.offset;
		const end = start + take;
		const text = head.graphemes.slice(start, end).join("");
		head.offset = end;
		queuedGraphemes -= take;
		queuedBytes -= bytes;
		const finalForItem = head.offset === head.graphemes.length;
		if (finalForItem) queue.shift();
		if (queue.length === 0) {
			activeGeneration = null;
			credit = 0;
		}

		const slice: StreamPacerSlice = {
			sequence: head.sequence,
			generation: head.generation,
			epoch: head.epoch,
			kind: head.kind,
			contentIndex: head.contentIndex,
			text,
			ingressAt: head.ingressAt,
			reason: head.folded ? "folded" : reason,
			graphemes: take,
			bytes,
			remainingGraphemes: head.graphemes.length - head.offset,
			finalForItem,
		};
		emittedInEpoch = true;
		options.onSlice(slice);
		return slice;
	};

	const consumeFoldedHeads = (): void => {
		while (queue[0]?.folded) dequeueInternal(Number.MAX_SAFE_INTEGER, "folded");
	};

	const drainDetached = (detached: QueueItem[], flushReason: string): StreamPacerFlushResult => {
		const fromEpoch = detached[0]?.epoch ?? epoch - 1;
		let items = 0;
		let graphemes = 0;
		let bytes = 0;
		for (const item of detached) {
			const start = item.offset;
			if (start >= item.graphemes.length) continue;
			const text = item.graphemes.slice(start).join("");
			let itemBytes = 0;
			for (let index = start; index < item.graphemeBytes.length; index += 1) itemBytes += item.graphemeBytes[index] ?? 0;
			const count = item.graphemes.length - start;
			items += 1;
			graphemes += count;
			bytes += itemBytes;
			options.onSlice({
				sequence: item.sequence,
				generation: item.generation,
				epoch: item.epoch,
				kind: item.kind,
				contentIndex: item.contentIndex,
				text,
				ingressAt: item.ingressAt,
				reason: item.folded ? "folded" : "flush",
				graphemes: count,
				bytes: itemBytes,
				remainingGraphemes: 0,
				finalForItem: true,
			});
		}
		return { reason: flushReason, fromEpoch, toEpoch: epoch, items, graphemes, bytes };
	};

	const flush = (reason: string): StreamPacerFlushResult => {
		cancelTimer();
		const detached = queue;
		queue = [];
		queuedGraphemes = 0;
		queuedBytes = 0;
		credit = 0;
		activeGeneration = null;
		epoch += 1;
		emittedInEpoch = false;
		lastTickAt = now();
		return drainDetached(detached, reason);
	};

	const api: StreamPacer = {
		get epoch() {
			return epoch;
		},
		get mode() {
			return mode;
		},
		enqueue(admission) {
			if (disposed || (admission.epoch !== undefined && admission.epoch !== epoch) || admission.text.length === 0) {
				return { accepted: false, epoch };
			}
			if (!Number.isFinite(admission.sequence) || admission.sequence <= lastSequence) {
				throw new Error(`stream pacer sequence must increase (received ${admission.sequence} after ${lastSequence})`);
			}
			if (activeGeneration !== null && activeGeneration !== admission.generation) {
				throw new Error(
					"stream pacer generation changed with queued content; flush or invalidate the prior generation first",
				);
			}
			if (!pacingAllowed()) {
				if (queue.length > 0) flush("mode-bypass");
				lastSequence = admission.sequence;
				const ingressAt = admission.ingressAt ?? now();
				const graphemes = Array.from(segmenter.segment(admission.text), ({ segment }) => segment);
				const bytes = Buffer.byteLength(admission.text);
				options.onSlice({
					sequence: admission.sequence,
					generation: admission.generation,
					epoch,
					kind: admission.kind,
					contentIndex: admission.contentIndex,
					text: admission.text,
					ingressAt,
					reason: admission.folded ? "folded" : "off",
					graphemes: graphemes.length,
					bytes,
					remainingGraphemes: 0,
					finalForItem: true,
				});
				return { accepted: true, epoch };
			}

			const graphemes = Array.from(segmenter.segment(admission.text), ({ segment }) => segment);
			if (graphemes.length === 0) return { accepted: false, epoch };
			const graphemeBytes = graphemes.map((grapheme) => Buffer.byteLength(grapheme));
			const itemBytes = graphemeBytes.reduce((sum, value) => sum + value, 0);
			const queueWasEmpty = queue.length === 0;
			const item: QueueItem = {
				sequence: admission.sequence,
				generation: admission.generation,
				epoch,
				kind: admission.kind,
				contentIndex: admission.contentIndex,
				ingressAt: admission.ingressAt ?? now(),
				folded: admission.kind === "thinking" && admission.folded === true,
				graphemes,
				graphemeBytes,
				offset: 0,
			};
			lastSequence = admission.sequence;
			activeGeneration = admission.generation;
			if (queueWasEmpty) lastTickAt = now();
			queue.push(item);
			queuedGraphemes += graphemes.length;
			queuedBytes += itemBytes;
			if (!item.folded) credit += graphemes.length * arrivalCreditRatio;

			while (queuedGraphemes > maxQueueGraphemes || queuedBytes > maxQueueBytes) {
				const capacitySlice = dequeueInternal(maxSliceGraphemes, "capacity");
				if (!capacitySlice) break;
				if (capacitySlice.reason !== "folded") credit = Math.max(0, credit - capacitySlice.graphemes);
			}
			if (queue.length === 0) cancelTimer();
			else schedule();
			return { accepted: true, epoch };
		},
		dequeue(maxGraphemes = maxSliceGraphemes, reason = "tick") {
			if (disposed) return null;
			const slice = dequeueInternal(Math.max(1, Math.floor(maxGraphemes)), reason);
			if (slice && slice.reason !== "folded") credit = Math.max(0, credit - slice.graphemes);
			consumeFoldedHeads();
			if (queue.length === 0) cancelTimer();
			return slice;
		},
		flush,
		invalidateEpoch() {
			cancelTimer();
			for (const item of queue) options.onDiscard?.(item.sequence);
			queue = [];
			queuedGraphemes = 0;
			queuedBytes = 0;
			credit = 0;
			activeGeneration = null;
			epoch += 1;
			emittedInEpoch = false;
			lastTickAt = now();
			return epoch;
		},
		setMode(nextMode) {
			if (nextMode === mode) return;
			if (
				queue.length > 0 &&
				(nextMode === "off" || (nextMode === "auto" && !(options.isAutoPacingAllowed?.() ?? false)))
			) {
				flush("mode-change");
			}
			mode = nextMode;
			if (queue.length > 0) schedule();
		},
		snapshot() {
			return {
				mode,
				epoch,
				queuedItems: queue.length,
				queuedGraphemes,
				queuedBytes,
				oldestAgeMs: oldestAge(now()),
				credit,
				timerPending: timer !== null,
				disposed,
			};
		},
		dispose(reason = "dispose") {
			if (disposed) return { reason, fromEpoch: epoch, toEpoch: epoch, items: 0, graphemes: 0, bytes: 0 };
			cancelTimer();
			const detached = queue;
			queue = [];
			queuedGraphemes = 0;
			queuedBytes = 0;
			credit = 0;
			activeGeneration = null;
			epoch += 1;
			emittedInEpoch = false;
			lastTickAt = now();
			disposed = true;
			return drainDetached(detached, reason);
		},
	};

	return api;
}
