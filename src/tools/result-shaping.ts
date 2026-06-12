import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir } from "../core/xdg.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { truncateUtf8 } from "./truncate-utf8.js";

// Backstop for tools without an explicit resultSizePolicy. Sits slightly
// above the 6KB per-observation source cap (src/tools/truncate.ts) so a
// tool's own truncation notice survives shaping instead of being cut again.
export const DEFAULT_TOOL_RESULT_MAX_BYTES = 8 * 1024;
const RESULT_TRUNCATION_MARKER = "\n[tool result truncated]";
const RESULT_OFFLOAD_MAX_BYTES = 10 * 1024 * 1024;

type ToolResultShapeContext = Pick<ToolInvokeOptions, "sessionId" | "toolCallId">;

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function mergeDetails(details: ToolResultDetails | undefined, resultSize: Record<string, unknown>): ToolResultDetails {
	return { ...(details ?? {}), resultSize };
}

function maxBytesFor(spec: ToolSpec): number {
	const configured = spec.metadata?.resultSizePolicy?.maxBytes;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0
		? Math.floor(configured)
		: DEFAULT_TOOL_RESULT_MAX_BYTES;
}

function followUpHint(spec: ToolSpec): string {
	return (
		spec.metadata?.resultSizePolicy?.followUpHint ??
		"Use a narrower query, offset/limit arguments, or a more specific tool call to inspect the omitted content."
	);
}

function resultSizeDetails(details: ToolResultDetails | undefined): Record<string, unknown> | null {
	const candidate = details?.resultSize;
	return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
		? (candidate as Record<string, unknown>)
		: null;
}

function existingOffloadPath(details: ToolResultDetails | undefined): string | null {
	const offloadPath = resultSizeDetails(details)?.offloadPath;
	return typeof offloadPath === "string" && offloadPath.length > 0 ? offloadPath : null;
}

function safePathSegment(value: string): string {
	const safe = value
		.trim()
		.replace(/[^A-Za-z0-9._-]/g, "_")
		.slice(0, 128);
	return safe.length > 0 ? safe : "unnamed";
}

function timestampSegment(): string {
	return new Date().toISOString().replace(/[^A-Za-z0-9._-]/g, "_");
}

function offloadBody(text: string, bytes: number): string {
	if (bytes <= RESULT_OFFLOAD_MAX_BYTES) return text;
	const notice = `\n[clio scratch output truncated at ${RESULT_OFFLOAD_MAX_BYTES} bytes; original size ${bytes} bytes]`;
	const prefixBudget = RESULT_OFFLOAD_MAX_BYTES - byteLength(notice);
	return `${truncateUtf8(text, Math.max(0, prefixBudget), "")}${notice}`;
}

function writeOffload(text: string, bytes: number, context: ToolResultShapeContext | undefined): string | null {
	try {
		const sessionId = safePathSegment(context?.sessionId ?? "no-session");
		const callId = safePathSegment(context?.toolCallId ?? timestampSegment());
		const dir = join(clioDataDir(), "scratch", sessionId);
		const path = join(dir, `${callId}.txt`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, offloadBody(text, bytes), "utf8");
		return path;
	} catch {
		return null;
	}
}

function bracketedHint(spec: ToolSpec, offloadPath: string | null): string {
	const hint = followUpHint(spec);
	if (offloadPath === null) return hint;
	return `${hint} Full output saved to ${offloadPath}; read it with offset and limit to inspect the rest.`;
}

export function shapeToolResult(spec: ToolSpec, result: ToolResult, context?: ToolResultShapeContext): ToolResult {
	if (existingOffloadPath(result.details) !== null) return result;
	const maxBytes = maxBytesFor(spec);
	const text = result.kind === "ok" ? result.output : result.message;
	const bytes = byteLength(text);
	if (bytes <= maxBytes) return result;
	const truncated = truncateUtf8(text, maxBytes, RESULT_TRUNCATION_MARKER);
	const offloadPath = writeOffload(text, bytes, context);
	const resultSize = {
		bytes,
		shownBytes: byteLength(truncated),
		maxBytes,
		truncated: true,
		policy: spec.metadata?.resultSizePolicy?.kind ?? "truncate",
		followUpHint: followUpHint(spec),
		...(offloadPath !== null ? { offloadPath } : {}),
	};
	if (result.kind === "ok") {
		return {
			...result,
			output: `${truncated}\n\n[${bracketedHint(spec, offloadPath)}]`,
			details: mergeDetails(result.details, resultSize),
		};
	}
	return {
		...result,
		message: `${truncated}\n\n[${bracketedHint(spec, offloadPath)}]`,
		details: mergeDetails(result.details, resultSize),
	};
}
