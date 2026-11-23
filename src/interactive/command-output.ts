import type { OutputStyle } from "../core/defaults.js";
import { tierPolicy } from "../core/presentation-tier.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactUrlCredentials } from "../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { NoticeLevel, NoticeSource } from "../session-control/notice-source.js";
import type { PromptReferenceCard, RunIo } from "../session-control/slash-commands.js";
import { CARD_CALLOUT_MAX_WIDTH, CARD_GUTTER, cardRows } from "./card.js";
import { renderNoticeRow } from "./renderers/notice.js";
import { renderReferenceCard } from "./renderers/reference-card.js";
import { renderTranscriptReport, type TranscriptReport, transcriptReportFromText } from "./renderers/report.js";
import { clioTheme, GLYPH } from "./theme/index.js";
import { type TranscriptDetailPolicy, transcriptDetail } from "./transcript-detail.js";

export type { NoticeLevel } from "../session-control/notice-source.js";

const NOTICE_MARKS = { info: "info", success: "success", warn: "warning", error: "error" } as const;

/**
 * A bus or command notice in the transcript. An event keeps its gutter row. An
 * advisory, which the emitter names with `source`, renders through the
 * transcript's own notice renderer as a titled callout, so it reads the same
 * here as a persisted notice does on replay. The emitter chooses, never the
 * width.
 */
export function appendNotice(level: NoticeLevel, text: string, sink: CommandOutputSink, source?: NoticeSource): void {
	// A notice can quote an error, and Node's own fetch error quotes the whole URL (#446).
	const normalized = redactUrlCredentials(text).replace(/\r/g, "").trimEnd();
	if (normalized.trim().length === 0) return;
	if (source === undefined && normalized.includes("\n")) {
		const report = transcriptReportFromText(normalized, undefined, level);
		sink.appendReplayBlock((width, detail, unbounded) =>
			renderCommandReport(report, width, detail?.style, unbounded === true),
		);
	} else {
		const mark = level === "info" && /^\S+ cancelled\b/u.test(normalized) ? "cancelled" : NOTICE_MARKS[level];
		sink.appendReplayBlock((width, _detail, unbounded) => {
			// A reminder keeps its own one-row gist; /view keeps every token whole.
			const whole = unbounded === true || (source === "reminder" && width >= 8);
			const text = whole ? normalized : cutWideTokens(normalized, noticeRoom(width, source));
			return renderNoticeRow(text, mark, width, source, unbounded === true);
		});
	}
	sink.requestRender();
}

/** Cells a notice's words get: the content column beside the mark, or the inside of a callout's frame. */
function noticeRoom(width: number, source: NoticeSource | undefined): number {
	if (source === undefined) return Math.max(1, width - CARD_GUTTER.length);
	if (width < 8) return Math.max(1, width);
	return Math.max(1, Math.min(CARD_CALLOUT_MAX_WIDTH, width - CARD_GUTTER.length) - 4);
}

/** Every word wider than a row cut with `…`, so the wrap below breaks only at spaces. */
function cutWideTokens(text: string, room: number): string {
	return text.replace(/\S+/gu, (token) => (visibleWidth(token) > room ? cutToken(token, room) : token));
}

/** The leading characters of plain text that fit `room` cells, at least one so a row always advances. */
function takeCells(text: string, room: number): string {
	let taken = "";
	let used = 0;
	for (const char of text) {
		const cells = visibleWidth(char);
		if (used + cells > room && taken.length > 0) break;
		taken += char;
		used += cells;
	}
	return taken;
}

/** A plain token cut to `room` cells and marked with `…`, with no escape sequence that would end the row's style. */
function cutToken(token: string, room: number): string {
	const mark = visibleWidth(GLYPH.ellipsis);
	return room > mark ? `${takeCells(token, room - mark)}${GLYPH.ellipsis}` : takeCells(GLYPH.ellipsis, room);
}

/** Fewest cells a hanging column must leave its value before the hang moves left. */
const MIN_HANG_ROOM = 12;

interface WrappedWords {
	rows: string[];
	cut: boolean;
}

/**
 * Words packed greedily at spaces: `firstRoom` cells on the first row, `restRoom` after. A word wider than its row
 * is the only thing cut, with `…`; `whole` (/view) breaks it across rows instead so nothing is lost.
 */
function wrapWords(text: string, firstRoom: number, restRoom: number, whole: boolean): WrappedWords {
	const rows: string[] = [];
	let line = "";
	let cut = false;
	const room = (): number => Math.max(1, rows.length === 0 ? firstRoom : restRoom);
	for (const word of text.split(/ +/u)) {
		if (word.length === 0) continue;
		if (line.length > 0 && visibleWidth(line) + 1 + visibleWidth(word) <= room()) {
			line += ` ${word}`;
			continue;
		}
		if (line.length > 0) rows.push(line);
		line = word;
		if (visibleWidth(line) <= room()) continue;
		if (!whole) {
			line = cutToken(line, room());
			cut = true;
			continue;
		}
		while (visibleWidth(line) > room()) {
			const head = takeCells(line, room());
			rows.push(head);
			line = line.slice(head.length);
		}
	}
	if (line.length > 0 || rows.length === 0) rows.push(line);
	return { rows, cut };
}

/** A padded `label  value` row: its indent, the label, and the column its value starts at. */
const LABEL_ROW = /^( *)(\S(?:.*?\S)?)( {2,})(?=\S)/u;
/** A `label: value` row, which the Standard table also reads as a field. */
const COLON_ROW = /^\s*(.+?):\s+(\S.*)$/u;

interface ValueColumn {
	indent: number;
	column: number;
}

/**
 * The value column a block of padded rows shares, the one most of its label rows agree on. A label padded to exactly
 * its column width leaves one space before the value (`Workers dock shown`), so a row at the same indent is read
 * against this column as well as its own run of spaces.
 */
function sharedValueColumn(lines: ReadonlyArray<string>): ValueColumn | null {
	const votes = new Map<string, { at: ValueColumn; count: number }>();
	for (const line of lines) {
		const match = LABEL_ROW.exec(line);
		if (!match) continue;
		const indent = (match[1] ?? "").length;
		const column = indent + visibleWidth(match[2] ?? "") + (match[3] ?? "").length;
		const key = `${indent}:${column}`;
		const vote = votes.get(key) ?? { at: { indent, column }, count: 0 };
		vote.count += 1;
		votes.set(key, vote);
	}
	let best: { at: ValueColumn; count: number } | null = null;
	for (const vote of votes.values()) if (best === null || vote.count > best.count) best = vote;
	return best?.at ?? null;
}

interface SplitRow {
	indent: number;
	label: string;
	/** Where the value starts, or null when the row has no padded label. */
	column: number | null;
	value: string;
}

function splitRow(line: string, shared: ValueColumn | null, colon = false): SplitRow {
	const indent = line.length - line.trimStart().length;
	if (shared !== null && shared.indent === indent && shared.column > indent + 1) {
		const { column } = shared;
		const label = line.slice(indent, column).trim();
		if (label.length > 0 && line[column - 1] === " " && /\S/u.test(line[column] ?? ""))
			return { indent, label, column, value: line.slice(column) };
	}
	const match = LABEL_ROW.exec(line);
	if (match) {
		const column = indent + visibleWidth(match[2] ?? "") + (match[3] ?? "").length;
		return { indent, label: match[2] ?? "", column, value: line.slice(column) };
	}
	const field = colon ? COLON_ROW.exec(line) : null;
	if (field) return { indent, label: field[1] ?? "", column: null, value: field[2] ?? "" };
	return { indent, label: "", column: null, value: line.trimStart() };
}

/**
 * One command-output line at its own layout, wrapped at spaces. A continuation hangs where the value began, or under
 * a label-less row's own text, and never at the rail; when that column leaves the value too little room it moves left.
 */
function wrapCommandLine(line: string, width: number, shared: ValueColumn | null, whole: boolean): WrappedWords {
	if (visibleWidth(line) <= width) return { rows: [line], cut: false };
	const row = splitRow(line, shared);
	const fits = (column: number): boolean => width - column >= MIN_HANG_ROOM;
	const start = row.column !== null && fits(row.column) ? row.column : row.indent;
	const hang = [row.column ?? Math.max(row.indent, 2), row.indent + 2, 2].find(fits) ?? 0;
	const prefix = start === row.column ? line.slice(0, start) : " ".repeat(start);
	const words = start === row.column ? row.value : line.slice(row.indent);
	const wrapped = wrapWords(words, width - start, width - hang, whole);
	return {
		rows: wrapped.rows.map((text, index) => (index === 0 ? `${prefix}${text}` : `${" ".repeat(hang)}${text}`)),
		cut: wrapped.cut,
	};
}

/**
 * A multi-line command reply as a report card. Compact keeps the counter head. Standard draws the label table with
 * each value wrapped inside its value column; Detailed and /view keep the producer's own layout, wrapped the same way.
 */
function renderCommandReport(report: TranscriptReport, width: number, style: OutputStyle = "standard", whole = false) {
	if (!tierPolicy(style).evidence && !whole) return renderTranscriptReport(report, width, style, false);
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	const failure = report.level === "error";
	const head = {
		title: report.title,
		summary: report.summary,
		rows: [],
		...(report.level ? { level: report.level } : {}),
	};
	const lines = renderTranscriptReport(head, safeWidth, "detailed");
	const body = (report.text ?? "").split("\n").filter((line) => line.trim().length > 0);
	const shared = sharedValueColumn(body);
	const inner = safeWidth - 4;
	if (tierPolicy(style).provenance || whole) {
		let cut = false;
		for (const line of body) {
			const wrapped = wrapCommandLine(line, inner, shared, whole);
			cut ||= wrapped.cut;
			for (const row of wrapped.rows) lines.push(...cardRows(row, safeWidth, failure, "body"));
		}
		if (cut) lines.push(...cardRows(`${GLYPH.ellipsis} /view for all`, safeWidth, failure, "commandHint"));
		return lines;
	}
	const clean = (text: string) => sanitizeCallTargetText(redactUrlCredentials(text));
	const rows = body.map((line) => splitRow(line, shared, true));
	const budget = transcriptDetail("standard").invocationRows;
	const shown = rows.slice(0, budget);
	const labelWidth = Math.min(
		24,
		Math.floor(inner / 3),
		Math.max(0, ...shown.map((row) => visibleWidth(clean(row.label)))),
	);
	let clipped = false;
	for (const row of shown) {
		const labelText = clean(row.label);
		const label = truncateToWidth(labelText, labelWidth, GLYPH.ellipsis, false);
		const lead = labelWidth === 0 ? "" : `${label}${" ".repeat(labelWidth - visibleWidth(label))}  `;
		const room = Math.max(1, inner - visibleWidth(lead));
		const value = wrapWords(clean(row.value), room, room, false);
		clipped ||= visibleWidth(labelText) > labelWidth || value.cut;
		for (const [index, text] of value.rows.entries()) {
			const rowLead = index === 0 ? theme.fg("annotation", lead) : " ".repeat(visibleWidth(lead));
			lines.push(...cardRows(`${rowLead}${text}`, safeWidth, failure));
		}
	}
	const remaining = rows.length - shown.length;
	if (remaining > 0 || clipped)
		lines.push(
			...cardRows(
				`${GLYPH.ellipsis} ${remaining > 0 ? `${remaining} more ${GLYPH.dot} ` : ""}Detailed or /view for all`,
				safeWidth,
				failure,
				"commandHint",
			),
		);
	return lines;
}

/**
 * The session entry that records an operator command's echo, so `/resume`
 * states the `/run` above the card it started. Display only: the model's
 * context is built from message entries, and this is never one.
 */
export const OPERATOR_COMMAND_ENTRY = "operatorCommand";
/** Session entry holding a settled run's operator wait, which replay has no other way to know. Never model context. */
export const TURN_HUMAN_WAIT_ENTRY = "turnHumanWait";

/** An operator command line as the transcript echoes it, live and on replay. */
export function renderOperatorCommandRows(text: string, width: number): string[] {
	const normalized = sanitizeCallTargetText(text);
	if (normalized.length === 0) return [];
	const theme = clioTheme();
	// The operator's own input wears the prompt bar, dimmed: it is theirs, but
	// it was a command, not a turn the model saw.
	const bar = `${theme.fg("annotation", GLYPH.userBar)} `;
	return wrapTextWithAnsi(theme.fg("annotation", normalized), Math.max(1, width - 2)).map((row) => `${bar}${row}`);
}

/**
 * Echo the command line an operator typed, dimmed, above the output it starts.
 *
 * A dispatched run draws its own attributed block, and without this the block
 * appears with nothing above it saying who asked for it or what was asked. The
 * echo never reaches the model, which is the whole point of a `/run` the main
 * agent is not told about; the host records it as an `operatorCommand` session
 * entry so a resumed transcript states it too.
 */
export function appendOperatorCommand(text: string, sink: CommandOutputSink): void {
	if (text.replace(/\r/g, "").trim().length === 0) return;
	sink.appendReplayBlock((width) => renderOperatorCommandRows(text, width));
	sink.requestRender();
}

/**
 * Render a display-only prompt template for the operator. A replay block like
 * the command echo above: it is never persisted as a session entry and never
 * reaches the model, which is what "display only" promises the author.
 */
export function appendReferenceCard(card: PromptReferenceCard, sink: CommandOutputSink): void {
	sink.appendReplayBlock((width, detail, unbounded) => renderReferenceCard(card, width, detail?.style, unbounded));
	sink.requestRender();
}

/**
 * A dim line under an operator turn, in the prose gutter, saying something
 * about the turn that the operator did not type: which template expanded, how
 * long it was. Transcript-only, like the echo above.
 */
export function appendOperatorAside(text: string, sink: CommandOutputSink): void {
	const normalized = text.replace(/\r/g, "").replace(/\n+/gu, " ").trim();
	if (normalized.length === 0) return;
	sink.appendReplayBlock((width) => {
		const theme = clioTheme();
		return wrapTextWithAnsi(theme.fg("annotation", normalized), Math.max(1, width - 2)).map((line) => `  ${line}`);
	});
	sink.requestRender();
}

export interface InterviewRecordEntry {
	/** The question's header, or its first line when it has none. */
	label: string;
	answer: string;
}

/**
 * What a round of an interview asked and what the operator answered, kept in
 * the transcript once the overlay has moved on. Without it the round left
 * only a tool row reading `▸ tool action {"action":"ask",…`, and the answers
 * lived on `/decisions` alone.
 */
export function appendInterviewRecord(entries: ReadonlyArray<InterviewRecordEntry>, sink: CommandOutputSink): void {
	const kept = entries.filter((entry) => entry.answer.trim().length > 0);
	if (kept.length === 0) return;
	sink.appendReplayBlock((width) => {
		const theme = clioTheme();
		const lines: string[] = [];
		const inner = Math.max(1, width - 2);
		for (const entry of kept) {
			const label = entry.label.replace(/\s+/gu, " ").trim();
			lines.push(...wrapTextWithAnsi(`${theme.fg("guidance", GLYPH.cursor)} ${theme.fg("annotation", label)}`, width));
			lines.push(...wrapTextWithAnsi(theme.fg("body", entry.answer.trim()), inner).map((line) => `  ${line}`));
		}
		return lines;
	});
	sink.requestRender();
}

export type CommandOutputReplayBlock = (
	width: number,
	detail?: TranscriptDetailPolicy,
	unbounded?: boolean,
) => string[];

export interface CommandOutputSink {
	appendReplayBlock(renderBlock: CommandOutputReplayBlock): void;
	requestRender(): void;
}

export function createCommandOutputRunIo(sink: CommandOutputSink): RunIo {
	return {
		stdout: (text) => appendNotice("info", text, sink),
		stderr: (text) => appendNotice("error", text, sink),
	};
}
