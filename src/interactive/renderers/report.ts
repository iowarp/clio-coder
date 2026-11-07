import type { OutputStyle } from "../../core/defaults.js";
import { sanitizeCallTargetText, sanitizeMultilineDisplayText } from "../../domains/safety/call-target.js";
import { redactUrlCredentials } from "../../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import type { NoticeLevel } from "../../session-control/notice-source.js";
import { cardHead, cardRows } from "../card.js";
import { clioTheme, GLYPH } from "../theme/index.js";
import type { SemanticRole } from "../theme/tokens.js";
import { transcriptDetail } from "../transcript-detail.js";

export interface TranscriptReportRow {
	label: string;
	value: string;
	detail?: string;
	token?: SemanticRole;
}

export interface TranscriptReport {
	title: string;
	summary: string;
	compactSummary?: string;
	rows: ReadonlyArray<TranscriptReportRow>;
	level?: NoticeLevel;
	/** Text producers retain their original layout for Detailed and /view. */
	text?: string;
}

/** Adapt legacy text once, before a notice sanitizer can flatten its rows. */
export function transcriptReportFromText(text: string, title?: string, level?: NoticeLevel): TranscriptReport {
	const clean = sanitizeMultilineDisplayText(redactUrlCredentials(text)).text.trimEnd();
	const lines = clean.split("\n").filter((line) => line.trim().length > 0);
	const first = lines[0] ?? "";
	const fields = (line: string): TranscriptReportRow => {
		const match = /^\s*(.+?)(?::\s+| {2,})(\S.*)$/u.exec(line);
		return match ? { label: match[1] ?? "", value: match[2] ?? "" } : { label: "", value: line.trim() };
	};
	const firstField = fields(first);
	const heading = title ?? (firstField.label || first);
	const rows = (title === undefined && firstField.label.length === 0 ? lines.slice(1) : lines).map(fields);
	const count = rows.length;
	const counters = rows
		.filter((row) => row.label.length > 0 && /^(?:[$]\s*)?\d/u.test(row.value))
		.map((row) => `${row.label} ${row.value}`);
	const summary = `${count} ${count === 1 ? "entry" : "entries"}`;
	const compactSummary = counters.length > 0 ? counters.join(` ${GLYPH.dot} `) : summary;
	const body =
		title === undefined && firstField.label.length === 0
			? clean.slice(clean.indexOf(first) + first.length).replace(/^\n/u, "")
			: clean;
	return {
		title: heading,
		summary,
		compactSummary:
			title === undefined && firstField.label.length > 0 && !counters.includes(`${firstField.label} ${firstField.value}`)
				? `${compactSummary} ${GLYPH.dot} ${firstField.value}`
				: compactSummary,
		rows,
		text: body,
		...(level !== undefined ? { level } : {}),
	};
}

/** Minimal counters, a Default fact table, or every captured detail. */
export function renderTranscriptReport(
	report: TranscriptReport,
	width: number,
	style: OutputStyle = "standard",
	unbounded = false,
): string[] {
	const theme = clioTheme();
	const safeWidth = Math.max(8, width);
	const failure = report.level === "error";
	const token = failure
		? "error"
		: report.level === "warn"
			? "warning"
			: report.level === "success"
				? "success"
				: "heading";
	const mark = failure
		? GLYPH.error
		: report.level === "warn"
			? GLYPH.warn
			: report.level === "success"
				? GLYPH.ok
				: GLYPH.info;
	const clean = (text: string) => sanitizeCallTargetText(redactUrlCredentials(text));
	const summary = style === "compact" && !unbounded ? (report.compactSummary ?? report.summary) : report.summary;
	const head = `${theme.fg(token, `${mark} ${clean(report.title)}`)} ${theme.fg("annotation", `${GLYPH.dot} ${clean(summary)}`)}`;
	if (style === "compact" && !unbounded)
		return cardHead(truncateToWidth(head, safeWidth, GLYPH.ellipsis, false), "", safeWidth);
	const lines = cardHead(head, "", safeWidth);
	if (style === "detailed" || unbounded) {
		if (report.text !== undefined) {
			for (const row of report.text.split("\n")) lines.push(...cardRows(row, safeWidth, failure, "body"));
		} else {
			for (const row of report.rows) {
				lines.push(...cardRows(`${clean(row.label)}  ${clean(row.value)}`, safeWidth, failure, row.token));
				if (row.detail !== undefined)
					for (const detail of sanitizeMultilineDisplayText(redactUrlCredentials(row.detail)).text.split("\n"))
						lines.push(...cardRows(detail, safeWidth, failure, "body"));
			}
		}
		return lines;
	}
	const budget = transcriptDetail("standard").invocationRows;
	const shown = report.rows.slice(0, budget);
	const inner = safeWidth - 4;
	const labelWidth = Math.min(
		24,
		Math.floor(inner / 3),
		Math.max(0, ...shown.map((row) => visibleWidth(clean(row.label)))),
	);
	for (const row of shown) {
		const label = truncateToWidth(clean(row.label), labelWidth, GLYPH.ellipsis, false);
		const lead = labelWidth === 0 ? "" : `${label}${" ".repeat(labelWidth - visibleWidth(label))}  `;
		const value = truncateToWidth(clean(row.value), Math.max(1, inner - visibleWidth(lead)), GLYPH.ellipsis, false);
		lines.push(...cardRows(`${theme.fg("annotation", lead)}${value}`, safeWidth, failure, row.token));
	}
	if (report.rows.length > shown.length)
		lines.push(
			...cardRows(
				`${GLYPH.ellipsis} ${report.rows.length - shown.length} more ${GLYPH.dot} Detailed or /view for all`,
				safeWidth,
				failure,
				"commandHint",
			),
		);
	return lines;
}
