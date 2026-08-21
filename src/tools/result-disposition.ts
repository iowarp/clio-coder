import { createHash } from "node:crypto";
import { createRedactionTally, redactSecretsText } from "../domains/evidence/redact.js";
import type { ToolPresentationPolicy } from "./presentation.js";
import type { ToolResult, ToolResultDetails, ToolSpec } from "./registry.js";
import { byteLength } from "./truncate-utf8.js";

export type ToolResultExcerptBias = "head-tail" | "tail";

/** How much of a captured tool result is inserted into the model conversation. */
export type ToolResultContextDisposition =
	| { mode: "full"; maxBytes?: number; downgradeExcerpt?: ToolResultExcerptBias }
	| { mode: "bounded"; maxBytes: number; excerpt?: ToolResultExcerptBias }
	| { mode: "summary"; maxBytes: number; strategy?: "head-tail" | "diagnostic"; redact?: boolean }
	| { mode: "metadata-only"; maxBytes: number };

/** Operator-facing policy for one result, independent of its model projection. */
export interface ToolResultPresentationDisposition extends ToolPresentationPolicy {
	/** Registry display backstop. Overflow is retained in scratch when possible. */
	maxBytes?: number;
	/** Which edge of textual overflow the canonical shaper preserves. */
	overflow?: "head" | "tail";
}

/**
 * The canonical tool-result disposition vocabulary. Presentation controls the
 * operator surface; context independently controls what the model receives.
 */
export interface ToolResultDisposition {
	presentation: ToolResultPresentationDisposition;
	context: ToolResultContextDisposition;
}

export type AppliedToolResultContextMode = ToolResultContextDisposition["mode"];

export interface ToolResultSummaryProvenance {
	producer: "code";
	algorithm: "sha256-head-tail-v1" | "sha256-diagnostic-v1";
	sourceSha256: string;
	sourceLines: number;
	redactions?: number;
}

export interface ToolResultDispositionMetadata {
	version: 1;
	applications: 1;
	presentation: ToolResultPresentationDisposition & { content: string };
	context: {
		requestedMode: AppliedToolResultContextMode;
		appliedMode: AppliedToolResultContextMode;
		maxBytes: number;
		excerpt?: ToolResultExcerptBias;
		summaryStrategy?: "head-tail" | "diagnostic";
	};
	capturedBytes: number;
	displayedBytes: number;
	contextBytes: number;
	presentationTruncated: boolean;
	contextTruncated: boolean;
	downgrade?: {
		from: "full";
		to: "bounded";
		reason: "hard-budget";
	};
	offloadPath?: string;
	retrieval: string;
	summaryProvenance?: ToolResultSummaryProvenance;
}

export interface NormalizedToolResultDisposition {
	presentation: ToolResultPresentationDisposition & { maxBytes: number };
	context: ToolResultContextDisposition & { maxBytes: number };
}

export interface ToolResultContextProjection {
	text: string;
	appliedMode: AppliedToolResultContextMode;
	truncated: boolean;
	downgrade?: ToolResultDispositionMetadata["downgrade"];
	summaryProvenance?: ToolResultSummaryProvenance;
}

export interface ProjectToolResultContextInput {
	text: string;
	kind: ToolResult["kind"];
	details: ToolResultDetails | undefined;
	disposition: NormalizedToolResultDisposition;
	capturedBytes: number;
	displayedBytes: number;
	offloadPath: string | null;
	followUpHint: string;
}

const ESSENTIAL_DETAIL_KEYS = new Set([
	"aborted",
	"continuation",
	"continuationHint",
	"decision",
	"error",
	"errors",
	"evidence",
	"exitCode",
	"exitStatus",
	"outputBytes",
	"outputCapped",
	"next",
	"outcome",
	"safety",
	"safetyDecision",
	"status",
	"signal",
	"terminate",
	"timedOut",
	"retainedBytes",
	"stderrBytes",
	"stdoutBytes",
]);

function positiveByteCap(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/** Normalize one declared disposition against the registry's non-negotiable hard cap. */
export function normalizeToolResultDisposition(
	spec: ToolSpec,
	hardMaxBytes: number,
	requested: ToolResultDisposition | undefined = spec.metadata?.resultDisposition,
): NormalizedToolResultDisposition | null {
	const declared = requested;
	if (declared === undefined) return null;
	const hardCap = positiveByteCap(hardMaxBytes, 1);
	const presentationCap = Math.min(positiveByteCap(declared.presentation.maxBytes, hardCap), hardCap);
	const contextCap = Math.min(positiveByteCap(declared.context.maxBytes, hardCap), hardCap);
	return {
		presentation: {
			foldDefault: declared.presentation.foldDefault,
			showDiffWhenFolded: declared.presentation.showDiffWhenFolded,
			failureExcerpt: declared.presentation.failureExcerpt,
			maxBytes: presentationCap,
			...(declared.presentation.overflow === undefined ? {} : { overflow: declared.presentation.overflow }),
		},
		context: { ...declared.context, maxBytes: contextCap },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stableValue(value: unknown, seen: Set<object>): unknown {
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) {
		const items = value.map((item) => stableValue(item, seen));
		seen.delete(value);
		return items;
	}
	const record = value as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) out[key] = stableValue(record[key], seen);
	seen.delete(value);
	return out;
}

function stableJson(value: unknown): string {
	try {
		return JSON.stringify(stableValue(value, new Set())) ?? "null";
	} catch {
		return JSON.stringify(String(value));
	}
}

function essentialFacts(details: ToolResultDetails | undefined): Record<string, unknown> | null {
	if (details === undefined) return null;
	const facts: Record<string, unknown> = {};
	for (const key of Object.keys(details).sort()) {
		if (ESSENTIAL_DETAIL_KEYS.has(key)) facts[key] = details[key];
	}
	const observation = isRecord(details.observation) ? details.observation : null;
	if (observation !== null && observation.next !== undefined) facts.next = observation.next;
	return Object.keys(facts).length > 0 ? facts : null;
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	let end = Math.min(maxBytes, buffer.byteLength);
	while (end > 0 && end < buffer.byteLength && (buffer[end] ?? 0) >>> 6 === 2) end -= 1;
	return buffer.subarray(0, end).toString("utf8");
}

function utf8Suffix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	let start = Math.max(0, buffer.byteLength - maxBytes);
	while (start < buffer.byteLength && (buffer[start] ?? 0) >>> 6 === 2) start += 1;
	return buffer.subarray(start).toString("utf8");
}

function capUtf8(text: string, maxBytes: number): string {
	return byteLength(text) <= maxBytes ? text : utf8Prefix(text, maxBytes);
}

/** A deterministic, UTF-8-safe excerpt whose total bytes never exceed maxBytes. */
function boundedToolResultExcerpt(text: string, maxBytes: number, bias: ToolResultExcerptBias = "head-tail"): string {
	if (maxBytes <= 0) return "";
	if (byteLength(text) <= maxBytes) return text;
	if (bias === "tail") return utf8Suffix(text, maxBytes);
	const marker = "\n[… omitted …]\n";
	const markerBytes = byteLength(marker);
	if (markerBytes >= maxBytes) return utf8Prefix(text, maxBytes);
	const bodyBudget = maxBytes - markerBytes;
	const headBudget = Math.floor(bodyBudget / 2);
	const tailBudget = bodyBudget - headBudget;
	return `${utf8Prefix(text, headBudget)}${marker}${utf8Suffix(text, tailBudget)}`;
}

function sourceLineCount(text: string): number {
	if (text.length === 0) return 0;
	return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n").length;
}

function summaryProvenance(
	text: string,
	algorithm: ToolResultSummaryProvenance["algorithm"] = "sha256-head-tail-v1",
	redactions = 0,
): ToolResultSummaryProvenance {
	return {
		producer: "code",
		algorithm,
		sourceSha256: createHash("sha256").update(text).digest("hex"),
		sourceLines: sourceLineCount(text),
		...(redactions > 0 ? { redactions } : {}),
	};
}

const ERROR_LIKE_LINE =
	/(?:\b(?:abort(?:ed)?|assert(?:ion)?|error|exception|fail(?:ed|ure)?|fatal|killed|panic|signal|timed?\s*out|timeout)\b|\bnot ok\b|\bERR!\b)/iu;
const SUMMARY_LINE_MAX_BYTES = 768;

function summaryLine(line: string): string {
	return boundedToolResultExcerpt(line, SUMMARY_LINE_MAX_BYTES);
}

function renderSummarySection(label: string, lines: ReadonlyArray<string>): string {
	return lines.length === 0 ? "" : `[${label}]\n${lines.map(summaryLine).join("\n")}`;
}

/**
 * Stable Bash-style diagnostic summary. It keeps a bounded head and tail plus
 * error-like lines from the middle, and applies the repository secret redactor
 * before any selected content enters model context.
 */
export function deterministicDiagnosticSummary(
	text: string,
	maxBytes: number,
	redact = true,
): { text: string; redactions: number } {
	if (maxBytes <= 0 || text.length === 0) return { text: "", redactions: 0 };
	const tally = createRedactionTally();
	const safeText = redact ? redactSecretsText(text, tally) : text;
	const lines = safeText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
	const nonempty = lines.map((line, index) => ({ line: line.trim(), index })).filter((entry) => entry.line.length > 0);
	if (nonempty.length === 0) return { text: "", redactions: tally.count };
	if (nonempty.length === 1) {
		return {
			text: boundedToolResultExcerpt(nonempty[0]?.line ?? "", maxBytes),
			redactions: tally.count,
		};
	}

	const head = nonempty.slice(0, 4);
	const tail = nonempty.slice(-6);
	const edgeIndexes = new Set([...head, ...tail].map((entry) => entry.index));
	const diagnostics = nonempty.filter((entry) => !edgeIndexes.has(entry.index) && ERROR_LIKE_LINE.test(entry.line));
	const sections = [
		renderSummarySection(
			"diagnostic head",
			head.map((entry) => entry.line),
		),
		renderSummarySection(
			"error-like lines",
			diagnostics.map((entry) => entry.line),
		),
		renderSummarySection(
			"diagnostic tail",
			tail.map((entry) => entry.line),
		),
	].filter((section) => section.length > 0);
	const complete = sections.join("\n");
	if (byteLength(complete) <= maxBytes) return { text: complete, redactions: tally.count };

	// Preserve all three signal classes under pressure. The middle allocation is
	// deliberately largest because those error-like lines are the summary's
	// value over an ordinary head/tail excerpt.
	const weights = diagnostics.length > 0 ? [0.25, 0.45, 0.3] : [0.4, 0, 0.6];
	const boundedSections: string[] = [];
	for (const [index, section] of sections.entries()) {
		const weight = diagnostics.length > 0 ? (weights[index] ?? 0) : index === 0 ? 0.4 : 0.6;
		const budget = Math.floor(maxBytes * weight);
		if (budget > 0) boundedSections.push(boundedToolResultExcerpt(section ?? "", budget));
	}
	return { text: capUtf8(boundedSections.join("\n"), maxBytes), redactions: tally.count };
}

function retrievalLine(offloadPath: string | null, followUpHint: string): string {
	return offloadPath === null
		? `retrieve=${JSON.stringify(followUpHint)}`
		: `retrieve=${JSON.stringify(`read ${offloadPath} with offset and limit`)}`;
}

function contextHeader(
	input: ProjectToolResultContextInput,
	appliedMode: AppliedToolResultContextMode,
	truncated: boolean,
	provenance?: ToolResultSummaryProvenance,
): string {
	const lines = [
		`[tool-result ${appliedMode}]`,
		`kind=${input.kind} capturedBytes=${input.capturedBytes} displayedBytes=${input.displayedBytes} truncated=${String(truncated)}`,
		retrievalLine(input.offloadPath, input.followUpHint),
		`followUp=${JSON.stringify(input.followUpHint)}`,
	];
	if (provenance !== undefined) {
		lines.push(`summary=code/${provenance.algorithm} sha256=${provenance.sourceSha256} lines=${provenance.sourceLines}`);
	}
	const facts = essentialFacts(input.details);
	if (facts !== null) lines.push(`facts=${stableJson(facts)}`);
	return lines.join("\n");
}

function joinHeaderAndBody(
	header: string,
	body: string,
	maxBytes: number,
	bias: ToolResultExcerptBias = "head-tail",
): string {
	if (body.length === 0) return capUtf8(header, maxBytes);
	const separator = "\n";
	const headerBytes = byteLength(header);
	const separatorBytes = byteLength(separator);
	if (headerBytes + separatorBytes >= maxBytes) return capUtf8(header, maxBytes);
	const bodyBudget = maxBytes - headerBytes - separatorBytes;
	return `${header}${separator}${boundedToolResultExcerpt(body, bodyBudget, bias)}`;
}

function fullTrailer(input: ProjectToolResultContextInput): string {
	const facts = essentialFacts(input.details);
	const lines: string[] = [];
	if (facts !== null) lines.push(`facts=${stableJson(facts)}`);
	if (input.followUpHint.length > 0) lines.push(`followUp=${JSON.stringify(input.followUpHint)}`);
	return lines.length === 0 ? "" : `[tool-result metadata]\n${lines.join("\n")}`;
}

/** Whether the final projection will omit captured content and therefore benefits from an offload artifact. */
export function toolResultContextOmitsContent(input: ProjectToolResultContextInput): boolean {
	const mode = input.disposition.context.mode;
	if (input.capturedBytes === 0) return false;
	if (mode === "metadata-only" || mode === "summary") return true;
	if (mode === "full") {
		const trailer = fullTrailer(input);
		const candidate = trailer.length === 0 ? input.text : `${input.text}\n\n${trailer}`;
		return input.capturedBytes > byteLength(input.text) || byteLength(candidate) > input.disposition.context.maxBytes;
	}
	const header = contextHeader(input, "bounded", false);
	return (
		input.capturedBytes > byteLength(input.text) ||
		byteLength(header) + 1 + byteLength(input.text) > input.disposition.context.maxBytes
	);
}

/** Build the deterministic model projection for a normalized disposition. */
export function projectToolResultContext(input: ProjectToolResultContextInput): ToolResultContextProjection {
	const requestedMode = input.disposition.context.mode;
	const maxBytes = input.disposition.context.maxBytes;
	if (requestedMode === "full") {
		const trailer = fullTrailer(input);
		const candidate = trailer.length === 0 ? input.text : `${input.text}\n\n${trailer}`;
		const capturedTextIsComplete = input.capturedBytes <= byteLength(input.text);
		if (capturedTextIsComplete && byteLength(candidate) <= maxBytes) {
			return { text: candidate, appliedMode: "full", truncated: false };
		}
		const header = contextHeader(input, "bounded", true);
		return {
			text: joinHeaderAndBody(header, input.text, maxBytes, input.disposition.context.downgradeExcerpt),
			appliedMode: "bounded",
			truncated: true,
			downgrade: { from: "full", to: "bounded", reason: "hard-budget" },
		};
	}
	if (requestedMode === "metadata-only") {
		return {
			text: capUtf8(contextHeader(input, "metadata-only", input.capturedBytes > 0), maxBytes),
			appliedMode: "metadata-only",
			truncated: input.capturedBytes > 0,
		};
	}
	if (requestedMode === "summary") {
		const diagnostic = input.disposition.context.strategy === "diagnostic";
		const initialProvenance = summaryProvenance(input.text, diagnostic ? "sha256-diagnostic-v1" : "sha256-head-tail-v1");
		const initialHeader = contextHeader(input, "summary", input.capturedBytes > 0, initialProvenance);
		const bodyBudget = Math.max(0, maxBytes - byteLength(initialHeader) - 1);
		const selected = diagnostic
			? deterministicDiagnosticSummary(input.text, bodyBudget, input.disposition.context.redact !== false)
			: {
					text: input.text
						.replace(/\r\n/gu, "\n")
						.replace(/\r/gu, "\n")
						.split("\n")
						.map((line) => line.trim())
						.filter((line) => line.length > 0)
						.join("\n"),
					redactions: 0,
				};
		const provenance = summaryProvenance(
			input.text,
			diagnostic ? "sha256-diagnostic-v1" : "sha256-head-tail-v1",
			selected.redactions,
		);
		const header = contextHeader(input, "summary", input.capturedBytes > 0, provenance);
		return {
			text: joinHeaderAndBody(header, selected.text, maxBytes),
			appliedMode: "summary",
			truncated: input.capturedBytes > 0,
			summaryProvenance: provenance,
		};
	}
	const header = contextHeader(input, "bounded", input.capturedBytes > maxBytes);
	const text = joinHeaderAndBody(header, input.text, maxBytes, input.disposition.context.excerpt);
	return {
		text,
		appliedMode: "bounded",
		truncated: byteLength(header) + 1 + byteLength(input.text) > maxBytes || input.capturedBytes > byteLength(input.text),
	};
}

/** The text inserted into the provider conversation for a registry result. */
export function toolResultContextText(result: ToolResult): string {
	if (result.modelContext !== undefined) return result.modelContext;
	return result.kind === "ok" ? result.output : result.message;
}

/** Whether a registry or agent-tool result is an applied canonical failure envelope. */
export function isDispositionedToolResultError(result: unknown): boolean {
	if (!isRecord(result)) return false;
	const details = isRecord(result.details) ? result.details : null;
	const metadata = details !== null && isRecord(details.resultDisposition) ? details.resultDisposition : null;
	const kind = result.kind ?? details?.kind;
	return kind === "error" && metadata?.version === 1 && metadata.applications === 1;
}

/** Operator text retained beside an independently projected AgentToolResult. */
export function toolResultPresentationText(result: unknown): string | null {
	if (!isRecord(result)) return null;
	const details = isRecord(result.details) ? result.details : null;
	const metadata = details !== null && isRecord(details.resultDisposition) ? details.resultDisposition : null;
	const presentation = metadata !== null && isRecord(metadata.presentation) ? metadata.presentation : null;
	return presentation !== null && typeof presentation.content === "string" ? presentation.content : null;
}

/** Applied fold/excerpt policy retained with a projected result for operator surfaces. */
export function toolResultPresentationPolicy(result: unknown): ToolPresentationPolicy | null {
	if (!isRecord(result)) return null;
	const details = isRecord(result.details) ? result.details : null;
	const metadata = details !== null && isRecord(details.resultDisposition) ? details.resultDisposition : null;
	const presentation = metadata !== null && isRecord(metadata.presentation) ? metadata.presentation : null;
	if (
		presentation === null ||
		(presentation.foldDefault !== "folded" && presentation.foldDefault !== "expanded") ||
		typeof presentation.showDiffWhenFolded !== "boolean" ||
		typeof presentation.failureExcerpt !== "boolean"
	) {
		return null;
	}
	return {
		foldDefault: presentation.foldDefault,
		showDiffWhenFolded: presentation.showDiffWhenFolded,
		failureExcerpt: presentation.failureExcerpt,
	};
}
