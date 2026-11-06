import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../../engine/tui.js";
import { GLYPH } from "./glyphs.js";
import { fitIdentityLabel, keyName } from "./labels.js";
import { padAnsi, rule } from "./rules.js";
import { dotSep } from "./segments.js";
import type { ClioTheme, ClioToken, SemanticRole } from "./tokens.js";

/**
 * The shared design language for dialogs, dashboards and panels.
 *
 * Every helper here is pure: it takes the theme and a width and returns
 * strings that already fit that width by `visibleWidth`. Callers compose rows
 * and never paint; the only colors are the tokens the theme resolves. Each
 * primitive states how it degrades when the width shrinks, so a surface built
 * from them reads the same way at 60 columns as at 200, with less on screen
 * rather than something cut mid-word.
 *
 * The grammar, in one place:
 *
 * - A **tone** says what a thing means (success, warning, error, action,
 *   accent, info, muted, neutral); the theme says what it looks like.
 * - A **chip** is one short fact painted in its tone; a **status chip** leads
 *   with the outcome glyph so the shape survives a monochrome terminal.
 * - A **key cap** is `[Enter]`, the same spelling the rails use.
 * - A **section rule** labels a region; a **title row** names a surface.
 * - A **fact table** is label/value pairs; values wrap under their label.
 * - A **table** is columns that shrink, then drop by priority, never silently.
 * - A **meter** is `━━━━────`, fill then free, and its amount beside it.
 * - A **selection row** is the one cursor rule every list obeys.
 * - A **choice row** is a key, its verb and its consequence, for decisions.
 * - A **command block** is the exact bytes under decision, in a gutter.
 * - **Empty** and **error** states say what is missing and what to do.
 */

/** What a fact means. The theme owns what each tone looks like. */
export type Tone = "neutral" | "muted" | "accent" | "action" | "info" | "success" | "warning" | "error";

const TONE_ROLE: Readonly<Record<Tone, SemanticRole>> = {
	neutral: "body",
	muted: "annotation",
	accent: "guidance",
	action: "attention",
	info: "info",
	success: "success",
	warning: "warning",
	error: "error",
};

export function toneRole(tone: Tone): SemanticRole {
	return TONE_ROLE[tone];
}

/** Below this width labels stack above their values and a choice's consequence takes its own row. */
export const NARROW_WIDTH = 48;

/** Where an oversized token may fold: after a path, option or list separator. */
const FOLD_AFTER = new Set(["/", "-", "_", ".", "=", ",", ";", ":", "&", "|"]);

/** Clip to `width`, closing with the ellipsis when something was lost. */
function clip(text: string, width: number): string {
	const safe = Math.max(0, Math.floor(width));
	return visibleWidth(text) <= safe ? text : truncateToWidth(text, safe, GLYPH.ellipsis, false);
}

/** Word-wrap to `width`; a path or URL longer than the row breaks after a `/`, and only a longer segment folds hard. */
function wrap(text: string, width: number): string[] {
	return wrapPaths(text, width);
}

/** An escape sequence or a run of visible text; built from the escape code so the source carries no control character. */
const ESCAPE = String.fromCharCode(27);
const ANSI_OR_WORD = new RegExp(`${ESCAPE}\\[[0-9;:]*[A-Za-z]|[^\\s${ESCAPE}]+`, "gu");

/**
 * Word-wrap to `width` the way `wrapTextWithAnsi` does, except that a word wider than the row which contains `/`
 * breaks after a separator: `/home/me/.config/` then `herdr/herdr.sock`, not `/home/me/.config/he` then `rdr/…`.
 */
export function wrapPaths(text: string, width: number): string[] {
	const room = Math.max(1, Math.floor(width));
	if (!text.includes("/")) return wrapTextWithAnsi(text, room);
	const broken = text.replace(ANSI_OR_WORD, (token) => {
		if (token.startsWith(ESCAPE) || !token.includes("/") || visibleWidth(token) <= room) return token;
		const lines: string[] = [];
		let line = "";
		for (const part of token.split(/(?<=\/)/u)) {
			if (line.length > 0 && visibleWidth(line + part) > room) {
				lines.push(line);
				line = part;
			} else line += part;
		}
		lines.push(line);
		return lines.join("\n");
	});
	return wrapTextWithAnsi(broken, room);
}

/** A short fact in its tone, with an optional leading glyph. */
export function chip(theme: ClioTheme, text: string, tone: Tone = "neutral", glyph?: string): string {
	const body = glyph === undefined ? text : `${glyph} ${text}`;
	return theme.fg(toneRole(tone), body);
}

export type StatusKind = "ok" | "error" | "warning" | "info" | "running" | "queued" | "cancelled" | "pending";

/**
 * The order a row leads its status chips in, worst first, so a narrowing meta
 * drops the reassuring chip and never the one that says something is broken.
 * A cancelled state (disabled, muted, shadowed, declined) is a standing fact
 * the operator scans for; queued only says not yet, so it ranks below it.
 */
const STATUS_SEVERITY: Readonly<Record<StatusKind, number>> = {
	error: 0,
	warning: 1,
	pending: 2,
	cancelled: 3,
	queued: 4,
	info: 5,
	running: 6,
	ok: 7,
};

/** Lower is worse. Sort a row's status chips by this before joining them. */
export function statusSeverity(status: StatusKind): number {
	return STATUS_SEVERITY[status];
}

const STATUS_GLYPH: Readonly<Record<StatusKind, string>> = {
	ok: GLYPH.ok,
	error: GLYPH.error,
	warning: GLYPH.warn,
	info: GLYPH.info,
	running: GLYPH.running,
	queued: GLYPH.queued,
	cancelled: GLYPH.cancelled,
	pending: GLYPH.phaseWaiting,
};

const STATUS_TONE: Readonly<Record<StatusKind, Tone>> = {
	ok: "success",
	error: "error",
	warning: "warning",
	info: "info",
	running: "accent",
	queued: "muted",
	cancelled: "muted",
	pending: "action",
};

/**
 * An outcome as one chip: glyph first, so the shape alone tells ok from error
 * when color is gone. Without a label the chip is the glyph alone, which is
 * how a narrow row keeps the outcome and drops the words.
 */
export function statusChip(theme: ClioTheme, status: StatusKind, label?: string): string {
	const glyph = STATUS_GLYPH[status];
	return chip(theme, label === undefined ? glyph : `${glyph} ${label}`, STATUS_TONE[status]);
}

/** `[Enter]`, in the key color, the spelling the rails and footers already use. */
export function keyCap(theme: ClioTheme, key: string, role: SemanticRole = "decisionKey"): string {
	return theme.fg(role, `[${keyName(key)}]`);
}

/** Chips on one row, joined by the quiet middot, clipped to `width`. */
export function chipRow(theme: ClioTheme, chips: ReadonlyArray<string | null | undefined>, width: number): string {
	const present = chips.filter((part): part is string => typeof part === "string" && part.length > 0);
	const separator = dotSep(theme);
	const whole = present.join(separator);
	if (visibleWidth(whole) <= width) return whole;
	// A chip cut mid-word reads as a different fact, so the row gives up whole chips
	// from its end and marks that it did. Chips that arrived joined count one by one.
	const pieces = whole.split(separator);
	for (let kept = pieces.length - 1; kept >= 1; kept--) {
		const row = [...pieces.slice(0, kept), GLYPH.ellipsis].join(separator);
		if (visibleWidth(row) <= width) return row;
	}
	return clip(pieces[0] ?? "", width);
}

/**
 * Chips on as many rows as they take, wrapping between chips and never inside
 * one, so a decision surface loses no fact to the row's end. A chip wider than
 * the row folds at its spaces, which keeps every character on screen.
 */
export function chipRows(theme: ClioTheme, chips: ReadonlyArray<string | null | undefined>, width: number): string[] {
	const safe = Math.max(1, Math.floor(width));
	const present = chips.filter((part): part is string => typeof part === "string" && part.length > 0);
	const separator = dotSep(theme);
	const separatorWidth = visibleWidth(separator);
	// Packed chip by chip, so a row break falls between chips and takes the
	// separator with it: a row never ends on a dangling `·`.
	const rows: string[] = [];
	let row = "";
	let rowWidth = 0;
	for (const chip of present) {
		const chipWidth = visibleWidth(chip);
		if (row.length > 0 && rowWidth + separatorWidth + chipWidth <= safe) {
			row += separator + chip;
			rowWidth += separatorWidth + chipWidth;
			continue;
		}
		if (row.length > 0) rows.push(row);
		if (chipWidth <= safe) {
			row = chip;
			rowWidth = chipWidth;
			continue;
		}
		const folded = wrap(chip, safe);
		rows.push(...folded.slice(0, -1));
		row = folded.at(-1) ?? "";
		rowWidth = visibleWidth(row);
	}
	if (row.length > 0 || rows.length === 0) rows.push(row);
	return rows;
}

export interface SectionRuleOptions {
	/** Dim text at the right end of the rule: a count, a scope, a key. */
	meta?: string;
	/** The label's token; defaults to the section heading role. */
	token?: ClioToken;
}

/**
 * `Label ──────────── meta`: the one divider that names a region inside a
 * dialog or a dashboard page. A bare `rule()` stays the unlabeled separator.
 */
export function sectionRule(theme: ClioTheme, width: number, label: string, options: SectionRuleOptions = {}): string {
	const safe = Math.max(1, Math.floor(width));
	// The meta is a key or a count the reader needs; a label that would push it
	// off the row is clipped with an ellipsis instead, keeping two cells of rule.
	const metaWidth = options.meta === undefined ? 0 : visibleWidth(options.meta) + 3;
	const room = Math.max(1, safe - metaWidth - 3);
	return rule(theme, safe, {
		left: clip(label, room),
		...(options.token === undefined ? {} : { leftToken: options.token }),
		...(options.meta === undefined ? {} : { right: options.meta }),
	});
}

/** A bold section label with an optional dim count, for a region that needs no rule. */
export function sectionLabel(theme: ClioTheme, label: string, count?: number | string): string {
	const heading = theme.style("sectionHeading", label, { bold: true });
	return count === undefined ? heading : `${heading} ${theme.fg("annotation", String(count))}`;
}

export interface TitleRowOptions {
	/** Dim right-aligned metadata; dropped before the title is clipped. */
	meta?: string;
	/** Title token; the heading role by default, a tone for a decision. */
	token?: ClioToken;
}

/**
 * A surface's own title inside its body: bold title left, dim meta right,
 * exactly `width` cells. The meta goes first when the row is short.
 */
export function titleRow(theme: ClioTheme, title: string, width: number, options: TitleRowOptions = {}): string {
	const safe = Math.max(1, Math.floor(width));
	const heading = theme.style(options.token ?? "heading", title, { bold: true });
	const meta = options.meta === undefined ? "" : theme.fg("annotation", options.meta);
	const titleWidth = visibleWidth(title);
	const metaWidth = visibleWidth(meta);
	if (metaWidth > 0 && titleWidth + 2 + metaWidth <= safe) {
		return `${heading}${" ".repeat(safe - titleWidth - metaWidth)}${meta}`;
	}
	return padAnsi(clip(heading, safe), safe);
}

export interface Fact {
	label: string;
	/** May already carry styling; plain text takes the fact's tone. */
	value: string;
	tone?: Tone;
	/** `word` wraps at spaces (the default); `clip` keeps one row and closes with an ellipsis. */
	fit?: "word" | "clip";
}

export interface FactRowsOptions {
	/** Widest label column, in cells; the labels never exceed a third of the width. */
	labelWidth?: number;
	/** The label role; annotation by default so the value reads first. */
	labelRole?: SemanticRole;
	/** `auto` stacks labels above values below `NARROW_WIDTH`; `never` keeps the two columns at any width. */
	stack?: "auto" | "never";
}

/**
 * Label/value pairs as a two-column table. Labels share one column and values
 * wrap under their own first column, so a deep path keeps its file name and a
 * sentence keeps its last word. Below `NARROW_WIDTH`, and for any label wider
 * than the column, the label takes its own row and the value starts flush
 * beneath it, which keeps both whole at the cost of a row rather than an
 * ellipsis.
 */
export function factRows(
	theme: ClioTheme,
	facts: ReadonlyArray<Fact>,
	width: number,
	options: FactRowsOptions = {},
): string[] {
	const safe = Math.max(1, Math.floor(width));
	const labelRole = options.labelRole ?? "annotation";
	const widest = facts.reduce((max, fact) => Math.max(max, visibleWidth(fact.label)), 0);
	const labelWidth = Math.min(widest, options.labelWidth ?? Number.POSITIVE_INFINITY, Math.max(4, Math.floor(safe / 3)));
	const stacked = safe < NARROW_WIDTH && options.stack !== "never";
	const lines: string[] = [];
	for (const fact of facts) {
		const value = fact.value.includes("\u001b") ? fact.value : theme.fg(toneRole(fact.tone ?? "neutral"), fact.value);
		if (stacked) {
			lines.push(clip(theme.fg(labelRole, fact.label), safe));
			lines.push(...(fact.fit === "clip" ? [clip(value, safe)] : wrap(value, safe)));
			continue;
		}
		// A label wider than the column takes its own row above its value, the
		// way every fact does below NARROW_WIDTH, rather than losing its tail.
		if (visibleWidth(fact.label) > labelWidth) {
			lines.push(...wrap(theme.fg(labelRole, fact.label), safe));
			lines.push(...(fact.fit === "clip" ? [clip(value, safe)] : wrap(value, safe)));
			continue;
		}
		const label = padAnsi(theme.fg(labelRole, fact.label), labelWidth);
		const indent = " ".repeat(labelWidth + 2);
		const room = Math.max(1, safe - labelWidth - 2);
		const rows = fact.fit === "clip" ? [clip(value, room)] : wrap(value, room);
		rows.forEach((row, index) => {
			lines.push(`${index === 0 ? `${label}  ` : indent}${row}`);
		});
	}
	return lines;
}

export interface TableColumn {
	label: string;
	align?: "left" | "right";
	/** Narrowest useful width; the column is dropped rather than squeezed below it. */
	min?: number;
	max?: number;
	/** Columns with a lower priority are dropped first. The highest-priority column is never dropped. */
	priority?: number;
	/** This column wraps instead of clipping. At most one column should. */
	wrap?: boolean;
	tone?: Tone;
}

export interface TableCell {
	text: string;
	tone?: Tone;
}

export interface TableSpec {
	columns: ReadonlyArray<TableColumn>;
	rows: ReadonlyArray<ReadonlyArray<string | TableCell>>;
	/** Draw the column labels and a divider above the rows. */
	header?: boolean;
	/** Cells between columns; two by default. */
	gap?: number;
}

function cellOf(cell: string | TableCell | undefined): TableCell {
	if (cell === undefined) return { text: "" };
	return typeof cell === "string" ? { text: cell } : cell;
}

type TableLive = { index: number; column: TableColumn; width: number; natural: number };

/**
 * The columns that survive at `width` and their widths. Natural widths are
 * measured from the content; when they do not fit, the wrapping column gives
 * way down to its minimum, then the lowest-priority columns are dropped whole
 * (never the one holding the top priority alone) and the wrapping column
 * takes back the room a drop frees, then whatever remains is clipped.
 */
function resolveTableLayout(spec: TableSpec, width: number): { live: TableLive[]; dropped: TableColumn[] } {
	const safe = Math.max(1, Math.floor(width));
	const gap = Math.max(1, spec.gap ?? 2);
	let live: TableLive[] = spec.columns.map((column, index) => {
		const natural = Math.max(
			spec.header ? visibleWidth(column.label) : 0,
			...spec.rows.map((row) => visibleWidth(cellOf(row[index]).text)),
			1,
		);
		const bounded = Math.min(natural, column.max ?? Number.POSITIVE_INFINITY);
		return { index, column, width: bounded, natural: bounded };
	});
	const dropped: TableColumn[] = [];
	const total = (): number => live.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, live.length - 1);
	// Drop the lowest-priority column, the rightmost on a tie. The one column
	// holding the top priority alone is never dropped; when every column shares
	// it, the rightmost goes, so the first column is the last one standing.
	const dropLowest = (): boolean => {
		if (live.length <= 1) return false;
		const priority = (item: TableLive): number => item.column.priority ?? 0;
		const top = Math.max(...live.map(priority));
		const below = live.filter((item) => priority(item) < top);
		const candidates = below.length > 0 ? below : live.slice(1);
		const lowest = candidates.reduce((pick, item) => (priority(item) <= priority(pick) ? item : pick));
		live = live.filter((item) => item !== lowest);
		dropped.push(lowest.column);
		return true;
	};
	const shrinkWrapping = (): boolean => {
		const wrapping = live.find((item) => item.column.wrap === true);
		if (wrapping === undefined) return false;
		const floor = Math.max(4, wrapping.column.min ?? 8);
		if (wrapping.width <= floor) return false;
		wrapping.width = Math.max(floor, wrapping.width - (total() - safe));
		return true;
	};
	const regrowWrapping = (): void => {
		const wrapping = live.find((item) => item.column.wrap === true);
		if (wrapping === undefined) return;
		const others = total() - wrapping.width;
		wrapping.width = Math.max(1, Math.min(wrapping.natural, safe - others));
	};
	while (total() > safe && shrinkWrapping()) {}
	while (total() > safe && dropLowest()) regrowWrapping();
	if (total() > safe) {
		// Clip the widest non-wrapping columns first, down to their minimum.
		let excess = total() - safe;
		for (const item of [...live].sort((a, b) => b.width - a.width)) {
			if (excess <= 0) break;
			const floor = Math.max(1, item.column.min ?? 4);
			const give = Math.min(excess, Math.max(0, item.width - floor));
			item.width -= give;
			excess -= give;
		}
		if (excess > 0) {
			const last = live.at(-1);
			if (last !== undefined) last.width = Math.max(1, last.width - excess);
		}
	}
	return { live, dropped };
}

/**
 * Whether every column of `spec` fits `width` whole: none dropped, and no
 * column that does not wrap narrower than its content. A surface that may not
 * lose a column asks this first and lays its rows out another way when the
 * answer is no.
 */
export function tableColumnsFit(spec: TableSpec, width: number): boolean {
	const { live, dropped } = resolveTableLayout(spec, width);
	return dropped.length === 0 && live.every((item) => item.column.wrap === true || item.width >= item.natural);
}

/**
 * Columns that fit the width honestly, laid out by `resolveTableLayout`. A
 * dropped column is gone from every row, so no row is cut differently from
 * its neighbours, a header row names only the columns that survived, and a
 * dim last row names what was dropped, so a column never leaves silently.
 */
export function tableRows(theme: ClioTheme, spec: TableSpec, width: number): string[] {
	const safe = Math.max(1, Math.floor(width));
	const gap = Math.max(1, spec.gap ?? 2);
	const { live, dropped } = resolveTableLayout(spec, safe);
	const total = live.reduce((sum, item) => sum + item.width, 0) + gap * Math.max(0, live.length - 1);
	const paintCell = (text: string, cell: TableCell, column: TableColumn, header: boolean): string => {
		if (text.includes("\u001b")) return text;
		if (header) return theme.style("groupHeading", text, { bold: true });
		return theme.fg(toneRole(cell.tone ?? column.tone ?? "neutral"), text);
	};
	const layoutRow = (cells: ReadonlyArray<string | TableCell>, header: boolean): string[] => {
		const columnsRows = live.map((item) => {
			const cell = cellOf(cells[item.index]);
			// A wrapping cell folds plain text at separators before it is painted,
			// so a model id breaks at a dash rather than wherever the row ends.
			const rows =
				item.column.wrap === true && !header
					? cell.text.includes("\u001b")
						? wrap(cell.text, item.width)
						: foldPlain(cell.text, item.width).map((row) => paintCell(row, cell, item.column, false))
					: [clip(paintCell(cell.text, cell, item.column, header), item.width)];
			return rows.map((row) => {
				const pad = Math.max(0, item.width - visibleWidth(row));
				return item.column.align === "right" ? `${" ".repeat(pad)}${row}` : `${row}${" ".repeat(pad)}`;
			});
		});
		const height = Math.max(1, ...columnsRows.map((rows) => rows.length));
		const lines: string[] = [];
		for (let at = 0; at < height; at += 1) {
			const parts = columnsRows.map((rows, column) => rows[at] ?? " ".repeat(live[column]?.width ?? 0));
			lines.push(parts.join(" ".repeat(gap)).trimEnd());
		}
		return lines;
	};
	const lines: string[] = [];
	if (spec.header) {
		lines.push(
			...layoutRow(
				spec.columns.map((column) => column.label),
				true,
			),
		);
		lines.push(theme.fg("divider", GLYPH.innerDivider.repeat(Math.min(safe, total))));
	}
	for (const row of spec.rows) lines.push(...layoutRow(row, false));
	if (dropped.length > 0) {
		const names = dropped.map((column) => column.label).join(", ");
		lines.push(...wrap(theme.fg("annotation", `${GLYPH.ellipsis} ${names} not shown at this width`), safe));
	}
	return lines;
}

export interface MeterOptions {
	value: number;
	max: number;
	/** Total cells for label, bar and amount together. */
	width: number;
	/** Fill token; the shared meter fill by default. A status tone names a limit being approached. */
	tone?: Tone | "meter";
	/** Text before the bar. */
	label?: string;
	/** Text after the bar; defaults to the rounded percentage. Empty string hides it. */
	amount?: string;
}

/**
 * `label ━━━━━━──── 62%` in exactly `width` cells. The bar is heavier than a
 * frame line so it never reads as a border. The amount is the fact and the bar
 * its picture: when the bar would fall under four cells the bar goes first,
 * then the label, and the amount is the last thing standing.
 */
export function meter(theme: ClioTheme, options: MeterOptions): string {
	const safe = Math.max(1, Math.floor(options.width));
	const ratio = options.max > 0 ? Math.max(0, Math.min(1, options.value / options.max)) : 0;
	let label = options.label === undefined ? "" : options.label;
	const amount = options.amount === undefined ? `${Math.round(ratio * 100)}%` : options.amount;
	const barFor = (): number => safe - (label ? visibleWidth(label) + 1 : 0) - (amount ? visibleWidth(amount) + 1 : 0);
	const left = (): string => (label ? `${theme.fg("fieldName", label)} ` : "");
	if (barFor() < 4) {
		const text = `${left()}${theme.fg("metricValue", amount)}`;
		if (visibleWidth(text) <= safe) return padAnsi(text, safe);
		label = "";
		return padAnsi(clip(theme.fg("metricValue", amount), safe), safe);
	}
	const bar = Math.max(1, barFor());
	const filled = Math.min(bar, Math.max(ratio > 0 ? 1 : 0, Math.round(ratio * bar)));
	const fillRole: SemanticRole =
		options.tone === undefined || options.tone === "meter" ? "meterFill" : toneRole(options.tone);
	const painted =
		theme.fg(fillRole, GLYPH.meterFull.repeat(filled)) + theme.fg("meterFree", GLYPH.meterEmpty.repeat(bar - filled));
	const right = amount ? ` ${theme.fg("metricValue", amount)}` : "";
	return padAnsi(`${left()}${painted}${right}`, safe);
}

export interface SelectionRowOptions {
	focused: boolean;
	/** Left text; plain text takes the menu option role, styled text is placed verbatim. */
	label: string;
	/** Dim right-aligned column; compacts, then drops, before the label is cut. */
	meta?: string;
	/** Rows under the label, indented, in the description role. */
	description?: string;
	/** A mark in the cursor column for an unfocused row (a check, a dot); the cursor wins when focused. */
	mark?: string;
	disabled?: boolean;
	width: number;
}

/**
 * Metadata that was joined with the quiet middot compacts by whole chip, in
 * the order the caller gave, so the first chip (the status, by the row
 * grammar) is the last to go and no chip is ever cut inside a word. A lone
 * chip that does not fit is clipped, which is the one cut the row admits.
 */
function fitMetaChips(theme: ClioTheme, meta: string, width: number): string {
	if (visibleWidth(meta) <= width) return meta;
	const separator = dotSep(theme);
	const chips = meta.split(separator);
	for (let keep = chips.length - 1; keep >= 1; keep -= 1) {
		const row = chips.slice(0, keep).join(separator);
		if (visibleWidth(row) <= width) return row;
	}
	return truncateToWidth(chips[0] ?? meta, width, GLYPH.ellipsis, false);
}

/**
 * The one cursor rule: the focused row carries `❯` in the accent and its label
 * in accent bold, and nothing else changes color. The label keeps at least
 * half the row; metadata compacts into what is left by whole chip or drops out
 * entirely, so a list of rows is never a list of ellipses nobody can identify.
 */
export function selectionRow(theme: ClioTheme, options: SelectionRowOptions): string[] {
	const safe = Math.max(3, Math.floor(options.width));
	const prefix = options.focused
		? theme.fg("selectedOption", `${GLYPH.cursor} `)
		: `${options.mark === undefined ? " " : clip(options.mark, 1)} `;
	const available = safe - 2;
	const rawMeta = options.meta ?? "";
	const reservedLabel = Math.min(visibleWidth(options.label), Math.max(8, Math.floor(available * 0.5)));
	const maxMetaWidth = Math.max(0, available - reservedLabel - 2);
	const metaText = rawMeta.length === 0 || maxMetaWidth === 0 ? "" : fitMetaChips(theme, rawMeta, maxMetaWidth);
	const metaWidth = metaText ? visibleWidth(metaText) : 0;
	const maxLabelWidth = Math.max(1, available - (metaWidth > 0 ? metaWidth + 2 : 0));
	const fittedLabel = truncateToWidth(options.label, maxLabelWidth, GLYPH.ellipsis, false);
	const labelWidth = visibleWidth(fittedLabel);
	const spacing = " ".repeat(Math.max(metaWidth > 0 ? 1 : 0, available - labelWidth - metaWidth));
	const styled = fittedLabel.includes("\u001b");
	const label = styled
		? fittedLabel
		: options.disabled === true
			? theme.fg("disabledOption", fittedLabel)
			: options.focused
				? theme.style("selectedOption", fittedLabel, { bold: true })
				: theme.fg("menuOption", fittedLabel);
	const meta = metaText.length === 0 || metaText.includes("\u001b") ? metaText : theme.fg("annotation", metaText);
	const lines = [padAnsi(`${prefix}${label}${spacing}${meta}`, safe)];
	if (options.description !== undefined && options.description.length > 0) {
		const text = options.description.includes("\u001b")
			? options.description
			: theme.fg("menuDescription", options.description);
		for (const row of wrap(text, Math.max(1, safe - 4))) lines.push(padAnsi(`    ${row}`, safe));
	}
	return lines;
}

export interface Choice {
	key: string;
	verb: string;
	/** What happens when the key is pressed, in one sentence. */
	consequence: string;
	tone?: Tone;
}

/**
 * The keys that answer a decision, each with its consequence, as rows the
 * operator can scan: `[Enter] allow  runs this one execute call`. The verb
 * column is shared so the consequences line up; a consequence wraps under its
 * own column. Below `NARROW_WIDTH` the consequence takes the next row,
 * indented, so no key ever loses its sentence. Every verb carries the same
 * weight: on a safety surface no answer may look more inviting than another.
 */
export function choiceRows(theme: ClioTheme, choices: ReadonlyArray<Choice>, width: number): string[] {
	const safe = Math.max(1, Math.floor(width));
	const keyWidth = choices.reduce((max, choice) => Math.max(max, visibleWidth(choice.key) + 2), 0);
	const verbWidth = choices.reduce((max, choice) => Math.max(max, visibleWidth(choice.verb)), 0);
	const lines: string[] = [];
	const stacked = safe < NARROW_WIDTH;
	for (const choice of choices) {
		const cap = padAnsi(keyCap(theme, choice.key), keyWidth);
		const verb = padAnsi(theme.style(toneRole(choice.tone ?? "neutral"), choice.verb, { bold: true }), verbWidth);
		const lead = `${cap} ${verb}`;
		const consequence = theme.fg("decisionConsequence", choice.consequence);
		if (stacked) {
			lines.push(clip(lead, safe));
			for (const row of wrap(consequence, Math.max(1, safe - 4))) lines.push(`    ${row}`);
			continue;
		}
		const indent = " ".repeat(keyWidth + 1 + verbWidth + 2);
		const room = Math.max(1, safe - indent.length);
		wrap(consequence, room).forEach((row, index) => {
			lines.push(index === 0 ? `${lead}  ${row}` : `${indent}${row}`);
		});
	}
	return lines;
}

export interface CommandBlockOptions {
	/** Gutter token; the attention rail for a decision, the border otherwise. */
	tone?: Tone;
	/** Text role; near-white input text by default so the bytes read first. */
	role?: SemanticRole;
}

/**
 * Lay plain text out in `width` columns: words fill a row, and a word longer
 * than the row folds after the last separator that fits, or by character when
 * it has none. Every character survives, the spaces included: a run of spaces
 * stays between its words on one row, closes the row it fits on, or opens
 * the next row when it does not, because two spaces in an argv are two
 * spaces in the command being approved.
 */
function foldPlain(text: string, width: number): string[] {
	const safe = Math.max(1, Math.floor(width));
	const rows: string[] = [];
	let row = "";
	const push = (): void => {
		rows.push(row);
		row = "";
	};
	// Words and the exact space runs between them, in order.
	const pieces = text.split(/( +)/u).filter((piece) => piece.length > 0);
	for (const piece of pieces) {
		if (/^ +$/u.test(piece)) {
			if (visibleWidth(row) + piece.length <= safe) row += piece;
			else {
				push();
				row = piece.length <= safe ? piece : piece.slice(0, safe);
				for (let rest = piece.slice(row.length); rest.length > 0; rest = rest.slice(safe)) {
					push();
					row = rest.slice(0, safe);
				}
			}
			continue;
		}
		const word = piece;
		const candidate = `${row}${word}`;
		if (visibleWidth(candidate) <= safe) {
			row = candidate;
			continue;
		}
		// The word opens the next row; the spaces that led to it stay on this one.
		if (row.length > 0) push();
		let rest = word;
		while (visibleWidth(rest) > safe) {
			let cut = 0;
			let used = 0;
			let best = 0;
			for (const char of rest) {
				const next = used + visibleWidth(char);
				if (next > safe) break;
				used = next;
				cut += char.length;
				if (FOLD_AFTER.has(char)) best = cut;
			}
			const at = best >= Math.floor(safe / 2) ? best : Math.max(1, cut);
			rows.push(rest.slice(0, at));
			rest = rest.slice(at);
		}
		row = rest;
	}
	if (row.length > 0 || rows.length === 0) push();
	return rows;
}

/**
 * The exact command, path or payload under decision: a gutter bar on every
 * row and the text in the strongest reading color, wrapped at spaces and
 * folded at a separator when a token is longer than the row. Nothing here is
 * ever clipped, because the last token of a path is the one that says what is
 * touched. Text that carries its own styling is wrapped as it is.
 */
export function commandBlock(
	theme: ClioTheme,
	text: string,
	width: number,
	options: CommandBlockOptions = {},
): string[] {
	const safe = Math.max(3, Math.floor(width));
	const gutter = theme.fg(options.tone === undefined ? "border" : toneRole(options.tone), GLYPH.userBar);
	const role = options.role ?? "inputText";
	const rows = text.includes("\u001b")
		? wrap(text, safe - 2)
		: foldPlain(text, safe - 2).map((row) => theme.fg(role, row));
	return rows.map((row) => `${gutter} ${row}`);
}

export interface PositionRowOptions {
	/** First visible row, one-based. */
	start: number;
	/** Last visible row, one-based. */
	end: number;
	total: number;
	/** Noun for the rows; `rows` by default. */
	unit?: string;
	/** Key hints appended after the count, each `key verb`. */
	keys?: ReadonlyArray<string>;
}

/** `3–18 of 42 rows · ↑↓ scroll`, dim, for every windowed body. */
export function positionRow(theme: ClioTheme, options: PositionRowOptions, width: number): string {
	const unit = options.unit ?? "rows";
	const range = options.start === options.end ? `${options.start}` : `${options.start}–${options.end}`;
	const parts = [`${range} of ${options.total} ${unit}`, ...(options.keys ?? [])];
	return clip(theme.fg("annotation", parts.join(" · ")), width);
}

export interface EmptyStateOptions {
	/** What would fill the surface, or the key that does. */
	remedy?: string;
}

/** Nothing here, said once, with the remedy beneath it. */
export function emptyState(
	theme: ClioTheme,
	message: string,
	width: number,
	options: EmptyStateOptions = {},
): string[] {
	const safe = Math.max(1, Math.floor(width));
	const lines = wrap(theme.fg("emptyState", message), safe);
	if (options.remedy !== undefined && options.remedy.length > 0) {
		lines.push(...wrap(theme.fg("annotation", options.remedy), safe));
	}
	return lines;
}

export interface ErrorStateOptions {
	/** The error's own text, wrapped under the headline. */
	detail?: string;
}

/** `✗ headline` in the error tone, then the detail in the reading color. */
export function errorState(
	theme: ClioTheme,
	message: string,
	width: number,
	options: ErrorStateOptions = {},
): string[] {
	const safe = Math.max(1, Math.floor(width));
	const lines = wrap(theme.fg("error", `${GLYPH.error} ${message}`), safe);
	if (options.detail !== undefined && options.detail.length > 0) {
		for (const row of wrap(theme.fg("body", options.detail), Math.max(1, safe - 2))) lines.push(`  ${row}`);
	}
	return lines;
}

export interface ValueRowOptions {
	focused: boolean;
	/** Left text; plain text takes the field name role, styled text is placed verbatim. */
	label: string;
	/** Cells the label column takes, shared by every row of one list. */
	labelWidth: number;
	/** Right text; plain text takes the field value role, styled text is placed verbatim. */
	value: string;
	/** Paint the value as changed from its default and lead it with the changed mark. */
	changed?: boolean;
	/** A mark in the cursor column for an unfocused row (a pin); the cursor wins when focused. */
	mark?: string;
	/** Dim note after the value (where the value came from); the first thing dropped. */
	origin?: string;
	/** `clip` cuts the value's end (the default); `identity` keeps its tail, for a model or target ref. */
	fit?: "clip" | "identity";
	disabled?: boolean;
	width: number;
}

/**
 * The cells a value row gives its label and its value, before the origin is
 * placed, so a caller can tell whether a value will be cut and say it in full
 * somewhere else.
 */
export function valueRowLayout(options: Pick<ValueRowOptions, "labelWidth" | "width">): {
	labelWidth: number;
	valueWidth: number;
} {
	const safe = Math.max(3, Math.floor(options.width));
	const narrow = safe < NARROW_WIDTH;
	const available = safe - 2;
	const labelCeiling = narrow ? Math.max(4, Math.floor(available * 0.4)) : Math.max(4, Math.floor(available * 0.62));
	const labelWidth = Math.max(1, Math.min(Math.floor(options.labelWidth), labelCeiling, available - 4));
	return { labelWidth, valueWidth: Math.max(1, available - labelWidth - 2 - 2) };
}

/**
 * A **value row** is the selection row for a setting: the cursor rule is the
 * same, but the right column is content, not metadata. The label keeps one
 * shared column so values line up down a list, the value takes the rest, and a
 * dim origin follows it when there is room. Below `NARROW_WIDTH` the origin is
 * dropped and the label column gives up to half its cells, so the value, which
 * is what the operator came to read, is the last thing clipped.
 */
export function valueRow(theme: ClioTheme, options: ValueRowOptions): string {
	const safe = Math.max(3, Math.floor(options.width));
	const narrow = safe < NARROW_WIDTH;
	const prefix = options.focused
		? theme.fg("selectedOption", `${GLYPH.cursor} `)
		: `${options.mark === undefined ? " " : clip(options.mark, 1)} `;
	const { labelWidth, valueWidth: room } = valueRowLayout(options);
	const fittedLabel = clip(options.label, labelWidth);
	const label = padAnsi(
		fittedLabel.includes("\u001b")
			? fittedLabel
			: options.focused
				? theme.style("selectedOption", fittedLabel, { bold: true })
				: options.disabled === true
					? theme.fg("disabledOption", fittedLabel)
					: theme.fg("fieldName", fittedLabel),
		labelWidth,
	);
	const mark = options.changed === true ? theme.fg("changedValue", `${GLYPH.scoped} `) : "  ";
	const rawOrigin = narrow ? "" : (options.origin ?? "");
	const valueWidth = visibleWidth(options.value);
	const originWidth = rawOrigin.length === 0 ? 0 : visibleWidth(rawOrigin);
	const keepOrigin = originWidth > 0 && valueWidth + 2 + originWidth <= room;
	const valueRoom = keepOrigin ? room - originWidth - 2 : room;
	const fittedValue =
		options.fit === "identity" && !options.value.includes("\u001b")
			? fitIdentityLabel(options.value, valueRoom)
			: clip(options.value, valueRoom);
	const value = fittedValue.includes("\u001b")
		? fittedValue
		: options.changed === true
			? theme.fg("changedValue", fittedValue)
			: theme.fg(
					"fieldValue",
					fittedValue,
					options.disabled === true ? "readOnly" : options.focused ? "selected" : "normal",
				);
	const origin = keepOrigin
		? `${" ".repeat(Math.max(2, room - visibleWidth(fittedValue) - originWidth))}${rawOrigin.includes("\u001b") ? rawOrigin : theme.fg("annotation", rawOrigin)}`
		: "";
	return padAnsi(`${prefix}${label}  ${mark}${value}${origin}`, safe);
}
