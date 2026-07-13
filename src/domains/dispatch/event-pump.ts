/**
 * Domain-owned eager event ingestion for dispatched runs.
 *
 * Correctness-critical event folding (token metering, tool stats, finish
 * contract, assistant output capture) used to run as a side effect of an
 * external consumer iterating the returned event stream. A fast worker could
 * finish before anyone iterated, sealing a zero-token receipt. The pump
 * inverts that: the dispatch domain starts consuming the source stream the
 * moment a run is registered, folds every event itself, and hands external
 * consumers a bounded replay tee. Receipts never depend on whether a UI or
 * tool happened to subscribe.
 *
 * The tee is bounded (drop-oldest) so an absent or abandoned consumer cannot
 * grow memory: the source channel (worker-spawn) already buffers unboundedly,
 * and duplicating that here would double the hazard. Dropped events only
 * degrade live display; every receipt-bearing fact was already folded.
 */

import { truncateUtf8 } from "../../tools/truncate-utf8.js";
import type { RunReceiptOutput } from "./types.js";

/** Bounded replay capacity for the external consumer tee. */
export const EVENT_TEE_LIMIT = 1024;

export interface DispatchEventPump {
	/** Single-consumer bounded replay of the source stream, oldest first. */
	events: AsyncIterableIterator<unknown>;
	/** Settles when every source event has been folded (source exhausted). */
	done: Promise<void>;
	/** Events dropped from the tee because no consumer kept pace. */
	droppedEvents(): number;
}

export interface StartDispatchEventPumpOptions {
	/** Synthetic events delivered to the consumer before source events (e.g. route warnings). Not folded. */
	prelude?: ReadonlyArray<unknown>;
	limit?: number;
	/** Invoked for fold or source-iteration failures; ingestion continues where possible. */
	onError?: (error: unknown) => void;
	/** Domain-owned live projection invoked once for every consumer-visible event. */
	onEvent?: (event: unknown) => void;
}

/**
 * Start consuming `source` immediately, folding every event through `fold`
 * and buffering it for one external consumer. A fold failure is reported and
 * skipped so one malformed event cannot starve the meters behind it; a source
 * failure ends the pump. The consumer's early `return()` abandons the tee
 * without stopping ingestion.
 */
export function startDispatchEventPump(
	source: AsyncIterable<unknown>,
	fold: (event: unknown) => void,
	options: StartDispatchEventPumpOptions = {},
): DispatchEventPump {
	const limit = options.limit ?? EVENT_TEE_LIMIT;
	const pending: unknown[] = [...(options.prelude ?? [])];
	const waiters: Array<(result: IteratorResult<unknown>) => void> = [];
	let finished = false;
	let abandoned = false;
	let dropped = 0;

	const push = (value: unknown): void => {
		if (abandoned) return;
		const waiter = waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return;
		}
		pending.push(value);
		while (pending.length > limit) {
			pending.shift();
			dropped += 1;
		}
	};

	const end = (): void => {
		finished = true;
		while (waiters.length > 0) {
			waiters.shift()?.({ value: undefined, done: true });
		}
	};
	const notify = (event: unknown): void => {
		try {
			options.onEvent?.(event);
		} catch (error) {
			options.onError?.(error);
		}
	};

	const done = (async (): Promise<void> => {
		try {
			for (const event of options.prelude ?? []) notify(event);
			for await (const event of source) {
				try {
					fold(event);
				} catch (error) {
					options.onError?.(error);
				}
				notify(event);
				push(event);
			}
		} catch (error) {
			options.onError?.(error);
		} finally {
			end();
		}
	})();

	const events: AsyncIterableIterator<unknown> = {
		next(): Promise<IteratorResult<unknown>> {
			if (pending.length > 0) {
				return Promise.resolve({ value: pending.shift(), done: false });
			}
			if (finished || abandoned) return Promise.resolve({ value: undefined, done: true });
			return new Promise<IteratorResult<unknown>>((resolve) => {
				waiters.push(resolve);
			});
		},
		return(): Promise<IteratorResult<unknown>> {
			abandoned = true;
			pending.length = 0;
			while (waiters.length > 0) {
				waiters.shift()?.({ value: undefined, done: true });
			}
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
			return this;
		},
	};

	return { events, done, droppedEvents: () => dropped };
}

/**
 * Byte bound on the assistant output text sealed into a receipt. Large enough
 * for a substantive final answer, small enough that receipts stay cheap to
 * read and render; overflow is recorded explicitly via `truncated`/`bytes`.
 */
export const WORKER_OUTPUT_MAX_BYTES = 8192;
const WORKER_OUTPUT_TRUNCATION_MARKER = "\n[worker output truncated]";

export interface WorkerOutputCapture {
	observe(event: unknown): void;
	snapshot(): RunReceiptOutput | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assistantTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => {
			if (typeof block === "string") return block;
			if (!isRecord(block)) return "";
			return typeof block.text === "string" ? block.text : "";
		})
		.join("");
}

function isDurableAssistantMessage(message: Record<string, unknown>): boolean {
	const stopReason = message.stopReason;
	if (stopReason === "toolUse" || stopReason === "error" || stopReason === "aborted" || stopReason === "cancelled") {
		return false;
	}
	if (!Array.isArray(message.content)) return true;
	return !message.content.some((block) => isRecord(block) && block.type === "toolCall");
}

/**
 * Extract text only from a completed, durable assistant answer. Tool-use
 * preambles are intermediate even when an event projection has stripped the
 * structured call block. Known failure messages are outcome detail, not a
 * successful worker answer. All other terminal spellings (including ACP's
 * `end_turn`) remain provider-compatible.
 */
export function durableAssistantTextFromEvent(event: unknown): string {
	if (!isRecord(event) || event.type !== "message_end" || !isRecord(event.message)) return "";
	if (event.message.role !== "assistant" || !isDurableAssistantMessage(event.message)) return "";
	return assistantTextFromContent(event.message.content);
}

function boundedOutput(state: RunReceiptOutput["state"], text: string): RunReceiptOutput {
	const bytes = Buffer.byteLength(text, "utf8");
	const bounded = truncateUtf8(text, WORKER_OUTPUT_MAX_BYTES, WORKER_OUTPUT_TRUNCATION_MARKER);
	return { state, text: bounded, bytes, truncated: bounded !== text };
}

/**
 * Fold assistant output out of a run's event stream so the receipt can carry
 * a durable, bounded copy. A completed assistant `message_end` becomes the
 * final answer only when it ended as normal text (`stop`/`length`, with no
 * structured tool call). Tool-use preambles are intermediate and never enter
 * durable output. Streaming `text_delta` fragments accumulate as the in-flight
 * partial and are discarded when their message completes. A run that ends
 * with unflushed deltas (abort, stall, kill mid-message) therefore snapshots
 * as `partial`, never as final. Accumulation is bounded in memory by the same
 * byte cap the receipt uses; overflow only marks truncation.
 */
export function createWorkerOutputCapture(): WorkerOutputCapture {
	let finalText: string | null = null;
	let partialText = "";
	let partialBytes = 0;
	let partialStored = 0;

	return {
		observe(event: unknown): void {
			if (!isRecord(event)) return;
			if (event.type === "message_end") {
				// Any message boundary flushes the in-flight stream: its deltas
				// belong to the message that just completed.
				const message = isRecord(event.message) ? event.message : null;
				partialText = "";
				partialBytes = 0;
				partialStored = 0;
				if (message === null || message.role !== "assistant") return;
				if (!isDurableAssistantMessage(message)) return;
				const text = assistantTextFromContent(message.content).trim();
				if (text.length > 0) finalText = text;
				return;
			}
			if (event.type !== "message_update") return;
			const assistantEvent = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : null;
			if (assistantEvent === null || assistantEvent.type !== "text_delta") return;
			const delta = assistantEvent.delta;
			if (typeof delta !== "string" || delta.length === 0) return;
			partialBytes += Buffer.byteLength(delta, "utf8");
			if (partialStored < WORKER_OUTPUT_MAX_BYTES) {
				partialText += delta;
				partialStored += Buffer.byteLength(delta, "utf8");
			}
		},
		snapshot(): RunReceiptOutput | undefined {
			if (partialBytes > 0 && partialText.trim().length > 0) {
				const bounded = truncateUtf8(partialText.trim(), WORKER_OUTPUT_MAX_BYTES, WORKER_OUTPUT_TRUNCATION_MARKER);
				return {
					state: "partial",
					text: bounded,
					bytes: partialBytes,
					truncated: bounded !== partialText.trim() || partialBytes > partialStored,
				};
			}
			if (finalText !== null) return boundedOutput("final", finalText);
			return undefined;
		},
	};
}
