/**
 * Live tool-call probe. A target can list its models and still break on the
 * first streamed tool call, which is the most common local-model failure. This
 * probe sends one bounded request through the engine dispatcher a turn runs on,
 * with the runtime's synthesized model, so it cannot pass while a turn fails.
 *
 * It generates tokens and can load a cold model, so callers run it only when
 * the operator asked for it (`targets --probe --tools`).
 */
import { performance } from "node:perf_hooks";
import { Type } from "typebox";
import { streamSimple, validateEngineToolArguments } from "../../../engine/ai.js";
import type { EngineModel } from "../../../engine/types.js";

export const TOOL_PROBE_TOOL_NAME = "record_sum";

const TOOL = {
	name: TOOL_PROBE_TOOL_NAME,
	description: "Record the sum of two integers.",
	parameters: Type.Object(
		{
			a: Type.Integer({ description: "First addend." }),
			b: Type.Integer({ description: "Second addend." }),
		},
		{ additionalProperties: false },
	),
};

const PROMPT = `Call the ${TOOL_PROBE_TOOL_NAME} tool exactly once with a=2 and b=3. Do not answer in text.`;

/** Enough for one small call, with room for a short preamble. */
const MAX_TOKENS = 256;

export interface ProbeToolCallOptions {
	model: EngineModel;
	timeoutMs: number;
	apiKey?: string;
	signal?: AbortSignal;
	/** Test seam. Production uses the engine dispatcher a turn runs on. */
	streamFn?: typeof streamSimple;
}

export interface ProbeToolCallResult {
	ok: boolean;
	/** More than one stream frame (or, when the transport is opaque, delta) arrived before done. */
	streamed: boolean;
	/** Frames the server sent for the response body; null when the transport was not observable. */
	frames: number | null;
	/** Content deltas the engine emitted before done. */
	deltas: number;
	toolCall: boolean;
	/** Arguments parsed as JSON and matched the tool schema. */
	argumentsValid: boolean;
	latencyMs: number;
	error?: string;
}

interface FrameCounter {
	frames: number | null;
}

/**
 * Count response frames at the transport: SSE `data:` events, or JSON lines
 * for NDJSON. A single JSON body, pretty-printed or not, counts as one frame,
 * so a server that ignores `stream: true` is caught whatever content type it
 * claims.
 */
function framesIn(line: string): number {
	if (line.startsWith("data:")) return line.slice(5).trim() === "[DONE]" ? 0 : 1;
	return line.startsWith("{") ? 1 : 0;
}

function countingFetch(counter: FrameCounter): typeof fetch {
	return async (input, init) => {
		const response = await globalThis.fetch(input, init);
		if ((init?.method ?? "GET").toUpperCase() !== "POST" || !response.ok || !response.body) return response;
		counter.frames = 0;
		const decoder = new TextDecoder();
		let buffer = "";
		const count = (text: string) => {
			buffer += text;
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) counter.frames = (counter.frames ?? 0) + framesIn(line);
		};
		const body = response.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					count(decoder.decode(chunk, { stream: true }));
					controller.enqueue(chunk);
				},
				flush() {
					count(`${decoder.decode()}\n`);
				},
			}),
		);
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}

interface ObservedCall {
	name: string;
	arguments: Record<string, unknown>;
	raw: string;
}

function checkArguments(call: ObservedCall): string | null {
	let args: unknown = call.arguments;
	if (call.raw.trim().length > 0) {
		try {
			args = JSON.parse(call.raw);
		} catch (err) {
			return `tool call arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
		}
	}
	if (args === null || typeof args !== "object" || Array.isArray(args)) {
		return "tool call arguments are not a JSON object";
	}
	try {
		validateEngineToolArguments(TOOL, {
			type: "toolCall",
			id: "probe",
			name: call.name,
			arguments: args as Record<string, unknown>,
		});
		return null;
	} catch (err) {
		return `tool call arguments do not match the schema: ${err instanceof Error ? err.message : String(err)}`;
	}
}

export async function probeToolCall(opts: ProbeToolCallOptions): Promise<ProbeToolCallResult> {
	const controller = new AbortController();
	let timedOut = false;
	let rejectAbort: (reason: Error) => void = () => {};
	const aborted = new Promise<never>((_, reject) => {
		rejectAbort = reject;
	});
	// The race below settles the probe even if a transport ignores the signal.
	aborted.catch(() => {});
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
		rejectAbort(new Error("timeout"));
	}, opts.timeoutMs);
	const onExternalAbort = () => {
		controller.abort();
		rejectAbort(new Error("aborted"));
	};
	if (opts.signal) {
		if (opts.signal.aborted) onExternalAbort();
		else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
	}

	const counter: FrameCounter = { frames: null };
	let deltas = 0;
	const raw = new Map<number, string>();
	const calls: ObservedCall[] = [];
	let argumentsValid = false;
	const started = performance.now();
	const outcome = (error?: string): ProbeToolCallResult => {
		const result: ProbeToolCallResult = {
			ok: error === undefined,
			streamed: counter.frames !== null ? counter.frames > 1 : deltas > 1,
			frames: counter.frames,
			deltas,
			toolCall: calls.length > 0,
			argumentsValid,
			latencyMs: Math.round(performance.now() - started),
		};
		if (error !== undefined) result.error = error;
		return result;
	};

	const consume = async (): Promise<ProbeToolCallResult> => {
		const send = opts.streamFn ?? streamSimple;
		const context = {
			systemPrompt: "You are a tool-calling test harness. Answer only with the requested tool call.",
			messages: [{ role: "user", content: [{ type: "text", text: PROMPT }], timestamp: Date.now() }],
			tools: [TOOL],
		};
		const options: Record<string, unknown> = {
			maxTokens: MAX_TOKENS,
			signal: controller.signal,
			fetch: countingFetch(counter),
		};
		if (opts.apiKey !== undefined) options.apiKey = opts.apiKey;
		const events = await send(
			opts.model,
			context as unknown as Parameters<typeof streamSimple>[1],
			options as unknown as Parameters<typeof streamSimple>[2],
		);
		for await (const event of events) {
			if (
				(event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
				event.delta.length > 0
			) {
				deltas += 1;
			}
			if (event.type === "toolcall_delta") raw.set(event.contentIndex, (raw.get(event.contentIndex) ?? "") + event.delta);
			if (event.type === "toolcall_end") {
				calls.push({
					name: event.toolCall.name,
					arguments: event.toolCall.arguments,
					raw: raw.get(event.contentIndex) ?? "",
				});
			}
			if (event.type === "error") {
				return outcome(event.error.errorMessage ?? "stream failed");
			}
			if (event.type === "done") break;
		}
		const first = calls[0];
		if (!first) return outcome("no tool call in the response");
		if (first.name !== TOOL_PROBE_TOOL_NAME) return outcome(`called unknown tool '${first.name}'`);
		const argumentError = checkArguments(first);
		if (argumentError) return outcome(argumentError);
		argumentsValid = true;
		if (!outcome().streamed) {
			const seen = counter.frames !== null ? `${counter.frames} frame` : `${deltas} delta`;
			return outcome(`response was not streamed (${seen}${seen.startsWith("1 ") ? "" : "s"} before done)`);
		}
		return outcome();
	};

	try {
		return await Promise.race([consume(), aborted]);
	} catch (err) {
		if (timedOut) return outcome(`timeout after ${opts.timeoutMs}ms`);
		if (opts.signal?.aborted) return outcome("aborted by caller");
		return outcome(err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
	}
}
