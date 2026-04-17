import { fetch } from "undici";
import { ToolNames } from "../core/tool-names.js";
import type { ToolResult, ToolSpec } from "./registry.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 2_000_000;

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
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const buf = Buffer.from(text, "utf8").subarray(0, maxBytes);
	return `${buf.toString("utf8")}\n[output truncated]`;
}

export const webFetchTool: ToolSpec = {
	name: ToolNames.WebFetch,
	description: "Fetch a URL over HTTP(S). Returns the response body as text on 2xx.",
	baseActionClass: "read",
	async run(args): Promise<ToolResult> {
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

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
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
			const text = await response.text();
			return { kind: "ok", output: truncate(text, maxBytes) };
		} catch (err) {
			if (err instanceof Error && err.name === "AbortError") {
				return { kind: "error", message: `web_fetch: timeout after ${timeoutMs}ms` };
			}
			const msg = err instanceof Error ? err.message : String(err);
			return { kind: "error", message: `web_fetch: ${msg}` };
		} finally {
			clearTimeout(timer);
		}
	},
};
