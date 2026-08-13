import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { clioStateDir } from "../core/xdg.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { DEFAULT_MAX_BYTES } from "./truncate.js";
import { byteLength, truncateUtf8 } from "./truncate-utf8.js";

// Backstop for tools without an explicit resultSizePolicy. Sits above the
// per-observation source cap (src/tools/truncate.ts) so a tool's own truncation
// notice (with its precise continuation offset) survives shaping instead of
// being cut again and replaced by a generic hint.
export const DEFAULT_TOOL_RESULT_MAX_BYTES = DEFAULT_MAX_BYTES + 2 * 1024;
const RESULT_TRUNCATION_MARKER = "\n[tool result truncated]";
const RESULT_OFFLOAD_MAX_BYTES = 10 * 1024 * 1024;

type ToolResultShapeContext = Pick<ToolInvokeOptions, "sessionId" | "toolCallId">;

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

function detailsRecord(details: ToolResultDetails | undefined, key: string): Record<string, unknown> | null {
	const candidate = details?.[key];
	return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
		? (candidate as Record<string, unknown>)
		: null;
}

/**
 * A result that already spilled its full text to scratch (bash's tail-biased
 * shaping via `resultSize.offloadPath`, or an OBSERVE tool's envelope via
 * `observation.offloadPath`) is left alone; the tool shaped it deliberately
 * and the backstop would only cut the tool's own continuation notice.
 */
function existingOffloadPath(details: ToolResultDetails | undefined): string | null {
	const fromResultSize = detailsRecord(details, "resultSize")?.offloadPath;
	if (typeof fromResultSize === "string" && fromResultSize.length > 0) return fromResultSize;
	const fromObservation = detailsRecord(details, "observation")?.offloadPath;
	return typeof fromObservation === "string" && fromObservation.length > 0 ? fromObservation : null;
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

function offloadBody(text: string, bytes: number, maxBytes: number): string {
	if (bytes <= maxBytes) return text;
	const notice = `\n[clio scratch output truncated at ${maxBytes} bytes; original size ${bytes} bytes]`;
	const prefixBudget = maxBytes - byteLength(notice);
	return `${truncateUtf8(text, Math.max(0, prefixBudget), "")}${notice}`;
}

/**
 * Persist the full text of a tool result to a per-session scratch file and
 * return its path (or null if the write fails). Callers that truncate their own
 * display output (for example bash's tail-biased shaping) use this to spill the
 * complete output before truncating, then set `details.resultSize.offloadPath`
 * so the registry re-truncation pass leaves the already-shaped result alone.
 */
export function writeToolOffload(
	text: string,
	context: ToolResultShapeContext | undefined,
	maxBytes: number = RESULT_OFFLOAD_MAX_BYTES,
): string | null {
	try {
		const bytes = byteLength(text);
		const sessionId = safePathSegment(context?.sessionId ?? "no-session");
		const callId = safePathSegment(context?.toolCallId ?? timestampSegment());
		const dir = join(clioStateDir(), "scratch", sessionId);
		const path = join(dir, `${callId}.txt`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, offloadBody(text, bytes, maxBytes), "utf8");
		return path;
	} catch {
		return null;
	}
}

/**
 * The one framing for an offload pointer, shared by every truncation notice.
 * The path is a read-only overflow copy under Clio's state directory, and a
 * bare absolute path there reads to a model like somewhere it is working: an
 * observed run took the pointer as its working directory, wrote its notes
 * beside it, and never touched the repository again. Naming what the path is
 * costs a few tokens on truncated results and removes that reading.
 */
export const OFFLOAD_POINTER_NOTE = "overflow copy, read-only; not the workspace";

/** `full: <path> (<note>)`, the exact form every truncation notice carries. */
export function offloadPointer(offloadPath: string): string {
	return `full: ${offloadPath} (${OFFLOAD_POINTER_NOTE})`;
}

/**
 * True when filePath points inside this session's offload scratch directory
 * (where {@link writeToolOffload} spills full results). Reads of the session's
 * own offloaded output are exempt from the per-turn observation pool: the
 * "full: <path>" escape hatch a truncation stub offers must stay readable
 * exactly when that pool is exhausted, which is when the stub appears.
 */
export function isSessionOffloadPath(filePath: string, sessionId: string | undefined): boolean {
	const dir = join(clioStateDir(), "scratch", safePathSegment(sessionId ?? "no-session"));
	const rel = relative(dir, resolve(filePath));
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function bracketedHint(spec: ToolSpec, offloadPath: string | null): string {
	const hint = followUpHint(spec);
	if (offloadPath === null) return hint;
	return `${hint} ${offloadPointer(offloadPath)}; read it with offset and limit to inspect the rest.`;
}

/**
 * Backstop for an oversize result that declared itself JSON via
 * `details.observation.format`. Cutting mid-document would hand the model
 * unparseable JSON, so the whole payload is offloaded and replaced with a
 * parseable stub carrying the path and the exact continuation call.
 */
function shapeJsonOverflow(
	spec: ToolSpec,
	result: ToolResult,
	text: string,
	bytes: number,
	maxBytes: number,
	context: ToolResultShapeContext | undefined,
): ToolResult {
	const observation = detailsRecord(result.details, "observation");
	const offloadPath = writeToolOffload(text, context);
	const next =
		typeof observation?.next === "string" && observation.next.length > 0 ? observation.next : followUpHint(spec);
	const stub = JSON.stringify({
		error: `result exceeded ${maxBytes} bytes`,
		...(offloadPath !== null ? { offloadPath, offloadPathNote: OFFLOAD_POINTER_NOTE } : {}),
		next,
	});
	const resultSize = {
		bytes,
		shownBytes: byteLength(stub),
		maxBytes,
		truncated: true,
		policy: spec.metadata?.resultSizePolicy?.kind ?? "truncate",
		followUpHint: followUpHint(spec),
		...(offloadPath !== null ? { offloadPath } : {}),
	};
	if (result.kind === "ok") {
		return { ...result, output: stub, details: mergeDetails(result.details, resultSize) };
	}
	return { ...result, message: stub, details: mergeDetails(result.details, resultSize) };
}

export function shapeToolResult(spec: ToolSpec, result: ToolResult, context?: ToolResultShapeContext): ToolResult {
	if (existingOffloadPath(result.details) !== null) return result;
	const maxBytes = maxBytesFor(spec);
	const text = result.kind === "ok" ? result.output : result.message;
	const bytes = byteLength(text);
	if (bytes <= maxBytes) return result;
	const observation = detailsRecord(result.details, "observation");
	if (observation?.format === "json") return shapeJsonOverflow(spec, result, text, bytes, maxBytes, context);
	const truncated = truncateUtf8(text, maxBytes, RESULT_TRUNCATION_MARKER);
	const offloadPath = writeToolOffload(text, context);
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
