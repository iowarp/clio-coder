/**
 * Reasoning-capability probe for OpenAI-compatible HTTP endpoints.
 *
 * Local servers (LM Studio, llama.cpp, sglang, vllm, ...) advertise themselves
 * through an OpenAI-compatible surface regardless of whether the loaded model supports thinking.
 * Defaulting `caps.reasoning = false` means `/thinking` only ever surfaces
 * `["off"]` for these targets. Probing with a one-shot priming request reveals
 * the truth: a thinking-capable model emits a non-empty `reasoning_content`
 * (llama.cpp), `reasoning` (LM Studio + chat-templates), or `reasoning_text`
 * field in the streamed response. Caching the result per (endpoint, model)
 * keeps the cost to a single round-trip per session.
 */
import { performance } from "node:perf_hooks";

const PROMPT = "What is 2+2? Think briefly, then answer.";

export interface ProbeReasoningOptions {
	baseUrl: string;
	modelId: string;
	timeoutMs: number;
	apiKey?: string;
	signal?: AbortSignal;
}

export interface ProbeReasoningResult {
	reasoning: boolean;
	field?: "reasoning_content" | "reasoning" | "reasoning_text";
	latencyMs: number;
	error?: string;
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: unknown;
			reasoning_content?: unknown;
			reasoning?: unknown;
			reasoning_text?: unknown;
		};
	}>;
}

function nonEmptyString(value: unknown): boolean {
	return typeof value === "string" && value.trim().length > 0;
}

function detectReasoningField(data: ChatCompletionResponse): ProbeReasoningResult["field"] | null {
	const message = data.choices?.[0]?.message;
	if (!message) return null;
	if (nonEmptyString(message.reasoning_content)) return "reasoning_content";
	if (nonEmptyString(message.reasoning)) return "reasoning";
	if (nonEmptyString(message.reasoning_text)) return "reasoning_text";
	return null;
}

function trimTrailingSlash(url: string): string {
	return url.endsWith("/") ? url.slice(0, -1) : url;
}

export async function probeOpenAICompatReasoning(opts: ProbeReasoningOptions): Promise<ProbeReasoningResult> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, opts.timeoutMs);
	const onExternalAbort = () => controller.abort();
	if (opts.signal) {
		if (opts.signal.aborted) controller.abort();
		else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
	}

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.apiKey && opts.apiKey.length > 0) headers.authorization = `Bearer ${opts.apiKey}`;

	const body = JSON.stringify({
		model: opts.modelId,
		messages: [{ role: "user", content: PROMPT }],
		max_tokens: 200,
		temperature: 0,
		stream: false,
		reasoning_effort: "low",
	});

	const url = `${trimTrailingSlash(opts.baseUrl)}/v1/chat/completions`;
	const started = performance.now();
	try {
		const response = await fetch(url, {
			method: "POST",
			headers,
			body,
			signal: controller.signal,
		});
		const latencyMs = Math.round(performance.now() - started);
		if (!response.ok) {
			return { reasoning: false, latencyMs, error: `HTTP ${response.status}: ${response.statusText}` };
		}
		const data = (await response.json()) as ChatCompletionResponse;
		const field = detectReasoningField(data);
		if (field) return { reasoning: true, field, latencyMs };
		return { reasoning: false, latencyMs };
	} catch (err) {
		const latencyMs = Math.round(performance.now() - started);
		if (timedOut) return { reasoning: false, latencyMs, error: `timeout after ${opts.timeoutMs}ms` };
		if (opts.signal?.aborted) return { reasoning: false, latencyMs, error: "aborted by caller" };
		return { reasoning: false, latencyMs, error: err instanceof Error ? err.message : String(err) };
	} finally {
		clearTimeout(timer);
		if (opts.signal) opts.signal.removeEventListener("abort", onExternalAbort);
	}
}
