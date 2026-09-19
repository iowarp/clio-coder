import type { ChatRequest, ChatResponse } from "ollama";

/** Preserve structured Ollama errors, including context overflows inside a 200 stream. */
function errorText(detail: unknown): string {
	if (typeof detail === "string") return detail;
	if (detail && typeof detail === "object") {
		const { message, type } = detail as { message?: unknown; type?: unknown };
		const text = typeof message === "string" ? message : JSON.stringify(detail);
		return typeof type === "string" ? `${type}: ${text}` : text;
	}
	return String(detail);
}

interface RequestOptions {
	headers?: Record<string, string> | undefined;
	signal?: AbortSignal | undefined;
	fetch?: typeof fetch | undefined;
}

async function request(baseUrl: string, path: string, body: unknown, options: RequestOptions): Promise<Response> {
	options.signal?.throwIfAborted();
	const headers = new Headers(options.headers);
	headers.set("content-type", "application/json");
	const url = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/${path}`;
	if (new URL(url).origin === "https://ollama.com" && !headers.has("authorization") && process.env.OLLAMA_API_KEY) {
		headers.set("authorization", `Bearer ${process.env.OLLAMA_API_KEY}`);
	}
	const response = await (options.fetch ?? fetch)(url, {
		method: body === undefined ? "GET" : "POST",
		headers,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		...(options.signal ? { signal: options.signal } : {}),
	});
	if (!response.ok) {
		const text = await response.text();
		let detail = text;
		try {
			const parsed = JSON.parse(text) as { error?: unknown };
			if (parsed?.error !== undefined) detail = errorText(parsed.error);
		} catch {
			// Proxies also return plain text or HTML. Keep that response out of stdout.
		}
		throw new Error(detail.slice(0, 4000) || `HTTP ${response.status}: ${response.statusText}`);
	}
	return response;
}

/** Small metadata and unload requests have a deadline as well as caller cancellation. */
export async function ollamaJson<T>(
	baseUrl: string,
	path: string,
	body: unknown,
	options: RequestOptions = {},
): Promise<T> {
	const timeout = AbortSignal.timeout(3000);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const response = await request(baseUrl, path, body, { ...options, signal });
	const result = (await response.json()) as T & { error?: unknown };
	if (result?.error !== undefined) throw new Error(errorText(result.error));
	return result;
}

/** Own the response until done, cancellation, or failure; never print from the transport. */
export async function* streamOllamaChat(
	baseUrl: string,
	body: ChatRequest & { stream: true },
	options: RequestOptions,
): AsyncGenerator<ChatResponse> {
	const response = await request(baseUrl, "chat", body, options);
	if (!response.body) throw new Error("Ollama returned an empty response body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
			while (pending.length > 0) {
				const newline = pending.indexOf("\n");
				if (newline < 0 && !done) break;
				const line = newline < 0 ? pending : pending.slice(0, newline);
				pending = newline < 0 ? "" : pending.slice(newline + 1);
				if (line.length > 16 * 1024 * 1024) throw new Error("Ollama response frame exceeds 16 MiB");
				if (!line.trim()) continue;
				let chunk: ChatResponse & { error?: unknown };
				try {
					chunk = JSON.parse(line);
				} catch {
					throw new Error("Ollama returned invalid JSON in its response stream");
				}
				if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
					throw new Error("Ollama returned an invalid response frame");
				}
				if (chunk.error !== undefined) throw new Error(errorText(chunk.error));
				if (
					typeof chunk.done !== "boolean" ||
					(chunk.model !== undefined && typeof chunk.model !== "string") ||
					(!chunk.done && !chunk.message) ||
					(chunk.message !== undefined &&
						(!chunk.message || typeof chunk.message !== "object" || Array.isArray(chunk.message))) ||
					(chunk.message?.content !== undefined && typeof chunk.message.content !== "string") ||
					(chunk.message?.thinking !== undefined && typeof chunk.message.thinking !== "string") ||
					(chunk.message?.tool_calls !== undefined && !Array.isArray(chunk.message.tool_calls))
				) {
					throw new Error("Ollama returned an invalid response frame");
				}
				options.signal?.throwIfAborted();
				yield chunk;
				if (chunk.done) return;
			}
			if (done) throw new Error("Ollama response stream ended before its completion frame");
			if (pending.length > 16 * 1024 * 1024) throw new Error("Ollama response frame exceeds 16 MiB");
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
