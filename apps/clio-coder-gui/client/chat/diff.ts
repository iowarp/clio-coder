/**
 * Diff parsing and bounding for the chat transcript. Pure: no React, no DOM,
 * no network, so `node:test` can exercise every branch.
 *
 * The producer is `generateDiffString()` in src/tools/edit-diff.ts and it does
 * NOT emit a git-style unified diff. It emits a line-numbered review format:
 *
 *     +  12 const added = true;
 *     -  12 const removed = true;
 *        13 const context = true;
 *           ...
 *
 * A marker column (`+`, `-`, or a space), a right-aligned line number padded to
 * the width of the largest line number in the file, one space, then the text.
 * An elided run of unchanged lines is a row whose number column is blank and
 * whose text is exactly `...`. There are no `@@` hunk headers and no `---`/`+++`
 * file headers, so a parser written against unified-diff syntax reads every row
 * as context and reports zero additions.
 *
 * A genuine unified diff is still parsed, because MCP and dynamic tools are free
 * to put one in `details.diff` and the chat must not silently mangle it.
 *
 * Two independent producers can truncate the string, and the card has to tell
 * the truth about which one did:
 *   1. the engine, at MAX_DIFF_BYTES = 32768, appending CLIO_TRUNCATION_MARKER;
 *   2. the ACP wire, at ACP_MAX_RAW_DIFF_BYTES = 28672, appending
 *      ACP_TRUNCATION_MARKER (src/engine/acp/server.ts:401,567).
 * The wire cap is the tighter of the two, so in practice the wire marker is the
 * one an operator sees on a large edit.
 */

/** src/tools/edit-diff.ts:526, the engine's own 32 KiB backstop. */
export const CLIO_TRUNCATION_MARKER = "… diff truncated (details capped)";
/** src/engine/acp/server.ts:401, applied to `details.diff` at 28672 bytes. */
export const ACP_TRUNCATION_MARKER = "…[truncated]";
/** src/tools/edit-diff.ts:18, the per-line width cap the engine already applied. */
export const CLIO_LINE_CAP_MARKER = /… \(\+\d+ chars\)$/;
/** Emitted by edit.ts:206 and write.ts:63 when the file is over 1 MiB. */
export const DIFF_SKIPPED_NOTE = "diff skipped because the previous or new file exceeds 1 MiB";
/** write.ts:66 reports this on the result text, not in `details`. */
export const NO_TRAILING_NEWLINE_NOTE = "no longer ends with a newline";
/**
 * src/tools/registry.ts:1277 words a parked call that was answered as
 * `<tool> blocked: <actionClass> was not approved`. Matching the producer's own
 * sentence is what separates "not approved" from "the tool broke", which a bare
 * `failed` status cannot say. The same sentence covers a denial at the prompt, a
 * turn cancelled while the approval waited, and an abort, so it proves that the
 * call was not approved and nothing about who declined it.
 */
export const NOT_APPROVED_NOTE = "was not approved";

/** DOM bound. The wire is already capped; this stops a pathological row count. */
export const MAX_RENDERED_DIFF_ROWS = 2_000;
/** A synthesized "proposed" block is local, so it needs its own bound. */
export const MAX_PROPOSED_ROWS = 400;
/** Above this many rows the view opens collapsed around the first change. */
export const COLLAPSE_THRESHOLD_ROWS = 40;
/** Context rows kept either side of the first change when collapsed. */
export const COLLAPSE_CONTEXT_ROWS = 3;

export type DiffRowKind = "add" | "del" | "ctx" | "elision" | "hunk";

export interface DiffRow {
	/**
	 * Render identity. A diff row carries no identity on the wire and the array
	 * is rebuilt whole whenever the payload changes, so ordinal position IS the
	 * identity. Assigning it here rather than in the component keeps the choice
	 * visible and stops a renderer inventing a less stable one.
	 */
	readonly id: string;
	readonly kind: DiffRowKind;
	readonly text: string;
	readonly oldLine: number | null;
	readonly newLine: number | null;
	/** True when the engine cut this single line at 500 characters. */
	readonly lineCapped: boolean;
}

function withIds(rows: readonly DiffRow[]): DiffRow[] {
	return rows.map((entry, index) => ({ ...entry, id: `r${index}` }));
}

export type DiffFormat = "clio" | "unified" | "unparsed";

export interface ParsedDiff {
	readonly format: DiffFormat;
	readonly rows: readonly DiffRow[];
	readonly adds: number;
	readonly dels: number;
	/** Runs of unchanged lines the producer elided, as a row count of `...` markers. */
	readonly elisions: number;
	/** True when either producer cut the string short. Never claim completeness. */
	readonly truncated: boolean;
	/** Plain sentence naming which producer cut it, or null. */
	readonly truncationNote: string | null;
	/** True when the payload carried a "\ No newline at end of file" marker. */
	readonly noNewlineAtEof: boolean;
	/** True when rows were dropped by MAX_RENDERED_DIFF_ROWS rather than by a producer. */
	readonly rowsDropped: number;
}

const EMPTY: ParsedDiff = {
	format: "clio",
	rows: [],
	adds: 0,
	dels: 0,
	elisions: 0,
	truncated: false,
	truncationNote: null,
	noNewlineAtEof: false,
	rowsDropped: 0,
};

/** A payload is treated as binary when it carries a NUL or a lone control byte. */
function looksBinary(source: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control bytes is the point.
	return /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(source);
}

interface Truncation {
	readonly body: string;
	readonly truncated: boolean;
	readonly note: string | null;
}

function stripTruncation(source: string): Truncation {
	// The wire cap runs last, so its marker is the outermost one when both fired.
	if (source.endsWith(ACP_TRUNCATION_MARKER)) {
		const body = source.slice(0, -ACP_TRUNCATION_MARKER.length);
		return {
			body,
			truncated: true,
			note: "The wire capped this diff at 28 KiB. Lines below the cut were never sent, so this is not the whole change.",
		};
	}
	const clio = source.indexOf(CLIO_TRUNCATION_MARKER);
	if (clio >= 0) {
		return {
			body: source.slice(0, clio),
			truncated: true,
			note: "Clio Coder capped this diff at 32 KiB. Lines below the cut are not shown, so this is not the whole change.",
		};
	}
	return { body: source, truncated: false, note: null };
}

/** The clio review format: marker, right-aligned number or blanks, one space, text. */
const CLIO_ROW = /^([+\- ])( *\d+| +) (.*)$/;
const UNIFIED_HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function isClioFormat(lines: readonly string[]): boolean {
	let numbered = 0;
	for (const line of lines) {
		if (UNIFIED_HUNK.test(line)) return false;
		const match = CLIO_ROW.exec(line);
		if (match !== null && /\d/.test(match[2] ?? "")) numbered += 1;
	}
	return numbered > 0;
}

function row(kind: DiffRowKind, text: string, oldLine: number | null, newLine: number | null): DiffRow {
	return { id: "", kind, text, oldLine, newLine, lineCapped: CLIO_LINE_CAP_MARKER.test(text) };
}

function parseClioRows(lines: readonly string[]): DiffRow[] {
	const rows: DiffRow[] = [];
	for (const line of lines) {
		const match = CLIO_ROW.exec(line);
		if (match === null) {
			// A stray line the producer appended (a note, a blank tail). Carry it as
			// context so nothing is silently swallowed.
			if (line.length > 0) rows.push(row("ctx", line, null, null));
			continue;
		}
		const marker = match[1] ?? " ";
		const numberField = match[2] ?? "";
		const text = match[3] ?? "";
		const parsed = numberField.trim();
		const lineNumber = parsed.length === 0 ? null : Number(parsed);
		if (lineNumber === null) {
			rows.push(row("elision", text, null, null));
			continue;
		}
		if (marker === "+") rows.push(row("add", text, null, lineNumber));
		else if (marker === "-") rows.push(row("del", text, lineNumber, null));
		else rows.push(row("ctx", text, lineNumber, lineNumber));
	}
	return rows;
}

function parseUnifiedRows(lines: readonly string[]): { rows: DiffRow[]; noNewline: boolean } {
	const rows: DiffRow[] = [];
	let oldLine = 0;
	let newLine = 0;
	let noNewline = false;
	for (const line of lines) {
		const hunk = UNIFIED_HUNK.exec(line);
		if (hunk !== null) {
			oldLine = Number(hunk[1]);
			newLine = Number(hunk[2]);
			rows.push(row("hunk", line, oldLine, newLine));
			continue;
		}
		if (line.startsWith("---") || line.startsWith("+++") || line.startsWith("diff ") || line.startsWith("index "))
			continue;
		if (line.startsWith("\\")) {
			noNewline = true;
			continue;
		}
		if (line.startsWith("+")) {
			rows.push(row("add", line.slice(1), null, newLine));
			newLine += 1;
			continue;
		}
		if (line.startsWith("-")) {
			rows.push(row("del", line.slice(1), oldLine, null));
			oldLine += 1;
			continue;
		}
		rows.push(row("ctx", line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine));
		oldLine += 1;
		newLine += 1;
	}
	return { rows, noNewline };
}

function tally(rows: readonly DiffRow[]) {
	let adds = 0;
	let dels = 0;
	let elisions = 0;
	for (const entry of rows) {
		if (entry.kind === "add") adds += 1;
		else if (entry.kind === "del") dels += 1;
		else if (entry.kind === "elision") elisions += 1;
	}
	return { adds, dels, elisions };
}

/**
 * Parse a diff payload from either producer. Never throws: an unrecognizable
 * payload comes back as `format: "unparsed"` with the raw text in one row, and
 * the card says so rather than drawing a convincing but wrong diff.
 */
export function parseDiff(source: string): ParsedDiff {
	if (source.length === 0) return EMPTY;
	const cut = stripTruncation(source);
	if (looksBinary(cut.body))
		return {
			...EMPTY,
			format: "unparsed",
			rows: withIds([row("ctx", cut.body, null, null)]),
			truncated: cut.truncated,
			truncationNote: cut.note,
		};
	const lines = cut.body.split("\n");
	// A trailing newline in the payload produces one empty tail element that is
	// not a row of the diff.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	if (lines.length === 0) return { ...EMPTY, truncated: cut.truncated, truncationNote: cut.note };

	const clio = isClioFormat(lines);
	const parsed = clio ? { rows: parseClioRows(lines), noNewline: false } : parseUnifiedRows(lines);
	let format: DiffFormat = clio ? "clio" : "unified";
	if (!clio && !lines.some((line) => UNIFIED_HUNK.test(line))) {
		// Neither shape. Keep the text visible but refuse to label it a diff.
		format = "unparsed";
	}
	const bounded = withIds(parsed.rows.slice(0, MAX_RENDERED_DIFF_ROWS));
	const counts = tally(bounded);
	return {
		format,
		rows: bounded,
		...counts,
		truncated: cut.truncated,
		truncationNote: cut.note,
		noNewlineAtEof: parsed.noNewline,
		rowsDropped: parsed.rows.length - bounded.length,
	};
}

/** How the diff panel got its content. Drives the card's label, never its layout. */
export type DiffProvenance = "applied" | "proposed" | "rejected" | "unverified" | "skipped" | "unchanged" | "absent";

export interface DiffPanel {
	readonly provenance: DiffProvenance;
	/** Short label above the block: "Applied", "Proposed · not yet applied", … */
	readonly label: string;
	readonly diff: ParsedDiff | null;
	/** A sentence to show instead of, or beside, the block. Never model prose. */
	readonly note: string | null;
	readonly firstChangedLine: number | null;
	readonly path: string | null;
}

const PROVENANCE_LABEL: Readonly<Record<DiffProvenance, string>> = {
	applied: "Applied",
	proposed: "Proposed · not yet applied",
	rejected: "Not applied · not approved",
	unverified: "Application unverified · the call did not complete",
	skipped: "No diff available",
	unchanged: "No textual change",
	absent: "No diff available",
};

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Split into lines, keeping one line more than the render budget so the caller
 * can still tell that it overflowed. Slicing exactly to the budget here would
 * make the block indistinguishable from a proposal that happened to fit.
 */
function lines(value: string, limit: number): string[] {
	const split = value.split("\n");
	if (split.length > 0 && split[split.length - 1] === "") split.pop();
	return split.slice(0, limit + 1);
}

/**
 * Synthesize a reviewable block from the tool's ARGUMENTS, for the window
 * between the permission request and the applied result. Every row is local;
 * nothing here claims the change happened.
 */
export function synthesizeProposedDiff(input: Record<string, unknown> | undefined): ParsedDiff | null {
	if (input === undefined) return null;
	const rows: DiffRow[] = [];
	const edits = input.edits;
	if (Array.isArray(edits) && edits.length > 0) {
		for (const entry of edits) {
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			const oldText = text(record.oldText);
			const newText = text(record.newText);
			if (rows.length > 0) rows.push(row("elision", "...", null, null));
			if (oldText !== null) for (const line of lines(oldText, MAX_PROPOSED_ROWS)) rows.push(row("del", line, null, null));
			if (newText !== null) for (const line of lines(newText, MAX_PROPOSED_ROWS)) rows.push(row("add", line, null, null));
			if (rows.length >= MAX_PROPOSED_ROWS) break;
		}
	} else {
		const content = text(input.content);
		if (content === null) return null;
		let number = 1;
		for (const line of lines(content, MAX_PROPOSED_ROWS)) {
			rows.push(row("add", line, null, number));
			number += 1;
		}
	}
	if (rows.length === 0) return null;
	const bounded = withIds(rows.slice(0, MAX_PROPOSED_ROWS));
	return {
		format: "clio",
		rows: bounded,
		...tally(bounded),
		truncated: rows.length > bounded.length,
		truncationNote:
			rows.length > bounded.length
				? `This preview stops at ${MAX_PROPOSED_ROWS} lines. The proposal itself is longer.`
				: null,
		noNewlineAtEof: false,
		rowsDropped: rows.length - bounded.length,
	};
}

export interface DiffInputs {
	readonly rawInput: Record<string, unknown> | undefined;
	/** `rawOutput.result` once unwrapped, or undefined when the call has not settled. */
	readonly result: Record<string, unknown> | undefined;
	/** The result's text, whether it came from `output` or an error `message`. */
	readonly resultText: string | null;
	readonly status: string;
	readonly isError: boolean;
}

/**
 * Decide what the diff panel shows for one edit/write/artifact call. The whole
 * decision lives here so the component is a switch over `provenance`.
 */
export function diffPanel(inputs: DiffInputs): DiffPanel {
	const path = text(inputs.rawInput?.path);
	const details =
		typeof inputs.result?.details === "object" && inputs.result.details !== null
			? (inputs.result.details as Record<string, unknown>)
			: undefined;
	const raw = details === undefined ? null : text(details.diff);
	const firstChangedLine =
		typeof details?.firstChangedLine === "number" && Number.isInteger(details.firstChangedLine)
			? details.firstChangedLine
			: null;
	// Only a COMPLETED call has earned the right to say there is nothing to show.
	// A refused or failed write produced no diff precisely because it never ran,
	// and suppressing the proposal there erases the evidence of what the operator
	// just turned down: the card would read "No diff available" under the very
	// change they refused, with the arguments surviving only inside the closed
	// raw disclosure.
	const completed = inputs.status === "completed";
	// A bare `failed` or `cancelled` status proves neither an operator rejection
	// nor zero bytes written. Only the producer's own refusal sentence earns
	// "not approved"; everything else stays neutral about what reached disk.
	const refused = inputs.resultText?.includes(NOT_APPROVED_NOTE) ?? false;
	const settled = inputs.status === "failed" || inputs.status === "cancelled";

	if (raw !== null) {
		const parsed = parseDiff(raw);
		const noNewline = parsed.noNewlineAtEof || (inputs.resultText?.includes(NO_TRAILING_NEWLINE_NOTE) ?? false);
		const diff = noNewline === parsed.noNewlineAtEof ? parsed : { ...parsed, noNewlineAtEof: true };
		if (diff.rows.length === 0)
			return {
				provenance: "unchanged",
				label: PROVENANCE_LABEL.unchanged,
				diff,
				note: "The tool reported success and produced an empty diff, so the file's text is unchanged.",
				firstChangedLine,
				path,
			};
		return {
			provenance: "applied",
			label: PROVENANCE_LABEL.applied,
			diff,
			note:
				diff.format === "unparsed"
					? "Clio Coder returned a diff this view could not parse. The raw bytes are in the disclosure below."
					: null,
			firstChangedLine,
			path,
		};
	}

	if (inputs.resultText?.includes(DIFF_SKIPPED_NOTE) === true)
		return {
			provenance: "skipped",
			label: PROVENANCE_LABEL.skipped,
			diff: null,
			note: "The file is larger than 1 MiB, so Clio Coder did not render a diff. The change itself still happened.",
			firstChangedLine,
			path,
		};

	const proposed = completed ? null : synthesizeProposedDiff(inputs.rawInput);
	if (proposed !== null) {
		const provenance: DiffProvenance = refused ? "rejected" : settled ? "unverified" : "proposed";
		const note =
			provenance === "rejected"
				? "Nothing was written. This is the change Clio Coder asked to make."
				: provenance === "unverified"
					? "The call did not complete, so this view cannot confirm whether any of it reached the file. This is the change Clio Coder asked to make."
					: "Built from the tool's arguments in this browser. Nothing has been written yet.";
		return { provenance, label: PROVENANCE_LABEL[provenance], diff: proposed, note, firstChangedLine, path };
	}

	return {
		provenance: "absent",
		label: PROVENANCE_LABEL.absent,
		diff: null,
		note: inputs.isError ? null : "This call reported no diff.",
		firstChangedLine,
		path,
	};
}

export interface CollapsePlan {
	/** Inclusive row index range to render when collapsed. */
	readonly start: number;
	readonly end: number;
	readonly collapsed: boolean;
	readonly hiddenRows: number;
}

/**
 * A diff of more than COLLAPSE_THRESHOLD_ROWS rows opens around the first
 * change; anything shorter opens whole. Returned as indices so the component
 * slices without re-deriving the policy.
 */
export function collapsePlan(diff: ParsedDiff, firstChangedLine: number | null): CollapsePlan {
	const total = diff.rows.length;
	if (total <= COLLAPSE_THRESHOLD_ROWS)
		return { start: 0, end: Math.max(0, total - 1), collapsed: false, hiddenRows: 0 };
	let anchor = diff.rows.findIndex((entry) => entry.kind === "add" || entry.kind === "del");
	if (firstChangedLine !== null) {
		const exact = diff.rows.findIndex((entry) => entry.newLine === firstChangedLine);
		if (exact >= 0) anchor = exact;
	}
	if (anchor < 0) anchor = 0;
	const half = Math.floor(COLLAPSE_THRESHOLD_ROWS / 2);
	let start = Math.max(0, anchor - COLLAPSE_CONTEXT_ROWS);
	let end = Math.min(total - 1, start + COLLAPSE_THRESHOLD_ROWS - 1);
	if (end - start + 1 < COLLAPSE_THRESHOLD_ROWS) start = Math.max(0, end - COLLAPSE_THRESHOLD_ROWS + 1);
	if (anchor > end) {
		start = Math.max(0, anchor - half);
		end = Math.min(total - 1, start + COLLAPSE_THRESHOLD_ROWS - 1);
	}
	return { start, end, collapsed: true, hiddenRows: total - (end - start + 1) };
}

/** `+12 −3` for the header strip, with the real minus sign. */
export function diffCounts(diff: ParsedDiff): string {
	return `+${diff.adds} −${diff.dels}`;
}

/** The text an operator copies: code only, no markers, no line numbers. */
export function diffCopyText(diff: ParsedDiff): string {
	return diff.rows
		.filter((entry) => entry.kind !== "elision" && entry.kind !== "hunk")
		.map((entry) => `${entry.kind === "add" ? "+" : entry.kind === "del" ? "-" : " "}${entry.text}`)
		.join("\n");
}
