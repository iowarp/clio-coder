import { Type } from "typebox";
import { fetch } from "undici";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2_000_000;
const TRUNCATION_MARKER = "\n[output truncated]";

function parseHeaders(raw: unknown): Record<string, string> | null {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) return null;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value !== "string") return null;
		out[key] = value;
	}
	return out;
}

function truncate(text: string, maxBytes: number): string {
	return truncateUtf8(text, maxBytes, TRUNCATION_MARKER);
}

function decodeUtf8Prefix(bytes: Buffer, maxBytes: number): string {
	let cut = Math.min(maxBytes, bytes.byteLength);
	while (cut > 0) {
		const nextByte = bytes[cut];
		if (nextByte === undefined || (nextByte & 0xc0) !== 0x80) break;
		cut -= 1;
	}
	return bytes.subarray(0, cut).toString("utf8");
}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			const chunk = Buffer.from(value);
			const remaining = maxBytes + 4 - totalBytes;
			if (remaining > 0) {
				const kept = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
				chunks.push(kept);
				totalBytes += kept.byteLength;
			}

			if (totalBytes > maxBytes || chunk.byteLength > remaining) {
				truncated = true;
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = Buffer.concat(chunks, totalBytes);
	if (truncated || bytes.byteLength > maxBytes) {
		return `${decodeUtf8Prefix(bytes, maxBytes)}${TRUNCATION_MARKER}`;
	}
	return bytes.toString("utf8");
}

export const webFetchTool: ToolSpec = {
	name: ToolNames.WebFetch,
	description:
		"Fetch a URL over HTTP(S). Returns the response body as text on 2xx; non-2xx becomes an error. Body is truncated at max_bytes (default 2 MB).",
	parameters: Type.Object({
		url: Type.String({ description: "Fully-qualified http:// or https:// URL." }),
		method: Type.Optional(Type.String({ description: "HTTP method. Defaults to GET. Case-insensitive." })),
		headers: Type.Optional(
			Type.Record(Type.String(), Type.String(), {
				description: "Request headers as a string→string map.",
			}),
		),
		body: Type.Optional(Type.String({ description: "Request body as a UTF-8 string (used with POST/PUT/etc.)." })),
		timeout_ms: Type.Optional(Type.Number({ description: "Abort after this many milliseconds. Defaults to 30000." })),
		max_bytes: Type.Optional(
			Type.Number({ description: "Truncate response body at this many bytes. Defaults to 2000000." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "parallel",
	async run(args, options): Promise<ToolResult> {
		const urlArg = typeof args.url === "string" ? args.url : null;
		if (!urlArg) return { kind: "error", message: "web_fetch: missing url argument" };

		let parsed: URL;
		try {
			parsed = new URL(urlArg);
		} catch {
			return { kind: "error", message: `web_fetch: invalid url: ${urlArg}` };
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			return { kind: "error", message: `web_fetch: unsupported scheme ${parsed.protocol} (must be http or https)` };
		}

		const method = typeof args.method === "string" && args.method.length > 0 ? args.method.toUpperCase() : "GET";
		const headers = parseHeaders(args.headers);
		if (headers === null) {
			return { kind: "error", message: "web_fetch: headers must be a Record<string,string>" };
		}
		const hasBody = typeof args.body === "string";
		const body = hasBody ? (args.body as string) : undefined;
		const timeoutMs = typeof args.timeout_ms === "number" && args.timeout_ms > 0 ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
		const maxBytes = typeof args.max_bytes === "number" && args.max_bytes > 0 ? args.max_bytes : DEFAULT_MAX_BYTES;

		const externalSignal = options?.signal;
		const controller = new AbortController();
		// Track which source caused the abort so the catch can disambiguate.
		// External (caller-initiated) wins ties because user-initiated cancel
		// is the more informative error to surface.
		let externalAborted = false;
		let timedOut = false;

		const onExternalAbort = (): void => {
			externalAborted = true;
			controller.abort();
		};

		if (externalSignal?.aborted) {
			onExternalAbort();
		} else {
			externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
		}

		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		try {
			const init: Parameters<typeof fetch>[1] = {
				method,
				headers,
				signal: controller.signal,
			};
			if (body !== undefined) init.body = body;
			const response = await fetch(parsed, init);
			if (response.status < 200 || response.status >= 300) {
				return {
					kind: "error",
					message: `web_fetch: HTTP ${response.status}: ${response.statusText}`,
				};
			}
			const text = await readResponseText(response, maxBytes);
			return { kind: "ok", output: truncate(text, maxBytes) };
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				if (externalAborted) {
					return { kind: "error", message: "web_fetch: request aborted" };
				}
				if (timedOut) {
					return { kind: "error", message: `web_fetch: timeout after ${timeoutMs}ms` };
				}
				// Defensive fallback: AbortError with neither flag set should not
				// happen, but treat it as an external cancel rather than a timeout.
				return { kind: "error", message: "web_fetch: request aborted" };
			}
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `web_fetch: ${msg}` };
		} finally {
			clearTimeout(timer);
			externalSignal?.removeEventListener("abort", onExternalAbort);
		}
	},
};
