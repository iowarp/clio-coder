import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { clioStateDir } from "../core/xdg.js";
import type { ToolInvokeOptions, ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import {
	normalizeToolResultDisposition,
	projectToolResultContext,
	type ToolResultDisposition,
	type ToolResultDispositionFallback,
	type ToolResultDispositionMetadata,
} from "./result-disposition.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail } from "./truncate.js";
import { byteLength, truncateUtf8 } from "./truncate-utf8.js";

// Backstop for tools without an explicit resultSizePolicy. Sits above the
// per-observation source cap (src/tools/truncate.ts) so a tool's own truncation
// notice (with its precise continuation offset) survives shaping instead of
// being cut again and replaced by a generic hint.
export const DEFAULT_TOOL_RESULT_MAX_BYTES = DEFAULT_MAX_BYTES + 2 * 1024;
const RESULT_TRUNCATION_MARKER = "\n[tool result truncated]";
const RESULT_OFFLOAD_MAX_BYTES = 10 * 1024 * 1024;
const TAIL_NOTICE_RESERVE_BYTES = 512;

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

function offloadMaxBytesFor(spec: ToolSpec): number {
	const configured = spec.metadata?.resultSizePolicy?.offloadMaxBytes;
	return typeof configured === "number" && Number.isFinite(configured) && configured > 0
		? Math.floor(configured)
		: RESULT_OFFLOAD_MAX_BYTES;
}

function detailsRecord(details: ToolResultDetails | undefined, key: string): Record<string, unknown> | null {
	const candidate = details?.[key];
	return candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)
		? (candidate as Record<string, unknown>)
		: null;
}

/**
 * A result that already spilled its full text to scratch (the canonical
 * tail-biased presentation path via `resultSize.offloadPath`, or an OBSERVE
 * tool's envelope via `observation.offloadPath`) is left alone; a second pass
 * would only cut the deliberate continuation notice.
 */
function existingOffloadPath(details: ToolResultDetails | undefined): string | null {
	const fromResultSize = detailsRecord(details, "resultSize")?.offloadPath;
	if (typeof fromResultSize === "string" && fromResultSize.length > 0) return fromResultSize;
	const fromObservation = detailsRecord(details, "observation")?.offloadPath;
	return typeof fromObservation === "string" && fromObservation.length > 0 ? fromObservation : null;
}

function existingDisposition(details: ToolResultDetails | undefined): ToolResultDispositionMetadata | null {
	const disposition = detailsRecord(details, "resultDisposition");
	return disposition?.version === 1 && disposition.applications === 1
		? (disposition as unknown as ToolResultDispositionMetadata)
		: null;
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
	const notice = `\n[clio-coder scratch output truncated at ${maxBytes} bytes; original size ${bytes} bytes]`;
	const prefixBudget = maxBytes - byteLength(notice);
	return `${truncateUtf8(text, Math.max(0, prefixBudget), "")}${notice}`;
}

/**
 * Persist the full text of a tool result to a per-session scratch file and
 * return its path (or null if the write fails). Self-shaping callers use this
 * to spill complete output before truncating and set
 * `details.resultSize.offloadPath`; canonical disposition shaping also uses it
 * once when presentation or model context omits captured content.
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
	offloadMaxBytes: number,
): ToolResult {
	const observation = detailsRecord(result.details, "observation");
	const offloadPath = writeToolOffload(text, context, offloadMaxBytes);
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

function shapeTailOverflow(
	spec: ToolSpec,
	result: ToolResult,
	text: string,
	bytes: number,
	maxBytes: number,
	context: ToolResultShapeContext | undefined,
	offloadMaxBytes: number,
): ToolResult {
	const truncation = truncateTail(text, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: Math.max(1, maxBytes - TAIL_NOTICE_RESERVE_BYTES),
	});
	const offloadPath = writeToolOffload(text, context, offloadMaxBytes);
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const scope = truncation.lastLinePartial
		? `last ${formatSize(truncation.outputBytes)} of line ${truncation.totalLines} (line is large)`
		: `lines ${startLine}-${truncation.totalLines} of ${truncation.totalLines}`;
	const location =
		offloadPath === null
			? ""
			: ` Full output saved to ${offloadPath}; ${OFFLOAD_POINTER_NOTE}; read it with offset/limit.`;
	const note = `[Output tail-truncated: showing ${scope} (${formatSize(maxBytes)} display limit).${location}]`;
	const resultSize = {
		bytes,
		shownBytes: truncation.outputBytes,
		maxBytes,
		truncated: true,
		policy: "tail",
		followUpHint: followUpHint(spec),
		...(offloadPath === null ? {} : { offloadPath }),
	};
	const displayed = `${truncation.content}\n\n${note}`;
	if (result.kind === "ok") return { ...result, output: displayed, details: mergeDetails(result.details, resultSize) };
	return { ...result, message: displayed, details: mergeDetails(result.details, resultSize) };
}

function shapeLegacyToolResult(
	spec: ToolSpec,
	result: ToolResult,
	context?: ToolResultShapeContext,
	overflow: "head" | "tail" = "head",
): ToolResult {
	if (existingOffloadPath(result.details) !== null) return result;
	const maxBytes = maxBytesFor(spec);
	const offloadMaxBytes = offloadMaxBytesFor(spec);
	const text = result.kind === "ok" ? result.output : result.message;
	const bytes = byteLength(text);
	if (bytes <= maxBytes) return result;
	const observation = detailsRecord(result.details, "observation");
	if (observation?.format === "json") {
		return shapeJsonOverflow(spec, result, text, bytes, maxBytes, context, offloadMaxBytes);
	}
	if (overflow === "tail") {
		return shapeTailOverflow(spec, result, text, bytes, maxBytes, context, offloadMaxBytes);
	}
	const truncated = truncateUtf8(text, maxBytes, RESULT_TRUNCATION_MARKER);
	const offloadPath = writeToolOffload(text, context, offloadMaxBytes);
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

function specWithDisplayCap(spec: ToolSpec, maxBytes: number): ToolSpec {
	const metadata = spec.metadata;
	if (metadata === undefined) return spec;
	return {
		...spec,
		metadata: {
			...metadata,
			resultSizePolicy: { ...metadata.resultSizePolicy, maxBytes },
		},
	};
}

function resultText(result: ToolResult): string {
	return result.kind === "ok" ? result.output : result.message;
}

/**
 * The operator-facing trace of a disposition that was narrowed rather than
 * requested. Without it a throwing resolver degrades every call of that tool
 * to metadata-only with nothing on the transcript row to say so.
 */
function withFallbackNotice(result: ToolResult, fallback: ToolResultDispositionFallback): ToolResult {
	const note = `\n\n[result disposition fell back to metadata-only: ${fallback.reason} (${fallback.message}); the model received facts and retrieval only]`;
	return result.kind === "ok"
		? { ...result, output: `${result.output}${note}` }
		: { ...result, message: `${result.message}${note}` };
}

function numberField(record: Record<string, unknown> | null, key: string): number | null {
	const value = record?.[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function capturedBytesFor(result: ToolResult, text: string): number {
	const declared = numberField(detailsRecord(result.details, "resultSize"), "bytes");
	return Math.max(byteLength(text), declared ?? 0);
}

function resultWasTruncated(result: ToolResult): boolean {
	return detailsRecord(result.details, "resultSize")?.truncated === true;
}

function withOffloadMetadata(
	result: ToolResult,
	offloadPath: string,
	capturedBytes: number,
	displayedBytes: number,
	maxBytes: number,
	hint: string,
): ToolResult {
	const current = detailsRecord(result.details, "resultSize") ?? {};
	const resultSize = {
		bytes: numberField(current, "bytes") ?? capturedBytes,
		shownBytes: numberField(current, "shownBytes") ?? displayedBytes,
		maxBytes: numberField(current, "maxBytes") ?? maxBytes,
		truncated: current.truncated === true,
		policy: typeof current.policy === "string" ? current.policy : "disposition",
		followUpHint: typeof current.followUpHint === "string" ? current.followUpHint : hint,
		...current,
		offloadPath,
	};
	return { ...result, details: mergeDetails(result.details, resultSize) };
}

/**
 * Apply legacy shaping or one declared canonical disposition. Registry calls
 * this once, after middleware annotations have produced the terminal result.
 */
export function shapeToolResult(
	spec: ToolSpec,
	result: ToolResult,
	context?: ToolResultShapeContext,
	requestedDisposition?: ToolResultDisposition,
): ToolResult {
	if (existingDisposition(result.details) !== null) return result;
	const hardMaxBytes = maxBytesFor(spec);
	const disposition = normalizeToolResultDisposition(spec, hardMaxBytes, requestedDisposition);
	if (disposition === null) return shapeLegacyToolResult(spec, result, context);

	const capturedText = resultText(result);
	const capturedBytes = capturedBytesFor(result, capturedText);
	let displayed = shapeLegacyToolResult(
		specWithDisplayCap(spec, disposition.presentation.maxBytes),
		result,
		context,
		disposition.presentation.overflow,
	);
	if (disposition.fallback !== undefined) displayed = withFallbackNotice(displayed, disposition.fallback);
	let displayedText = resultText(displayed);
	let displayedBytes = byteLength(displayedText);
	let offloadPath = existingOffloadPath(displayed.details);
	const projectionInput = {
		text: capturedText,
		kind: result.kind,
		details: displayed.details,
		disposition,
		capturedBytes,
		displayedBytes,
		offloadPath,
		followUpHint: followUpHint(spec),
	};
	// Project first, then decide on retrieval. A projection that already carries
	// every captured byte (a short `summary`, a `full` inside budget) needs no
	// scratch artifact and must not claim truncation; anything that genuinely
	// omits content earns one offload and the honest omission facts with it.
	let projection = projectToolResultContext(projectionInput);
	if (offloadPath === null && projection.truncated) {
		offloadPath = writeToolOffload(capturedText, context, offloadMaxBytesFor(spec));
		if (offloadPath !== null) {
			displayed = withOffloadMetadata(
				displayed,
				offloadPath,
				capturedBytes,
				displayedBytes,
				disposition.presentation.maxBytes,
				followUpHint(spec),
			);
			displayedText = resultText(displayed);
			displayedBytes = byteLength(displayedText);
			projection = projectToolResultContext({
				...projectionInput,
				details: displayed.details,
				displayedBytes,
				offloadPath,
			});
		}
	}
	const metadata: ToolResultDispositionMetadata = {
		version: 1,
		applications: 1,
		presentation: { ...disposition.presentation, content: displayedText },
		context: {
			requestedMode: disposition.context.mode,
			appliedMode: projection.appliedMode,
			maxBytes: disposition.context.maxBytes,
			...(disposition.context.mode === "bounded" && disposition.context.excerpt !== undefined
				? { excerpt: disposition.context.excerpt }
				: {}),
			...(disposition.context.mode === "full" && disposition.context.downgradeExcerpt !== undefined
				? { excerpt: disposition.context.downgradeExcerpt }
				: {}),
			...(disposition.context.mode === "summary" && disposition.context.strategy !== undefined
				? { summaryStrategy: disposition.context.strategy }
				: {}),
		},
		capturedBytes,
		displayedBytes,
		contextBytes: byteLength(projection.text),
		presentationTruncated: resultWasTruncated(displayed),
		contextTruncated: projection.truncated,
		...(projection.downgrade === undefined ? {} : { downgrade: projection.downgrade }),
		...(offloadPath === null ? {} : { offloadPath }),
		retrieval:
			offloadPath === null ? followUpHint(spec) : `read ${offloadPath} with offset and limit to retrieve omitted content`,
		...(projection.summaryProvenance === undefined ? {} : { summaryProvenance: projection.summaryProvenance }),
		...(disposition.fallback === undefined ? {} : { fallback: disposition.fallback }),
	};
	return {
		...displayed,
		details: { ...(displayed.details ?? {}), resultDisposition: metadata },
		modelContext: projection.text,
	};
}
