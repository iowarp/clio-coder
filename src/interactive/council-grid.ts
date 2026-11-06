/**
 * How a council reads on the Fleet Runs board.
 *
 * A council is one question asked of several members at once, so its runs are
 * one thing on the screen rather than three to five unrelated cards. Members
 * sit side by side while every column keeps enough width to read an answer in,
 * and stack one under another when they do not. The synthesis run is the whole
 * council's answer, so it takes the full width under the members rather than a
 * column of its own.
 *
 * Pure presentation: the caller projects board rows into these views, and this
 * module owns only layout, color, and text. It knows nothing about the board
 * store, the bus, or run status semantics.
 */

import { truncateToWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ClioTheme, ClioToken } from "./theme/index.js";
import { dotSep, GLYPH, innerDivider, isClioToken, padAnsi, paintHex } from "./theme/index.js";

/**
 * The narrowest column an answer is still worth reading in. Below it the grid
 * becomes a set of one-word columns, so the group stacks instead: a member's
 * answer is the reason the operator opened the board.
 */
const COUNCIL_COLUMN_MIN_WIDTH = 34;

/** Blank columns between two side-by-side member columns. */
const COUNCIL_COLUMN_GUTTER = 2;

/** Rows of a member's bounded answer tail a column shows before it defers to `/view`. */
const COUNCIL_ANSWER_ROWS = 4;

/** One council run as the board draws it: the roster facts plus the run's presentation. */
export interface CouncilMemberView {
	runId: string;
	label: string;
	/** Roster color: a theme token name or a `#rrggbb` value. Absent members take the accent. */
	color?: string;
	round: number;
	/** Route as the card names it, such as `local/example-model`. */
	route: string;
	status: { glyph: string; label: string; token: ClioToken; glyphToken?: ClioToken };
	/** Bounded answer tail the board already keeps for this run. */
	tailText: string;
	droppedLines: number;
	/** The run has ended, so a missing tail means its answer is only in its record. */
	settled?: boolean;
	/** Why a member that failed gave no answer, in the words its run row uses. */
	why?: string;
}

export interface CouncilGroupView {
	group: string;
	/** Final-round member runs, in roster order. */
	members: ReadonlyArray<CouncilMemberView>;
	/** The council's own answer, or null while the members are still running or when none was asked for. */
	synthesis: CouncilMemberView | null;
	/**
	 * Set when the council only collected its members' answers: there is no answer of its own to show, so the body
	 * says that in a line instead of drawing the collector as a member that answered.
	 */
	collectedNote?: string;
	/** Aggregate status of the group, used by the compact card. */
	status: { glyph: string; label: string; token: ClioToken; glyphToken?: ClioToken };
	/** The question every member was asked, as the board's rows word a task. */
	task?: string;
	/** Highest round any member has reached. */
	round: number;
	/** Elapsed time of the longest-running member, formatted by the caller. */
	elapsed: string;
	/** Run id of the selected row when the selection sits inside this group. */
	selectedRunId?: string;
	/** Every run in the group was recorded by an earlier Clio process. */
	earlier?: true;
}

export type CouncilLayout = { mode: "grid"; columnWidth: number } | { mode: "stack"; columnWidth: number };

/**
 * Grid or stack for this many members at this content width. Columns divide the
 * width evenly after the gutters are taken out, and the whole group stacks the
 * moment one column would fall under {@link COUNCIL_COLUMN_MIN_WIDTH}: a grid
 * where only some columns are readable is worse than no grid at all.
 */
function councilGridLayout(memberCount: number, contentWidth: number): CouncilLayout {
	const count = Math.max(1, memberCount);
	const usable = contentWidth - COUNCIL_COLUMN_GUTTER * (count - 1);
	const columnWidth = Math.floor(usable / count);
	if (count > 1 && columnWidth >= COUNCIL_COLUMN_MIN_WIDTH) return { mode: "grid", columnWidth };
	return { mode: "stack", columnWidth: Math.max(1, contentWidth) };
}

/**
 * A member's label in its roster color. A theme token name is painted as that
 * token; a `#rrggbb` value is painted literally; anything else, including a
 * member with no color at all, takes the accent, which is what the board paints
 * the operator's own work in.
 */
export function councilLabelText(theme: ClioTheme, label: string, color?: string): string {
	if (color !== undefined && isClioToken(color)) return theme.style(color, label, { bold: true });
	if (color !== undefined) {
		const painted = paintHex(label, color);
		if (painted !== label) return painted;
	}
	return theme.fg("workerIdentity", label);
}

/** The answer tail on a rail, wrapped to the column and bounded to {@link COUNCIL_ANSWER_ROWS} rows. */
function answerRows(theme: ClioTheme, member: CouncilMemberView, width: number, maxRows: number): string[] {
	if (member.tailText.trim().length === 0) return [];
	const railWidth = Math.max(1, width - 2);
	const wrapped: string[] = [];
	for (const line of member.tailText.split("\n")) {
		for (const row of wrapTextWithAnsi(line, railWidth)) wrapped.push(row);
	}
	const rail = theme.fg("gutter", `${GLYPH.rail} `);
	const note = (text: string): string =>
		`${rail}${theme.fg("annotation", truncateToWidth(text, railWidth, "…", false))}`;
	// A settled answer reads from its start, so its first claim is never the part cut; a live one shows its newest
	// rows, the ones still moving, under a note that says how much came before them.
	if (member.settled === true) {
		const shown = wrapped.slice(0, maxRows);
		const hidden = wrapped.length - shown.length;
		return [
			...(member.droppedLines > 0 ? [note(`${GLYPH.ellipsis} ${member.droppedLines} earlier`)] : []),
			...shown.map((row) => `${rail}${theme.fg("assistantProse", row)}`),
			...(hidden > 0 ? [note(`${GLYPH.ellipsis} ${hidden} more in /view dispatch:${member.runId}`)] : []),
		];
	}
	const shown = wrapped.slice(Math.max(0, wrapped.length - maxRows));
	const earlier = wrapped.length - shown.length + member.droppedLines;
	return [
		...(earlier > 0 ? [note(`${GLYPH.ellipsis} ${earlier} earlier`)] : []),
		...shown.map((row) => `${rail}${theme.fg("assistantProse", row)}`),
	];
}

/**
 * One member column: the label, the route, the round and status, then the
 * answer. Every line is clipped to the column so a long model id or a long
 * answer line can never push a neighbouring column out of position.
 */
function councilMemberLines(
	theme: ClioTheme,
	member: CouncilMemberView,
	width: number,
	options: { selected?: boolean; maxAnswerRows?: number; showRound?: boolean } = {},
): string[] {
	const dot = dotSep(theme);
	const cursor = options.selected === true ? `${theme.fg("selectedOption", GLYPH.cursor)} ` : "";
	const status = `${theme.fg(member.status.glyphToken ?? member.status.token, member.status.glyph)} ${theme.fg(member.status.token, member.status.label)}`;
	const head = `${cursor}${councilLabelText(theme, member.label, member.color)}`;
	const lines = [
		truncateToWidth(head, width, "…", false),
		truncateToWidth(theme.fg("footerIdentity", member.route), width, "…", false),
		truncateToWidth(
			options.showRound === true ? `${status}${dot}${theme.fg("annotation", `round ${member.round}`)}` : status,
			width,
			"…",
			false,
		),
		...answerRows(theme, member, width, options.maxAnswerRows ?? COUNCIL_ANSWER_ROWS),
	];
	// A member this process did not watch has no tail here; its answer is in its record, so the column says where.
	if (member.settled === true && member.tailText.trim().length === 0) {
		// A member that failed has no answer anywhere; its record says why, which is what the pointer offers instead.
		const failed = member.status.token === "error";
		// A known cause is the answer to "why"; the record is still one key away on the run's own row.
		if (failed && member.why !== undefined && member.why.length > 0) {
			for (const row of wrapTextWithAnsi(`no answer: ${member.why}`, width).slice(0, 3)) {
				lines.push(theme.fg("annotation", row));
			}
			return lines.map((line) => padAnsi(line, width));
		}
		lines.push(
			truncateToWidth(
				theme.fg("annotation", `${failed ? "no answer · why in" : "answer in"} /view dispatch:${member.runId}`),
				width,
				"…",
				false,
			),
		);
	}
	return lines.map((line) => padAnsi(line, width));
}

/** Zip member columns into rows, padding short columns so the grid keeps its shape. */
function zipColumns(columns: ReadonlyArray<ReadonlyArray<string>>, columnWidth: number): string[] {
	const height = columns.reduce((tallest, column) => Math.max(tallest, column.length), 0);
	const gutter = " ".repeat(COUNCIL_COLUMN_GUTTER);
	const rows: string[] = [];
	for (let index = 0; index < height; index += 1) {
		rows.push(columns.map((column) => column[index] ?? " ".repeat(columnWidth)).join(gutter));
	}
	return rows;
}

/**
 * The council group's body: the member grid or stack, then the synthesis run
 * full width under it. The caller frames the result.
 */
export function councilGroupBody(theme: ClioTheme, group: CouncilGroupView, contentWidth: number): string[] {
	const layout = councilGridLayout(group.members.length, contentWidth);
	const body: string[] = [];
	if (layout.mode === "grid") {
		const columns = group.members.map((member) =>
			councilMemberLines(theme, member, layout.columnWidth, {
				selected: member.runId === group.selectedRunId,
				showRound: group.round > 1,
			}),
		);
		body.push(...zipColumns(columns, layout.columnWidth));
	} else {
		for (const member of group.members) {
			if (body.length > 0) body.push(innerDivider(theme, contentWidth));
			body.push(
				...councilMemberLines(theme, member, layout.columnWidth, {
					selected: member.runId === group.selectedRunId,
					showRound: group.round > 1,
				}),
			);
		}
	}
	if (group.collectedNote !== undefined) {
		body.push(innerDivider(theme, contentWidth));
		body.push(truncateToWidth(theme.fg("annotation", group.collectedNote), contentWidth, GLYPH.ellipsis, false));
	}
	if (group.synthesis !== null) {
		body.push(innerDivider(theme, contentWidth));
		body.push(
			...councilMemberLines(theme, group.synthesis, contentWidth, {
				selected: group.synthesis.runId === group.selectedRunId,
				maxAnswerRows: COUNCIL_ANSWER_ROWS + 2,
				showRound: group.round > 1,
			}),
		);
	}
	return body;
}

/**
 * The compact Fleet Runs island card for a council: the council by its size and state, the question, then each
 * member by label with its own state, so the dock says who is still answering without opening the board. The grid
 * belongs to the expanded board, where there is width to read it in.
 */
export function councilIslandLines(theme: ClioTheme, group: CouncilGroupView, width: number): string[] {
	const dot = dotSep(theme);
	const glyph = theme.fg(group.status.glyphToken ?? group.status.token, group.status.glyph);
	const status = theme.fg(group.status.token, group.status.label);
	// The group id is the record's; a person knows the council by its size and its question.
	const name = group.members.length === 0 ? "council" : `council of ${group.members.length}`;
	const head = `${glyph} ${theme.fg("workerIdentity", name)}${dot}${status}${dot}${theme.fg("toolMetadata", group.elapsed)}`;
	const seat = (member: CouncilMemberView): string =>
		`${councilLabelText(theme, member.label, member.color)} ${theme.fg(member.status.glyphToken ?? member.status.token, member.status.glyph)}`;
	const seats = [
		...group.members.map(seat),
		...(group.synthesis !== null ? [seat(group.synthesis)] : []),
		...(group.round > 1 ? [theme.fg("annotation", `round ${group.round}`)] : []),
	].join(dot);
	const lines = [
		truncateToWidth(head, width, GLYPH.ellipsis, false),
		...(group.task !== undefined
			? [truncateToWidth(`  ${theme.fg("body", group.task)}`, width, GLYPH.ellipsis, false)]
			: []),
		truncateToWidth(`  ${seats}`, width, GLYPH.ellipsis, false),
		truncateToWidth(theme.fg("annotation", "  /fleet to read each answer"), width, GLYPH.ellipsis, false),
	];
	return lines.map((line) => padAnsi(line, width));
}
