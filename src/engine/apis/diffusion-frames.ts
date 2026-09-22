/**
 * Diffusion frame streaming for dLLM providers.
 *
 * A diffusion model such as Inception Mercury does not emit tokens left to
 * right. With `diffusing: true` in the request, its stream carries the whole
 * response so far in every chunk: unresolved positions are noise that settles
 * over successive frames, and `diffusion_meta.diffusion_progress` runs from 0
 * to 1. pi-ai treats every `delta.content` as an append, so left alone those
 * frames concatenate into garbage. This module recognizes them on the wire,
 * marks the matching `text_delta` events, and rewrites the partial text to the
 * frame so the agent's own view of the message is always the current frame.
 *
 * Frames are requested only when the interactive TUI has enabled them. Headless
 * runs, ACP hosts and JSONL consumers expect deltas and never see a frame.
 */

import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

let framesEnabled = false;

/** The interactive surface turns frames on; every other entry point leaves them off. */
export function setDiffusionFramesEnabled(enabled: boolean): void {
	framesEnabled = enabled;
}

export function diffusionFramesEnabled(): boolean {
	return framesEnabled;
}

/** Runtimes whose chat endpoint understands the `diffusing` request field. */
export function runtimeStreamsDiffusionFrames(runtimeId: string | undefined): boolean {
	return runtimeId === "inception";
}

export interface DiffusionFrame {
	/** 0 to 1 as reported by the provider for this frame. */
	progress: number;
	/**
	 * The whole frame. Consumers read this rather than `partial`: pi-ai keeps
	 * appending to the shared block as later chunks arrive, so a consumer that
	 * lags by one event can see two frames glued together on the block while
	 * this field is always exactly one frame.
	 */
	text: string;
}

interface QueuedFrame {
	progress: number;
}

const FRAME_KEY = "diffusionFrame";

/** Read the frame marker off a `text_delta` event, if this event carries a whole frame. */
export function readDiffusionFrame(event: unknown): DiffusionFrame | null {
	if (event === null || typeof event !== "object") return null;
	const marker = (event as Record<string, unknown>)[FRAME_KEY];
	if (marker === null || typeof marker !== "object") return null;
	const { progress, text } = marker as Record<string, unknown>;
	return typeof progress === "number" && Number.isFinite(progress) && typeof text === "string"
		? { progress, text }
		: null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Record one wire chunk's frame, in arrival order. pi-ai emits exactly one
 * `text_delta` for each chunk whose `delta.content` is non-empty, and the
 * observer sees the bytes before pi-ai parses them, so the queue lines up with
 * the events that follow. A chunk without `diffusion_meta` is an ordinary
 * delta and records nothing.
 */
export function observeDiffusionFrameChunk(payload: Record<string, unknown>, queue: QueuedFrame[]): void {
	const meta = payload.diffusion_meta;
	if (!isRecord(meta) || meta.diffusion_content !== true) return;
	const choices = payload.choices;
	const first = Array.isArray(choices) ? choices[0] : undefined;
	const delta = isRecord(first) && isRecord(first.delta) ? first.delta : undefined;
	const content = delta?.content;
	if (typeof content !== "string" || content.length === 0) return;
	const progress = typeof meta.diffusion_progress === "number" ? meta.diffusion_progress : 0;
	queue.push({ progress: Math.min(1, Math.max(0, progress)) });
}

/**
 * Turn a `text_delta` whose content is a whole frame into a marked event.
 *
 * pi-ai appended the frame to the block it also hands out as `partial`, so the
 * block is rewritten to the frame here. The last such rewrite is what the
 * agent's context message and the final `done` message carry, because they
 * share the block object. Between events the block is not trustworthy: pi-ai
 * may already have appended the next chunk, so the frame itself rides on the
 * marker. The event's `delta` is emptied: a consumer that accumulates deltas
 * then sees nothing until the message settles rather than a concatenation of
 * frames.
 */
export function applyDiffusionFrame(event: AssistantMessageEvent, queue: QueuedFrame[]): AssistantMessageEvent {
	if (event.type !== "text_delta" || queue.length === 0) return event;
	const queued = queue.shift();
	if (!queued) return event;
	const frame: DiffusionFrame = { progress: queued.progress, text: event.delta };
	const block = event.partial.content[event.contentIndex];
	if (block && block.type === "text") block.text = frame.text;
	return { ...event, delta: "", [FRAME_KEY]: frame } as AssistantMessageEvent;
}

/** Add `diffusing: true` to an OpenAI-compatible request body. */
export function withDiffusingRequest(payload: unknown): unknown {
	return isRecord(payload) ? { ...payload, diffusing: true } : payload;
}

/**
 * Length of the prefix two consecutive frames agree on. Mercury resolves a
 * block before it starts the next, so the agreed prefix is the settled text
 * and everything after it is still denoising.
 */
export function settledPrefixLength(previous: string, next: string): number {
	const limit = Math.min(previous.length, next.length);
	let index = 0;
	while (index < limit && previous.charCodeAt(index) === next.charCodeAt(index)) index += 1;
	return index;
}
