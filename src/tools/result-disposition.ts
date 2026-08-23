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
 * Why a disposition is not the one the tool asked for. Today the only cause is
 * a throwing `resolveResultDisposition`: the registry then fails closed to
 * metadata-only, and this record is what keeps that narrowing visible to the
 * operator and the model instead of reading as a deliberate request.
 */
export interface ToolResultDispositionFallback {
	reason: "resolver-error";
	message: string;
}

/**
 * The canonical tool-result disposition vocabulary. Presentation controls the
 * operator surface; context independently controls what the model receives.
 */
export interface ToolResultDisposition {
	presentation: ToolResultPresentationDisposition;
	context: ToolResultContextDisposition;
	fallback?: ToolResultDispositionFallback;
}

export type AppliedToolResultContextMode = ToolResultContextDisposition["mode"];

export interface ToolResultSummaryProvenance {
	producer: "code";
	algorithm: "sha256-head-tail-v1" | "sha256-diagnostic-v1";
	sourceSha256: string;
	sourceLines: number;
	redactions?: number;
}

export const TOOL_RESULT_DIGEST_MAX_BYTES = 240;

export interface ToolResultDigestProvenance {
	producer: "code";
	source: "canonical-result-disposition" | "legacy-fallback";
	algorithm: "redacted-context-digest-v1" | "redacted-legacy-digest-v1";
	contextMode?: AppliedToolResultContextMode;
	summaryAlgorithm?: ToolResultSummaryProvenance["algorithm"];
	redactions?: number;
}

/** A bounded diagnostic that is safe to pass to task memory. */
export interface ToolResultDigest {
	text: string;
	provenance: ToolResultDigestProvenance;
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
	fallback?: ToolResultDispositionFallback;
}

export interface NormalizedToolResultDisposition {
	presentation: ToolResultPresentationDisposition & { maxBytes: number };
	context: ToolResultContextDisposition & { maxBytes: number };
	fallback?: ToolResultDispositionFallback;
}

export interface ToolResultContextProjection {
	text: string;
	appliedMode: AppliedToolResultContextMode;
	/**
	 * True when the projection omits captured content, which is exactly when a
	 * retrieval artifact earns its place. Whitespace-only differences (trimmed
	 * line ends, dropped blank lines) do not count as omitted content.
	 */
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
		...(declared.fallback === undefined ? {} : { fallback: declared.fallback }),
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

function capDigestUtf8(text: string, maxBytes: number): string {
	if (byteLength(text) <= maxBytes) return text;
	const marker = "…";
	const markerBytes = byteLength(marker);
	if (markerBytes >= maxBytes) return utf8Prefix(text, maxBytes);
	return `${utf8Prefix(text, maxBytes - markerBytes).trimEnd()}${marker}`;
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

/**
 * A selected summary body plus the two facts the caller needs to stay honest:
 * how many secrets the redactor replaced, and whether every nonempty captured
 * line survived verbatim. `complete` is the input to the retrieval decision;
 * it is false whenever any line was dropped, cut, or redacted.
 */
export interface ToolResultSummarySelection {
	text: string;
	redactions: number;
	complete: boolean;
}

function summaryLine(line: string): string {
	return boundedToolResultExcerpt(line, SUMMARY_LINE_MAX_BYTES);
}

function normalizeNewlines(text: string): string {
	return text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
}

/** The trimmed nonempty lines that carry a text's content, in source order. */
function contentLines(text: string): string[] {
	return normalizeNewlines(text)
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * The non-diagnostic summary strategy: every nonempty line, trimmed, in order.
 * Redaction is applied here too, so `redact` is honored whichever strategy the
 * caller declared.
 */
function deterministicHeadTailSummary(text: string, redact = true): ToolResultSummarySelection {
	const tally = createRedactionTally();
	const safeText = redact ? redactSecretsText(text, tally) : text;
	return { text: contentLines(safeText).join("\n"), redactions: tally.count, complete: tally.count === 0 };
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
): ToolResultSummarySelection {
	if (maxBytes <= 0 || text.length === 0) return { text: "", redactions: 0, complete: text.length === 0 };
	const tally = createRedactionTally();
	const safeText = redact ? redactSecretsText(text, tally) : text;
	const lines = normalizeNewlines(safeText).split("\n");
	const nonempty = lines.map((line, index) => ({ line: line.trim(), index })).filter((entry) => entry.line.length > 0);
	// Whitespace-only output carries no content to omit, so dropping it is
	// exactly the whitespace-only difference the completeness contract ignores.
	if (nonempty.length === 0) return { text: "", redactions: tally.count, complete: tally.count === 0 };
	if (nonempty.length === 1) {
		const only = nonempty[0]?.line ?? "";
		return {
			text: boundedToolResultExcerpt(only, maxBytes),
			redactions: tally.count,
			complete: tally.count === 0 && byteLength(only) <= maxBytes,
		};
	}

	// Head and tail are disjoint by construction. Overlapping slices used to
	// emit every line of a short output twice, so a two-line result summarized
	// larger than the output it summarized.
	const head = nonempty.slice(0, 4);
	const tail = nonempty.slice(Math.max(head.length, nonempty.length - 6));
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
	const selected = [...head, ...diagnostics, ...tail];
	const keepsEveryLine =
		selected.length === nonempty.length && selected.every((entry) => byteLength(entry.line) <= SUMMARY_LINE_MAX_BYTES);
	// Section labels earn their bytes by telling the model which lines were
	// elided. When nothing was elided they are pure overhead, and on a short
	// output they made the summary larger than the output itself.
	const rendered = keepsEveryLine ? selected.map((entry) => summaryLine(entry.line)).join("\n") : sections.join("\n");
	if (byteLength(rendered) <= maxBytes) {
		return { text: rendered, redactions: tally.count, complete: keepsEveryLine && tally.count === 0 };
	}

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
	return { text: capUtf8(boundedSections.join("\n"), maxBytes), redactions: tally.count, complete: false };
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
	if (input.disposition.fallback !== undefined) {
		lines.push(`fallback=${input.disposition.fallback.reason} ${JSON.stringify(input.disposition.fallback.message)}`);
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

const NUL = "\u0000";

/**
 * A raw NUL cannot survive the provider conversation as content: it is not
 * printable, it terminates strings in most consumers downstream of the model,
 * and it carries no diagnostic value. It is removed from the model projection
 * only. Removal is byte-exact and touches no other byte, so multi-byte code
 * points stay whole and ANSI escape sequences are never cut mid-sequence.
 * Presentation text and the retrieval artifact keep the captured bytes.
 */
function stripNulForContext(text: string): { text: string; stripped: number } {
	const parts = text.split(NUL);
	return parts.length === 1 ? { text, stripped: 0 } : { text: parts.join(""), stripped: parts.length - 1 };
}

/** Build the deterministic model projection for a normalized disposition. */
export function projectToolResultContext(input: ProjectToolResultContextInput): ToolResultContextProjection {
	const requestedMode = input.disposition.context.mode;
	const maxBytes = input.disposition.context.maxBytes;
	const sanitized = stripNulForContext(input.text);
	const body = sanitized.text;
	// The captured text can already be a partial capture, and NUL removal drops
	// bytes the operator surface still holds. Either way content is omitted.
	const capturedTextIsComplete = input.capturedBytes <= byteLength(input.text) && sanitized.stripped === 0;
	if (requestedMode === "full") {
		const trailer = fullTrailer(input);
		const candidate = trailer.length === 0 ? body : `${body}\n\n${trailer}`;
		if (capturedTextIsComplete && byteLength(candidate) <= maxBytes) {
			return { text: candidate, appliedMode: "full", truncated: false };
		}
		const header = contextHeader(input, "bounded", true);
		return {
			text: joinHeaderAndBody(header, body, maxBytes, input.disposition.context.downgradeExcerpt),
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
		const algorithm = diagnostic ? "sha256-diagnostic-v1" : "sha256-head-tail-v1";
		const redact = input.disposition.context.redact !== false;
		const budgetHeader = contextHeader(input, "summary", true, summaryProvenance(input.text, algorithm));
		const bodyBudget = Math.max(0, maxBytes - byteLength(budgetHeader) - 1);
		const selected = diagnostic
			? deterministicDiagnosticSummary(body, bodyBudget, redact)
			: deterministicHeadTailSummary(body, redact);
		const provenance = summaryProvenance(input.text, algorithm, selected.redactions);
		// "Nothing omitted" is only true if the whole selection also survives the
		// header it would then render, so the claim can never itself be truncated.
		const completeHeader = contextHeader(input, "summary", false, provenance);
		const fits = byteLength(completeHeader) + 1 + byteLength(selected.text) <= maxBytes;
		const truncated = input.capturedBytes > 0 && !(capturedTextIsComplete && selected.complete && fits);
		const header = contextHeader(input, "summary", truncated, provenance);
		return {
			text: joinHeaderAndBody(header, selected.text, maxBytes),
			appliedMode: "summary",
			truncated,
			summaryProvenance: provenance,
		};
	}
	const header = contextHeader(input, "bounded", input.capturedBytes > maxBytes);
	const text = joinHeaderAndBody(header, body, maxBytes, input.disposition.context.excerpt);
	return {
		text,
		appliedMode: "bounded",
		truncated: byteLength(header) + 1 + byteLength(body) > maxBytes || !capturedTextIsComplete,
	};
}

const DIGEST_FACT_KEYS = [
	"outcome",
	"exitCode",
	"timedOut",
	"aborted",
	"outputCapped",
	"signal",
	"status",
	"error",
	"decision",
	"next",
] as const;

function digestFactText(details: ToolResultDetails | undefined): string {
	if (details === undefined) return "";
	const facts: string[] = [];
	for (const key of DIGEST_FACT_KEYS) {
		if (details[key] !== undefined) facts.push(`${key}=${stableJson(details[key])}`);
	}
	return facts.join(" ");
}

function projectionBody(input: ProjectToolResultContextInput, projection: ToolResultContextProjection): string {
	if (projection.appliedMode === "metadata-only") return "";
	if (projection.appliedMode === "full") {
		const trailer = fullTrailer(input);
		return trailer.length > 0 && projection.text.endsWith(`\n\n${trailer}`)
			? projection.text.slice(0, -(trailer.length + 2))
			: projection.text;
	}
	const header = contextHeader(input, projection.appliedMode, projection.truncated, projection.summaryProvenance);
	const prefix = `${header}\n`;
	return projection.text.startsWith(prefix) ? projection.text.slice(prefix.length) : "";
}

function digestText(
	status: string,
	facts: string,
	body: string,
	redactions: number,
	maxBytes: number,
): { text: string; redactions: number } {
	const tally = createRedactionTally();
	const safeStatus = redactSecretsText(status, tally);
	const safeFacts = redactSecretsText(facts, tally);
	const statusAndFacts = [safeStatus, safeFacts].filter((value) => value.length > 0).join(" ");
	const bodyBudget = Math.max(0, maxBytes - byteLength(statusAndFacts) - 2);
	const selected = deterministicDiagnosticSummary(body, bodyBudget, true);
	const candidate = [statusAndFacts, selected.text.replace(/\s+/gu, " ").trim()]
		.filter((value) => value.length > 0)
		.join("; ");
	return {
		text: capDigestUtf8(candidate, maxBytes),
		redactions: redactions + tally.count + selected.redactions,
	};
}

/**
 * Reuse the applied model-context projection as task memory's diagnostic
 * source. Metadata-only never contributes captured content, and bounded or
 * summarized modes contribute only the body admitted by that projection.
 */
export function deterministicToolResultDigest(
	input: ProjectToolResultContextInput,
	maxBytes = TOOL_RESULT_DIGEST_MAX_BYTES,
): ToolResultDigest {
	const projection = projectToolResultContext(input);
	const status = [
		`kind=${input.kind}`,
		`mode=${projection.appliedMode}`,
		`truncated=${String(projection.truncated)}`,
		...(projection.appliedMode === "metadata-only" || projection.truncated
			? [`capturedBytes=${input.capturedBytes}`]
			: []),
	].join(" ");
	const digest = digestText(
		status,
		digestFactText(input.details),
		projectionBody(input, projection),
		projection.summaryProvenance?.redactions ?? 0,
		Math.max(1, Math.floor(maxBytes)),
	);
	return {
		text: digest.text,
		provenance: {
			producer: "code",
			source: "canonical-result-disposition",
			algorithm: "redacted-context-digest-v1",
			contextMode: projection.appliedMode,
			...(projection.summaryProvenance === undefined ? {} : { summaryAlgorithm: projection.summaryProvenance.algorithm }),
			...(digest.redactions > 0 ? { redactions: digest.redactions } : {}),
		},
	};
}

/** Deterministic compatibility path for results without a canonical disposition. */
export function legacyToolResultDigest(
	text: string,
	options: { outcome: "ok" | "error"; maxBytes?: number },
): ToolResultDigest {
	const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? TOOL_RESULT_DIGEST_MAX_BYTES));
	const fallback = options.outcome === "error" && text.trim().length === 0 ? "an unknown tool error" : text;
	const digest = digestText("", "", fallback, 0, maxBytes);
	return {
		text: digest.text,
		provenance: {
			producer: "code",
			source: "legacy-fallback",
			algorithm: "redacted-legacy-digest-v1",
			...(digest.redactions > 0 ? { redactions: digest.redactions } : {}),
		},
	};
}

/** Reapply the memory boundary's redaction and byte cap to a supplied digest. */
export function sanitizeToolResultDigest(
	digest: ToolResultDigest,
	maxBytes = TOOL_RESULT_DIGEST_MAX_BYTES,
): ToolResultDigest {
	const tally = createRedactionTally();
	const safe = redactSecretsText(digest.text, tally).replace(/\s+/gu, " ").trim();
	const redactions = (digest.provenance.redactions ?? 0) + tally.count;
	return {
		text: capDigestUtf8(safe, Math.max(1, Math.floor(maxBytes))),
		provenance: {
			...digest.provenance,
			...(redactions > 0 ? { redactions } : {}),
		},
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
