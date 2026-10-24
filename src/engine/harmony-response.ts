/**
 * Streaming frame reader for the OpenAI Harmony response format used by gpt-oss.
 *
 * Some OpenAI-compatible servers return the model's raw chat-template text
 * instead of normalized `content`, `reasoning_content` and `tool_calls` fields.
 * vLLM does so whenever it runs without `--reasoning-parser openai_gptoss` or
 * `--tool-call-parser openai`, and ALCF Sophia is such a vLLM deployment whose
 * flags the operator does not control (#435). In that mode gpt-oss leaks frames
 * such as `<|start|>assistant<|channel|>final<|message|>` into visible output
 * (#23) and addresses tool calls to `functions.<name>` on the commentary
 * channel. This parser reads the header grammar
 *
 *   <|start|>{role}[ to={recipient}]<|channel|>{channel}[ to={recipient}]
 *       [ <|constrain|>{type} | {type}]<|message|>{body}
 *
 * terminated by `<|end|>`, `<|return|>` or `<|call|>`, and routes each body
 * into a typed segment: text (final channel), thinking (analysis, commentary
 * without a tool recipient, and any recipient outside `functions.*`) or tool
 * (`to=functions.<name>` in either header position). It is stream safe: a
 * marker split across chunks is held until it completes or is ruled out, and
 * a tool segment the stream ends without `<|call|>` is flushed as incomplete.
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
const CALL = "<|call|>";

const MARKERS: ReadonlyArray<string> = [START, CHANNEL, CONSTRAIN, MESSAGE, RECIPIENT, END, RETURN, CALL];
/** Markers that only carry header metadata; stray in a body they are dropped. */
const BODY_NOISE_MARKERS: ReadonlyArray<string> = [CONSTRAIN, MESSAGE, RECIPIENT];
const MAX_MARKER_LENGTH = MARKERS.reduce((max, marker) => Math.max(max, marker.length), 0);
const FUNCTIONS_PREFIX = "functions.";

export type HarmonySegment =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string; channel: string; note?: string }
	| { kind: "tool"; name: string; argsText: string; incomplete: boolean; constrain?: string };

type HarmonyRoute =
	| { kind: "text" }
	| { kind: "thinking"; channel: string; note?: string }
	| { kind: "tool"; name: string; argsText: string; constrain?: string };

interface HarmonyHeader {
	channel: string | null;
	recipient: string | null;
	constrain: string | null;
}

export { type HarmonyReasoningEffort, harmonyReasoningEffort, isHarmonyThinkingFormat };

/**
 * A tool name a Harmony model addressed, after the `functions.` namespace is
 * removed. A name that still carries a marker, a `to=` clause or whitespace is
 * a provider artifact, such as the `assistant<|channel|>analysis` tool call
 * vLLM returns when a stray `commentary to=assistant` header reaches its
 * tool-call parser (vllm#58825); it is never executed or reported as unknown.
 */
export type HarmonyToolName = { name: string } | { artifact: string };

export function normalizeHarmonyToolName(raw: string): HarmonyToolName {
	const name = raw.startsWith(FUNCTIONS_PREFIX) ? raw.slice(FUNCTIONS_PREFIX.length) : raw;
	if (name.length === 0) return { artifact: "empty tool name" };
	if (name.includes("<|")) return { artifact: `tool name '${name}' carries a Harmony marker` };
	if (name.includes("to=")) return { artifact: `tool name '${name}' carries a recipient clause` };
	if (/\s/.test(name)) return { artifact: `tool name '${name}' carries whitespace` };
	return { name };
}

export class HarmonyResponseParser {
	private buffer = "";
	private route: HarmonyRoute = { kind: "text" };
	private sawMarker = false;

	/** True once any Harmony marker was consumed, so the stream was raw Harmony. */
	get markersSeen(): boolean {
		return this.sawMarker;
	}

	push(chunk: string): HarmonySegment[] {
		if (!chunk) return [];
		this.buffer += chunk;
		return this.drain(false);
	}

	flush(): HarmonySegment[] {
		const out = this.drain(true);
		this.closeRoute(out, false);
		this.route = { kind: "text" };
		return out;
	}

	private drain(final: boolean): HarmonySegment[] {
		const out: HarmonySegment[] = [];

		while (this.buffer.length > 0) {
			if (this.buffer.startsWith(START) || this.buffer.startsWith(CHANNEL)) {
				if (this.consumeFrameHeader(out)) continue;
				if (!final) break;
				// A header the stream ended inside: drop the marker and keep the
				// text that followed it, as the earlier parser did (#23).
				this.sawMarker = true;
				this.buffer = this.buffer.slice(this.buffer.startsWith(START) ? START.length : CHANNEL.length);
				continue;
			}

			if (this.consumeExact(CALL)) {
				this.closeRoute(out, true);
				this.route = { kind: "text" };
				continue;
			}
			if (this.consumeExact(END) || this.consumeExact(RETURN)) {
				this.closeRoute(out, false);
				this.route = { kind: "text" };
				continue;
			}

			const markerIndex = firstMarkerIndex(this.buffer);
			if (markerIndex > 0) {
				this.emit(out, this.buffer.slice(0, markerIndex));
				this.buffer = this.buffer.slice(markerIndex);
				continue;
			}

			if (markerIndex === 0) {
				const noise = BODY_NOISE_MARKERS.find((marker) => this.buffer.startsWith(marker));
				if (noise === undefined) break;
				this.sawMarker = true;
				this.buffer = this.buffer.slice(noise.length);
				continue;
			}

			const hold = final ? 0 : harmonyPrefixTailLength(this.buffer);
			const emitLength = this.buffer.length - hold;
			if (emitLength <= 0) break;
			this.emit(out, this.buffer.slice(0, emitLength));
			this.buffer = this.buffer.slice(emitLength);
		}

		if (final && this.buffer.length > 0) {
			this.emit(out, this.buffer);
			this.buffer = "";
		}

		return out;
	}

	/**
	 * Consume one frame header when the buffer holds it whole. A header without
	 * a channel (`<|start|>assistant<|message|>`) is a final-channel frame.
	 */
	private consumeFrameHeader(out: HarmonySegment[]): boolean {
		const messageIndex = this.buffer.indexOf(MESSAGE);
		if (messageIndex === -1) return false;
		let roleText = "";
		let channelText: string | null = null;
		if (this.buffer.startsWith(START)) {
			const channelIndex = this.buffer.indexOf(CHANNEL, START.length);
			if (channelIndex !== -1 && channelIndex < messageIndex) {
				roleText = this.buffer.slice(START.length, channelIndex);
				channelText = this.buffer.slice(channelIndex + CHANNEL.length, messageIndex);
			} else {
				roleText = this.buffer.slice(START.length, messageIndex);
			}
		} else {
			channelText = this.buffer.slice(CHANNEL.length, messageIndex);
		}
		this.sawMarker = true;
		this.buffer = this.buffer.slice(messageIndex + MESSAGE.length);
		// A frame header ends whatever message was open, even without its own
		// terminator, so an unterminated tool body is flushed as incomplete.
		this.closeRoute(out, false);
		this.route = routeFor(parseHeader(roleText, channelText));
		return true;
	}

	private consumeExact(marker: string): boolean {
		if (!this.buffer.startsWith(marker)) return false;
		this.sawMarker = true;
		this.buffer = this.buffer.slice(marker.length);
		return true;
	}

	private emit(out: HarmonySegment[], value: string): void {
		if (!value) return;
		const route = this.route;
		if (route.kind === "tool") {
			route.argsText += value;
			return;
		}
		const last = out[out.length - 1];
		if (last !== undefined && last.kind === "text" && route.kind === "text") {
			last.text += value;
			return;
		}
		if (
			last !== undefined &&
			last.kind === "thinking" &&
			route.kind === "thinking" &&
			last.note === route.note &&
			last.channel === route.channel
		) {
			last.text += value;
			return;
		}
		out.push(
			route.kind === "text"
				? { kind: "text", text: value }
				: {
						kind: "thinking",
						text: value,
						channel: route.channel,
						...(route.note !== undefined ? { note: route.note } : {}),
					},
		);
	}

	private closeRoute(out: HarmonySegment[], complete: boolean): void {
		const route = this.route;
		if (route.kind !== "tool") return;
		out.push({
			kind: "tool",
			name: route.name,
			argsText: route.argsText,
			incomplete: !complete,
			...(route.constrain !== undefined ? { constrain: route.constrain } : {}),
		});
	}
}

function parseHeader(roleText: string, channelText: string | null): HarmonyHeader {
	const header: HarmonyHeader = { channel: null, recipient: null, constrain: null };
	const roleTokens = tokenize(roleText);
	for (let i = 1; i < roleTokens.length; i++) applyHeaderToken(header, roleTokens, i);
	if (channelText !== null) {
		const channelTokens = tokenize(channelText);
		header.channel = (channelTokens[0] ?? "").toLowerCase();
		for (let i = 1; i < channelTokens.length; i++) applyHeaderToken(header, channelTokens, i);
	}
	return header;
}

function tokenize(text: string): string[] {
	return text
		.split(CONSTRAIN)
		.join(` ${CONSTRAIN} `)
		.split(RECIPIENT)
		.join(` ${RECIPIENT} `)
		.trim()
		.split(/\s+/)
		.filter((token) => token.length > 0);
}

function applyHeaderToken(header: HarmonyHeader, tokens: string[], index: number): void {
	const token = tokens[index] ?? "";
	const previous = tokens[index - 1] ?? "";
	if (token === CONSTRAIN || token === RECIPIENT) return;
	if (previous === RECIPIENT) {
		header.recipient = token;
		return;
	}
	if (token.startsWith("to=")) {
		header.recipient = token.slice("to=".length);
		return;
	}
	// `<|constrain|>json` and the bare ` json` form both name the body type.
	header.constrain = token.toLowerCase();
}

function routeFor(header: HarmonyHeader): HarmonyRoute {
	if (header.recipient !== null) {
		if (header.recipient.startsWith(FUNCTIONS_PREFIX)) {
			return {
				kind: "tool",
				name: header.recipient.slice(FUNCTIONS_PREFIX.length),
				argsText: "",
				...(header.constrain !== null ? { constrain: header.constrain } : {}),
			};
		}
		// Built-in recipients (browser.*, python) are never executed by Clio.
		return {
			kind: "thinking",
			channel: header.channel ?? "commentary",
			note: `recipient ${header.recipient} is not a function`,
		};
	}
	if (header.channel === null || header.channel === "final") return { kind: "text" };
	return { kind: "thinking", channel: header.channel };
}

function firstMarkerIndex(value: string): number {
	let first = -1;
	for (const marker of MARKERS) {
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
