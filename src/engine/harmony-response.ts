/**
 * Streaming parser for OpenAI Harmony response markers used by GPT-OSS.
 *
 * Some local OpenAI-compatible servers return the model's raw chat-template
 * text instead of normalized `content` / `reasoning_content` fields. In that
 * mode GPT-OSS can leak markers like
 * `<|start|>assistant<|channel|>final<|message|>` into visible output. This
 * parser consumes those markers and routes channel payloads into Clio's text
 * or thinking streams.
 */

import {
	type HarmonyReasoningEffort,
	harmonyReasoningEffort,
	isHarmonyThinkingFormat,
} from "../domains/providers/model-runtime-capabilities.js";

const START = "<|start|>";
const CHANNEL = "<|channel|>";
const CONSTRAIN = "<|constrain|>";
const MESSAGE = "<|message|>";
const RECIPIENT = "<|recipient|>";
const END = "<|end|>";
const RETURN = "<|return|>";

const MARKERS: ReadonlyArray<string> = [START, CHANNEL, CONSTRAIN, MESSAGE, RECIPIENT, END, RETURN];
const HEADER_METADATA_MARKERS: ReadonlyArray<string> = [CONSTRAIN, RECIPIENT];
const MAX_MARKER_LENGTH = MARKERS.reduce((max, marker) => Math.max(max, marker.length), 0);

export interface HarmonyParsedChunk {
	text: string;
	thinking: string;
}

type HarmonyRoute = "text" | "thinking";

export { type HarmonyReasoningEffort, harmonyReasoningEffort, isHarmonyThinkingFormat };

export class HarmonyResponseParser {
	private buffer = "";
	private route: HarmonyRoute = "text";

	push(chunk: string): HarmonyParsedChunk {
		if (!chunk) return emptyParsed();
		this.buffer += chunk;
		return this.drain(false);
	}

	flush(): HarmonyParsedChunk {
		return this.drain(true);
	}

	private drain(final: boolean): HarmonyParsedChunk {
		let text = "";
		let thinking = "";
		const emit = (value: string): void => {
			if (!value) return;
			if (this.route === "thinking") thinking += value;
			else text += value;
		};

		while (this.buffer.length > 0) {
			const parsedFrame = this.consumeFrameHeader();
			if (parsedFrame) continue;

			if (this.consumeExact(END) || this.consumeExact(RETURN)) continue;

			const markerIndex = firstMarkerIndex(this.buffer);
			if (markerIndex > 0) {
				emit(this.buffer.slice(0, markerIndex));
				this.buffer = this.buffer.slice(markerIndex);
				continue;
			}

			if (markerIndex === 0) {
				if (!final) break;
				// Unknown complete-ish marker at end of stream: drop only the
				// marker bytes and preserve following ordinary text if any.
				const marker = MARKERS.find((candidate) => this.buffer.startsWith(candidate));
				if (!marker) break;
				this.buffer = this.buffer.slice(marker.length);
				continue;
			}

			const hold = final ? 0 : harmonyPrefixTailLength(this.buffer);
			const emitLength = this.buffer.length - hold;
			if (emitLength <= 0) break;
			emit(this.buffer.slice(0, emitLength));
			this.buffer = this.buffer.slice(emitLength);
		}

		if (final && this.buffer.length > 0) {
			emit(this.buffer);
			this.buffer = "";
		}

		return { text, thinking };
	}

	private consumeFrameHeader(): boolean {
		if (this.buffer.startsWith(START)) {
			const channelIndex = this.buffer.indexOf(CHANNEL, START.length);
			if (channelIndex === -1) return false;
			const messageIndex = this.buffer.indexOf(MESSAGE, channelIndex + CHANNEL.length);
			if (messageIndex === -1) return false;
			this.setChannel(this.buffer.slice(channelIndex + CHANNEL.length, messageIndex));
			this.buffer = this.buffer.slice(messageIndex + MESSAGE.length);
			return true;
		}

		if (this.buffer.startsWith(CHANNEL)) {
			const messageIndex = this.buffer.indexOf(MESSAGE, CHANNEL.length);
			if (messageIndex === -1) return false;
			this.setChannel(this.buffer.slice(CHANNEL.length, messageIndex));
			this.buffer = this.buffer.slice(messageIndex + MESSAGE.length);
			return true;
		}

		return false;
	}

	private consumeExact(marker: string): boolean {
		if (!this.buffer.startsWith(marker)) return false;
		this.buffer = this.buffer.slice(marker.length);
		return true;
	}

	private setChannel(rawChannel: string): void {
		const metadataIndex = firstHeaderMetadataIndex(rawChannel);
		const channelText = metadataIndex === -1 ? rawChannel : rawChannel.slice(0, metadataIndex);
		const channel = (channelText.trim().split(/\s+/, 1)[0] ?? "").toLowerCase();
		this.route = channel === "final" ? "text" : "thinking";
	}
}

function emptyParsed(): HarmonyParsedChunk {
	return { text: "", thinking: "" };
}

function firstMarkerIndex(value: string): number {
	let first = -1;
	for (const marker of MARKERS) {
		const idx = value.indexOf(marker);
		if (idx !== -1 && (first === -1 || idx < first)) first = idx;
	}
	return first;
}

function firstHeaderMetadataIndex(value: string): number {
	let first = -1;
	for (const marker of HEADER_METADATA_MARKERS) {
		const idx = value.indexOf(marker);
		if (idx !== -1 && (first === -1 || idx < first)) first = idx;
	}
	return first;
}

function harmonyPrefixTailLength(value: string): number {
	const max = Math.min(value.length, MAX_MARKER_LENGTH - 1);
	for (let len = max; len > 0; len--) {
		const tail = value.slice(value.length - len);
		if (MARKERS.some((marker) => marker.startsWith(tail))) return len;
	}
	return 0;
}
