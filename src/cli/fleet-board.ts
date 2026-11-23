/**
 * The workers dock pane: the process the workers dock (Alt+W) runs, `clio-coder fleet view --watch`.
 *
 * It opens on one list of this session's runs, worst first (`runSortRank`). Each card is the shared run row
 * (src/core/run-row.ts) and, where the tier grants them, a second row with the reason, the live phase or the task,
 * and a third with telemetry. Every card has the tier's `paneCardRows` physical rows, selected or not, so the list
 * never changes shape under the cursor. Enter opens run detail: a pinned identity row, then one scroll region with
 * the fact block and the answer, or the live stream while the run works. `[t]` unfolds the whole task without moving
 * the answer. Esc returns to the list at the same card.
 *
 * Everything comes from durable state (src/cli/fleet-board-model.ts), so the pane is a read-only viewer that also
 * works over SSH and never runs a second Clio on top of a worker. Clio talks to it through two small files: the watch
 * selection file asks for a detail (`/panes show`, the panes tool, Enter in the Fleet Runs board) and carries the
 * presentation tier on its `outputDetail=` line, and the dock tap file carries keys pressed here back to Clio: `q`
 * hides the dock and hands the keyboard back, and Alt+W is the same tap Clio's own workers key makes.
 *
 * The tier is made current here with `setPresentationTier` and every budget is read from `tierPolicy()`. Glyphs come
 * from the shared table and color from `sgrFor`, so ASCII mode, NO_COLOR and 16-color terminals read as the TUI does;
 * only task, answer and call text is printed as the worker wrote it.
 */

import { appendFileSync } from "node:fs";
import { formatElapsed } from "../core/format-time.js";
import { GLYPH } from "../core/glyphs.js";
import { setPresentationTier, type TierPolicy, tierPolicy } from "../core/presentation-tier.js";
import {
	compareRuns,
	type RunCell,
	type RunFacts,
	type RunOutcome,
	type RunRowLayout,
	type RunRowOptions,
	type RunState,
	runCountBuckets,
	runCountRow,
	runIdentityWidth,
	runRow,
} from "../core/run-row.js";
import { renderCalls } from "../core/telemetry/render.js";
import { terminalBackground } from "../core/terminal-background.js";
import { type ColorDepth, colorDepth } from "../core/terminal-preferences.js";
import { isChromeRole, resolveRole, roleIntensity, type SemanticRole } from "../core/theme-roles.js";
import { sgrFor } from "../core/theme-sgr.js";
import { plainOutcomeLabel } from "../domains/dispatch/failure-headline.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui-primitives.js";
import {
	type BoardModel,
	type BoardSource,
	createBoardSource,
	isLive,
	loadBoard,
	loadTakeover,
	readWatchRequest,
	type StreamRow,
	successorRun,
	type TakeoverModel,
	type WatchRequest,
	type WorkerCard,
} from "./fleet-board-model.js";
import type { fleetInspectionScope } from "./fleet-project-scope.js";

/** Poll cadence, matching the monitor tool and the feed's coalescing window. */
const POLL_MS = 250;
/** The cursor column: `❯ ` on the selected card, two blank cells on the others. */
const CURSOR_CELLS = 2;
/** Under this many pane columns a card's elapsed cell drops; state, identity and the state word stay. */
const ELAPSED_FLOOR = 32;
/** The widest identity column: origin, helper mark and 16 cells of agent name. */
const IDENTITY_MAX = 20;
/** Where a card's second and third rows hang. */
const SUB_INDENT = "    ";
/** Under this many cells the detail stacks each label above its value (width class W1). */
const SIDE_BY_SIDE_CELLS = 44;

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/**
 * Semantic roles painted from the same palette the TUI uses, through core rather than the interactive theme, which
 * this process must not load. Every span closes exactly what it opened.
 */
export interface BoardPaint {
	fg(role: SemanticRole, text: string, bold?: boolean): string;
	dim(text: string): string;
}

/** Things the operator must act on or read as a state keep their intensity without color. */
const NEVER_DIM = new Set<SemanticRole>([
	"keyboardHint",
	"decisionConsequence",
	"commandHint",
	"success",
	"warning",
	"error",
	"validationError",
]);

function dimsWithoutColor(role: SemanticRole): boolean {
	if (NEVER_DIM.has(role)) return false;
	if (isChromeRole(role)) return true;
	const intensity = roleIntensity(role);
	return intensity === "subdued" || intensity === "supporting";
}

function createBoardPaint(depth: ColorDepth = colorDepth()): BoardPaint {
	const background = terminalBackground();
	const spans = new Map<string, { open: string; close: string }>();
	const span = (role: SemanticRole, bold: boolean): { open: string; close: string } => {
		const key = `${role}:${bold}`;
		let found = spans.get(key);
		if (found === undefined) {
			const resolved = resolveRole(role);
			const strong = bold || resolved.bold === true;
			const dim = depth === "none" && !strong && dimsWithoutColor(role);
			const color = sgrFor({ fg: resolved.color }, depth, background);
			const intensityClose = (strong || dim) && !color.close.split(";").includes("22") ? "22" : "";
			found = {
				open: [strong ? "1" : "", dim ? "2" : "", color.open].filter((part) => part.length > 0).join(";"),
				close: [color.close, intensityClose].filter((part) => part.length > 0).join(";"),
			};
			spans.set(key, found);
		}
		return found;
	};
	return {
		fg(role, text, bold = false): string {
			if (text.length === 0) return text;
			const { open, close } = span(role, bold);
			return open.length === 0 ? text : `\u001b[${open}m${text}\u001b[${close}m`;
		},
		dim(text): string {
			return text.length > 0 ? `\u001b[2m${text}\u001b[22m` : text;
		},
	};
}

/** Worker-adjacent text crosses a trust boundary: one line, no control bytes, no secrets. */
function clean(text: string): string {
	return sanitizeCallTargetText(redactSecretString(text));
}

/** Fit `text` to `width` cells, ending a cut with `…`. Text that carried no escape comes back without one. */
function cut(text: string, width: number): string {
	if (width <= 0) return "";
	const fitted = truncateToWidth(text, width, GLYPH.ellipsis, false);
	return text.includes("\u001b") ? fitted : fitted.replaceAll("\u001b[0m", "");
}

/** The fact separator, padded. */
function sep(paint: BoardPaint): string {
	return paint.fg("separator", ` ${GLYPH.sep} `);
}

/** Run row cells as text: each cell's lead unpainted, then its glyph and text in its role. */
function paintCells(paint: BoardPaint, cells: readonly RunCell[], bold?: (cell: RunCell) => boolean): string {
	return cells
		.map(
			(cell) =>
				`${cell.lead}${paint.fg(cell.role, `${cell.glyph === undefined ? "" : GLYPH[cell.glyph]}${cell.text}`, bold?.(cell) ?? false)}`,
		)
		.join("");
}

/** A bracketed key cap and its word: `[Enter] open`. */
function keyUnit(paint: BoardPaint, key: string, word: string): string {
	return `${paint.fg("keyboardHint", `[${key}]`)} ${paint.fg("annotation", word)}`;
}

/**
 * The key row, fitted as SPEC 2.5 fits a rail: words drop before keys. Every unit whole; then the words go from the
 * left, where the guessable navigation keys sit, keeping the last unit's word (the way out); then whole units go from
 * the left, so `[q] hide` and `[Esc] back` are the last thing standing.
 */
function keyRow(paint: BoardPaint, keys: ReadonlyArray<readonly [string, string]>, width: number): string {
	const units = (bare: number, from: number): string[] =>
		keys
			.slice(from)
			.map(([key, word], index) =>
				from + index < bare ? paint.fg("keyboardHint", `[${key}]`) : keyUnit(paint, key, word),
			);
	const row = (shown: readonly string[]): string => ` ${shown.join(sep(paint))}`;
	const last = Math.max(0, keys.length - 1);
	for (let bare = 0; bare <= last; bare += 1) {
		const fitted = row(units(bare, 0));
		if (visibleWidth(fitted) <= width) return fitted;
	}
	for (let from = 1; from < last; from += 1) {
		const fitted = row(units(last, from));
		if (visibleWidth(fitted) <= width) return fitted;
	}
	return cut(row(units(last, last)), width);
}

const UP_DOWN = `${GLYPH.up}${GLYPH.down}`;

// ---------------------------------------------------------------------------
// Run facts
// ---------------------------------------------------------------------------

/** The descriptor vocabulary's progressive verbs in the past tense; the TUI's worker card uses the same table. */
const FINISHED_VERBS: Readonly<Record<string, string>> = {
	reading: "read",
	editing: "edited",
	writing: "wrote",
	listing: "listed",
	running: "ran",
	searching: "searched",
	finding: "found",
	fetching: "fetched",
	verifying: "checked",
	navigating: "navigated",
	inspecting: "inspected",
	monitoring: "monitored",
	steering: "steered",
	dispatching: "dispatched",
	deleting: "deleted",
	moving: "moved",
	thinking: "thought",
	calling: "called",
};

/** A call as `verb object`, present tense while it runs and past once it finished. */
function callText(row: StreamRow): string {
	const verb =
		row.verb === undefined ? (row.tool ?? "tool") : row.pending ? row.verb : (FINISHED_VERBS[row.verb] ?? row.verb);
	const object = clean(row.text);
	return object.length > 0 ? `${clean(verb)} ${object}` : clean(verb);
}

/** What a live run is doing now, in the phase words the run row leads with. */
function phaseText(card: WorkerCard): string {
	if (card.state === "stale") return "stale: no heartbeat";
	if (card.state === "queued") return "waiting for a slot";
	if (card.current !== null) return callText(card.current);
	switch (card.phase) {
		case "thinking":
			return "thinking";
		case "writing":
			return "writing";
		case "tool":
			return "calling a tool";
		case "waiting":
			return "waiting on the model";
		case "verification-queued":
			return "waiting for a verification slot";
		case "verifying":
			return "running host checks";
		case "settled":
			return "sealing the run record";
		default:
			return "starting";
	}
}

function cardOutcome(card: WorkerCard): RunOutcome {
	switch (card.state) {
		case "queued":
			return "queued";
		case "running":
		case "stale":
			return "running";
		case "succeeded":
			return "succeeded";
		case "canceled":
			return "cancelled";
		default:
			return "failed";
	}
}

/** Why a finished run counts against it: the failure, a broken seal, a failed contract or check. */
function failureReason(card: WorkerCard): string | undefined {
	const record = card.record;
	if (record === null) return card.ledgerDetail === undefined ? undefined : clean(card.ledgerDetail);
	if (record.outcome === "succeeded") {
		if (record.integrity === "compromised") return clean(record.seal ?? "seal broken");
		if (record.contract === "fail") return "contract failed";
		if (record.validationState === "failed") return clean(record.validation ?? "validation failed");
		return undefined;
	}
	const first = (record.failure?.split("\n", 1)[0] ?? "").trim();
	return clean(first.length > 0 ? first : plainOutcomeLabel(record.outcomeCode ?? record.outcome));
}

/** The run's tokens as a count on a shared row, with the shared estimate or lower-bound mark. */
function tokensText(card: WorkerCard): string | undefined {
	const match = /^([~≈≥]?)(\d[\d.,]*[kMG]?)/u.exec(card.tokens ?? "");
	if (match === null) return undefined;
	const mark = match[1] === "≥" ? GLYPH.atLeast : match[1] === "" ? "" : GLYPH.estimate;
	return `${mark}${match[2]} tok`;
}

function approvalWords(asking: StreamRow): string {
	const what = clean([asking.tool, asking.text].filter((part) => part !== undefined && part.length > 0).join(" "));
	return what.length > 0 ? `waiting for you ${GLYPH.sep} ${what}` : "waiting for you";
}

/** A card's facts for the run row model. */
function runFacts(card: WorkerCard): RunFacts {
	const outcome = cardOutcome(card);
	const record = card.record;
	const reason = outcome === "succeeded" || outcome === "failed" ? failureReason(card) : undefined;
	const asking = card.asking;
	const tokens = tokensText(card);
	return {
		agent: clean(card.agentId),
		origin: card.origin,
		...(card.helper ? { helper: true } : {}),
		outcome,
		...(record !== null
			? { validation: record.contract === "fail" ? "failed" : record.validationState, integrity: record.integrity }
			: {}),
		...(isLive(card.state) ? { phase: phaseText(card) } : {}),
		task: clean(card.task),
		...(reason !== undefined ? { reason } : {}),
		...(asking !== null && outcome === "running"
			? { approval: { decider: "operator" as const, words: (room: number) => cut(approvalWords(asking), room) } }
			: {}),
		...(card.elapsedMs !== undefined ? { elapsed: formatElapsed(card.elapsedMs) } : {}),
		startedAt: card.startedAtMs,
		runId: card.runId,
		telemetry: {
			route: clean(card.target),
			calls: card.toolCalls,
			...(tokens !== undefined ? { tokens } : {}),
		},
	};
}

/** A stale run is live but has stopped reporting: a warning by glyph and word, wherever its row prints. */
function withStale(card: WorkerCard, cells: RunCell[]): RunCell[] {
	if (card.state !== "stale") return cells;
	return cells.map((cell) => (cell.slot === "state" ? { ...cell, glyph: "warn", role: "warning" } : cell));
}

function stateWord(card: WorkerCard, state: RunState): string {
	return card.state === "stale" ? "stale" : state.word;
}

/** The same run with its text cell reduced to the state word, for the first row of a taller card. */
function wordOnly(facts: RunFacts, state: RunState, word: string): RunFacts {
	const { phase: _phase, task: _task, reason: _reason, approval, ...rest } = facts;
	return {
		...rest,
		// A warning row already leads with its trust word.
		task: state.kind === "warning" ? "" : word,
		...(approval !== undefined ? { approval: { ...approval, words: () => word } } : {}),
	};
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/** The identity column a list gives its agents, never more than half the row. */
function identityColumn(facts: readonly RunFacts[], width: number): number {
	return Math.min(IDENTITY_MAX, Math.floor((width - CURSOR_CELLS) / 2), runIdentityWidth(facts, visibleWidth));
}

/** A card's second row: the reason of a failure, the phase then the task of a live run, the task of a finished one. */
function secondRow(paint: BoardPaint, facts: RunFacts, state: RunState, width: number): string {
	const room = width - SUB_INDENT.length;
	let text: string;
	if (state.kind === "error") text = paint.fg("error", facts.reason ?? state.word);
	else {
		const parts: string[] = [];
		if (facts.approval !== undefined && state.kind === "pending")
			parts.push(paint.fg("attention", facts.approval.words(room)));
		else if (facts.phase !== undefined) parts.push(paint.fg("activity", facts.phase));
		if ((facts.task ?? "").length > 0) parts.push(paint.fg("body", facts.task ?? ""));
		text = parts.join(sep(paint));
	}
	return `${SUB_INDENT}${cut(text, room)}`;
}

/** The words a card's first row keeps whole: the state word of a taller card, else the trust or wait words. */
function keptWord(rows: number, state: RunState, word: string): string | null {
	if (rows > 1) return word;
	if (state.kind === "warning") return state.word;
	return state.kind === "pending" ? "waiting for you" : null;
}

/**
 * The run row with `word` whole: the elapsed cell leaves first, then the identity column narrows, before a state word
 * is cut (2.7). The row is returned as laid out when the word cannot fit at all.
 */
function wholeWordRow(facts: RunFacts, options: RunRowOptions, word: string | null): RunRowLayout {
	const fits = (layout: RunRowLayout): boolean =>
		word === null ||
		layout.cells.some(
			(cell) => (cell.slot === "task" || cell.slot === "trust" || cell.slot === "approval") && cell.text.startsWith(word),
		);
	const first = runRow(facts, options);
	if (fits(first)) return first;
	const noElapsed = { ...options, elapsedFloor: Number.POSITIVE_INFINITY };
	for (let identity = options.identityWidth; identity > 0; identity -= 1) {
		const layout = runRow(facts, { ...noElapsed, identityWidth: identity });
		if (fits(layout)) return layout;
	}
	return first;
}

/**
 * One card: exactly the tier's `paneCardRows` rows. A one-row card is the whole run row, so a failure's reason starts
 * on it; a taller card puts the state word on row one, the reason, phase or task on row two, telemetry on row three.
 */
export function renderCard(
	paint: BoardPaint,
	card: WorkerCard,
	width: number,
	options: { selected: boolean; identityWidth: number },
): string[] {
	const rows = Math.max(1, tierPolicy().paneCardRows);
	const facts = runFacts(card);
	const layoutOptions = {
		width: Math.max(1, width - CURSOR_CELLS),
		identityWidth: options.identityWidth,
		measure: visibleWidth,
		elapsedFloor: ELAPSED_FLOOR - CURSOR_CELLS,
		rail: false,
	};
	const full = runRow(facts, layoutOptions);
	const word = stateWord(card, full.state);
	const headFacts = rows === 1 ? facts : wordOnly(facts, full.state, word);
	const head = wholeWordRow(headFacts, layoutOptions, keptWord(rows, full.state, word));
	const cells = withStale(
		card,
		head.cells.map((cell) => (rows > 1 && cell.slot === "task" ? { ...cell, role: full.state.role } : cell)),
	);
	const cursor = options.selected ? `${paint.fg("selectedOption", GLYPH.cursor, true)} ` : "  ";
	const lines = [
		`${cursor}${paintCells(paint, cells, (cell) => options.selected && cell.slot === "agent")}`,
		secondRow(paint, facts, full.state, width),
		full.telemetry === null ? "" : paintCells(paint, full.telemetry),
	];
	return lines.slice(0, rows).map((line) => cut(line, width));
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface BoardView {
	selectedRunId: string | null;
	/** First card on screen, kept across frames and tiers so the list does not jump. */
	top: number;
}

/** The board's runs in one list, worst first, oldest first inside a state. */
function orderedCards(board: BoardModel): WorkerCard[] {
	return [...board.running, ...board.finished]
		.map((card) => ({ card, facts: runFacts(card) }))
		.sort((a, b) => compareRuns(a.facts, b.facts))
		.map((entry) => entry.card);
}

/**
 * The header: counts worst first, cut from the right. The `workers` title shows only when it costs no count and no
 * word, so a narrow pane keeps a failure, a wait and a live run before its own name.
 */
function boardHeader(paint: BoardPaint, facts: readonly RunFacts[], width: number): string {
	const title = paint.fg("heading", "workers", true);
	if (facts.length === 0) return cut(` ${title}`, width);
	const buckets = runCountBuckets(facts);
	const plain = runCountRow(buckets, width - 1);
	const titled = runCountRow(buckets, width - 1 - "workers ".length);
	const same = titled.length === plain.length && titled.every((cell, index) => cell.text === plain[index]?.text);
	return cut(same ? ` ${title} ${paintCells(paint, titled)}` : ` ${paintCells(paint, plain)}`, width);
}

const EMPTY_BOARD = [
	"No runs in this session yet.",
	"",
	"Dispatch one from CLIO Coder:",
	"  /run <agent> <task>    one worker on a task",
	"  /fleet run <playbook>  a playbook",
	"  or ask CLIO Coder to delegate the work.",
	"",
	"Runs appear here as workers start.",
];

/** The whole board screen, exactly `height` rows (fewer only when the terminal is tiny). */
export function renderBoard(
	paint: BoardPaint,
	cards: readonly WorkerCard[],
	view: BoardView,
	width: number,
	height: number,
): string[] {
	const columns = Math.max(1, width);
	const rule = paint.fg("divider", GLYPH.rule.repeat(columns));
	const facts = cards.map(runFacts);
	const header = [boardHeader(paint, facts, columns), rule];
	const footer = [
		rule,
		keyRow(
			paint,
			[
				[UP_DOWN, "select"],
				["Enter", "open"],
				["q", "hide"],
			],
			columns,
		),
	];
	const bodyHeight = Math.max(1, height - header.length - footer.length);
	if (cards.length === 0) {
		const body = EMPTY_BOARD.map((line) =>
			cut(` ${paint.fg(line.startsWith("  ") ? "commandHint" : "emptyState", line)}`, columns),
		);
		while (body.length < bodyHeight) body.push("");
		return [...header, ...body.slice(0, bodyHeight), ...footer];
	}
	const cardRows = Math.max(1, tierPolicy().paneCardRows);
	const scrolls = cards.length * cardRows > bodyHeight;
	const pageCards = Math.max(1, Math.floor((bodyHeight - (scrolls ? 1 : 0)) / cardRows));
	const selected = Math.max(
		0,
		cards.findIndex((card) => card.runId === view.selectedRunId),
	);
	let top = Math.min(view.top, Math.max(0, cards.length - pageCards));
	if (selected < top) top = selected;
	if (selected >= top + pageCards) top = selected - pageCards + 1;
	top = Math.max(0, top);
	view.top = top;
	const identityWidth = identityColumn(facts, columns);
	const body: string[] = [];
	cards.slice(top, top + pageCards).forEach((card, offset) => {
		body.push(...renderCard(paint, card, columns, { selected: top + offset === selected, identityWidth }));
	});
	if (scrolls) {
		const last = Math.min(cards.length, top + pageCards);
		body.push(cut(` ${paint.fg("scrollMarker", `${top + 1}-${last} of ${cards.length} runs`)}`, columns));
	}
	while (body.length < bodyHeight) body.push("");
	return [...header, ...body.slice(0, bodyHeight), ...footer];
}

// ---------------------------------------------------------------------------
// Run detail
// ---------------------------------------------------------------------------

export interface TakeoverView {
	runId: string;
	/** First body row on screen, or null to follow the newest row of a live run. */
	scrollTop: number | null;
	/** Move to the run that carries this one's work on once it finishes. */
	followSuccessor: boolean;
	/** `[t]`: the whole task, at any tier. */
	taskExpanded: boolean;
	/** Where the answer or stream began on the last frame, so a change above it does not move it; -1 before one. */
	answerStart: number;
	/** Written by each render: body rows, the rows the window shows them in, and whether the run is live. */
	streamLength: number;
	bodyHeight: number;
	live: boolean;
}

function newTakeoverView(runId: string, live: boolean, followSuccessor: boolean): TakeoverView {
	return {
		runId,
		scrollTop: live ? null : 0,
		followSuccessor,
		taskExpanded: false,
		answerStart: -1,
		streamLength: 0,
		bodyHeight: 1,
		live,
	};
}

/** Rows of the task the detail shows before `[t]`: none at one-row cards, two at two, the whole task at three. */
function detailTaskRows(policy: TierPolicy): number {
	return policy.paneCardRows >= 3 ? Number.POSITIVE_INFINITY : (policy.paneCardRows - 1) * 2;
}

/** `+m:ss` from the run's start, the stream's time column. */
function formatOffset(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `+${minutes}:${String(seconds % 60).padStart(2, "0")}`;
	return `+${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

function wrapPrefixed(prefix: string, text: string, width: number, indent: number): string[] {
	const room = Math.max(1, width - indent);
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		const wrapped = paragraph.trim().length === 0 ? [""] : wrapTextWithAnsi(paragraph, room);
		for (const line of wrapped) lines.push(line);
	}
	while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines.map((line, index) => `${index === 0 ? prefix : " ".repeat(indent)}${line}`);
}

function outcomeMark(paint: BoardPaint, row: StreamRow): string {
	const took = row.durationMs === undefined ? "" : ` ${formatElapsed(row.durationMs)}`;
	if (row.pending) return paint.fg("activity", ` ${GLYPH.ellipsis}`);
	if (row.outcome === "error") return paint.fg("error", ` ${GLYPH.error} failed${took}`);
	if (row.outcome === "blocked") return paint.fg("warning", ` ${GLYPH.cancelled} blocked${took}`);
	if (row.outcome === "ok") return `${paint.fg("success", ` ${GLYPH.ok}`)}${paint.fg("metadata", took)}`;
	return paint.fg("metadata", took);
}

/** One stream row as screen lines, its time offset in the left column. */
function streamLines(paint: BoardPaint, row: StreamRow, startedAtMs: number, width: number): string[] {
	const at = Date.parse(row.at);
	const offset = paint.fg("metadata", formatOffset(Number.isFinite(at) ? at - startedAtMs : 0).padStart(6));
	const prefixWidth = 9;
	const room = Math.max(1, width - prefixWidth);
	const lead = (glyph: string): string => `${offset} ${glyph} `;
	switch (row.kind) {
		case "tool": {
			const mark = outcomeMark(paint, row);
			const call = cut(callText(row), Math.max(1, room - visibleWidth(mark)));
			const lines = [
				`${lead(paint.fg("toolGlyph", GLYPH.phaseTool))}${paint.fg(row.pending ? "activity" : "toolTarget", call)}${mark}`,
			];
			if (row.reason !== undefined && row.outcome !== "ok") {
				// Two rows say why; the whole reason is in the record and `fleet view`.
				const why = wrapPrefixed(" ".repeat(prefixWidth), clean(row.reason), width, prefixWidth);
				if (why.length > 2) why[1] = cut(`${why[1]}${GLYPH.ellipsis}`, width);
				lines.push(...why.slice(0, 2).map((line) => paint.fg("warning", line)));
			}
			return lines;
		}
		case "text": {
			const prose = row.text
				.split("\n")
				.map((line) => clean(line))
				.join("\n");
			return wrapPrefixed(lead(paint.fg("assistantProse", GLYPH.agent)), prose, width, prefixWidth).map((line, index) =>
				index === 0 ? line : paint.fg("assistantProse", line),
			);
		}
		case "thinking":
			return [`${lead(paint.fg("metadata", GLYPH.phaseThinking))}${paint.dim("thinking")}`];
		case "approval": {
			const what = [row.tool, row.text].filter((part) => part !== undefined && part.length > 0).join(" ");
			return wrapPrefixed(
				lead(paint.fg("attention", GLYPH.phaseBlocked)),
				paint.fg("attention", `approval asked ${GLYPH.sep} ${clean(what)}`),
				width,
				prefixWidth,
			);
		}
		case "decision": {
			const approved = row.outcome === "ok";
			const words = `${approved ? "approved" : clean(row.text || "denied")} ${clean(row.tool ?? "")}`.trim();
			const reason = row.reason === undefined ? "" : `: ${clean(row.reason)}`;
			return wrapPrefixed(
				lead(paint.fg(approved ? "success" : "warning", approved ? GLYPH.ok : GLYPH.cancelled)),
				paint.fg(approved ? "success" : "warning", `${words}${reason}`),
				width,
				prefixWidth,
			);
		}
		case "error": {
			const reason = row.reason === undefined ? "" : `: ${clean(row.reason)}`;
			return wrapPrefixed(
				lead(paint.fg("error", GLYPH.error)),
				paint.fg("error", `${clean(row.text)}${reason}`),
				width,
				prefixWidth,
			);
		}
		default:
			return wrapPrefixed(
				lead(paint.fg("metadata", GLYPH.dot)),
				paint.fg("metadata", clean(row.text)),
				width,
				prefixWidth,
			);
	}
}

/** The conformance state as a phrase; the raw state stays on the run record and `/view`. */
function contractWords(contract: string): string {
	if (contract === "pass") return "contract met";
	if (contract === "fail") return "contract failed";
	return `contract ${contract.replace(/-/gu, " ")}`;
}

/**
 * What a finished worker's record says, in the transcript's words, fitted to `width` by whole facts. The row once cut
 * its tail to `seal unche…` and had no room for a refused call at all (bt-11); the least important fact now leaves
 * first, and the outcome is the only one ever cut.
 */
export function verdictText(paint: BoardPaint, card: WorkerCard, width: number): string {
	const record = card.record;
	if (record === null) {
		const detail = card.ledgerDetail === undefined ? "run record unavailable" : clean(card.ledgerDetail);
		const failed = card.state === "failed";
		return cut(paint.fg(failed ? "error" : "metadata", `${failed ? GLYPH.error : GLYPH.ok} ${detail}`), width);
	}
	// Shown in this order; `rank` says which leaves first when the row is too narrow, the highest first.
	const parts: Array<{ text: string; rank: number }> = [];
	if (record.outcome === "succeeded") {
		parts.push({
			text:
				card.toolCalls === 0
					? paint.fg("metadata", `${GLYPH.queued} ran no tools`)
					: paint.fg("success", `${GLYPH.ok} succeeded`),
			rank: 0,
		});
	} else if (record.outcome === "canceled") {
		parts.push({ text: paint.fg("metadata", `${GLYPH.cancelled} cancelled`), rank: 0 });
	} else {
		parts.push({
			text: paint.fg("error", `${GLYPH.error} ${clean(plainOutcomeLabel(record.outcomeCode ?? record.outcome))}`),
			rank: 0,
		});
	}
	if (record.refused !== undefined) parts.push({ text: paint.fg("warning", clean(record.refused)), rank: 2 });
	// A broken or unchecked seal outranks the verdict built on it.
	if (record.seal !== undefined && record.seal !== "sealed") {
		const broken = record.seal === "seal broken";
		parts.push({ text: paint.fg(broken ? "error" : "warning", clean(record.seal)), rank: broken ? 1 : 3 });
	} else if (record.verdict !== undefined) {
		const sound = ["reviewed", "grounded", "unverified", "unknown"].includes(record.verdict);
		parts.push({
			text: paint.fg(sound ? "metadata" : "warning", sound ? `trust ${record.verdict}` : clean(record.verdict)),
			rank: sound ? 4 : 2,
		});
	}
	if (record.contract !== undefined) {
		const failed = record.contract === "fail";
		parts.push({ text: paint.fg(failed ? "error" : "metadata", contractWords(record.contract)), rank: failed ? 1 : 5 });
	}
	const separator = sep(paint);
	const shown = [...parts];
	while (shown.length > 1 && visibleWidth(shown.map((part) => part.text).join(separator)) > width) {
		let drop = shown.length - 1;
		for (let at = shown.length - 1; at > 0; at -= 1) {
			if ((shown[at]?.rank ?? 0) > (shown[drop]?.rank ?? 0)) drop = at;
		}
		shown.splice(drop, 1);
	}
	return cut(shown.map((part) => part.text).join(separator), width);
}

/** One fact of the detail's block: its label and its painted value rows. */
interface DetailFact {
	label: string;
	/** The label when `limit` cuts the value: it names the key that shows the rest. */
	cutLabel?: string;
	/** Painted value; wrapped to the value column unless `wrap` is false, when each entry is already one row. */
	value: string[];
	wrap: boolean;
	/** The most rows the value shows; the last ends with `…` when it is cut. */
	limit?: number;
}

/** The fact block: label beside value from 44 cells, the label above its value under that (W1). */
function factLines(paint: BoardPaint, facts: readonly DetailFact[], width: number): string[] {
	const stack = width < SIDE_BY_SIDE_CELLS;
	const labelWidth = Math.max(...facts.map((fact) => visibleWidth(fact.cutLabel ?? fact.label)));
	const indent = stack ? 3 : 1 + labelWidth + 2;
	const room = Math.max(1, width - indent);
	const lines: string[] = [];
	for (const fact of facts) {
		let rows = fact.wrap ? fact.value.flatMap((value) => wrapTextWithAnsi(value, room)) : [...fact.value];
		const limit = fact.limit ?? Number.POSITIVE_INFINITY;
		const cutRows = rows.length > limit;
		if (cutRows) {
			const kept = Math.max(0, limit);
			rows = kept === 0 ? [] : [...rows.slice(0, kept - 1), cut(rows.slice(kept - 1).join(" "), room)];
		}
		rows = rows.map((row) => cut(row, room));
		const text = cutRows ? (fact.cutLabel ?? fact.label) : fact.label;
		const label = paint.fg("annotation", text);
		if (stack) {
			lines.push(cut(` ${label}`, width));
			for (const row of rows) lines.push(`   ${row}`);
			continue;
		}
		const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(text)));
		rows.forEach((row, index) => {
			lines.push(index === 0 ? ` ${label}${pad}  ${row}` : `${" ".repeat(indent)}${row}`);
		});
		if (rows.length === 0) lines.push(cut(` ${label}`, width));
	}
	return lines;
}

/** A section title on a rule: `answer ────`. */
function sectionRule(paint: BoardPaint, title: string, width: number): string {
	const fill = Math.max(0, width - visibleWidth(title) - 2);
	return cut(` ${paint.fg("annotation", title)} ${paint.fg("divider", GLYPH.rule.repeat(fill))}`, width);
}

const LIST_ITEM = /^(\s*(?:[-*+]|\d+[.)])\s+)/u;

/** The answer as wrapped Markdown: list items hang under their marker, headings in the heading role. */
function answerLines(paint: BoardPaint, answer: string, width: number): string[] {
	const room = Math.max(1, width - 1);
	const lines: string[] = [];
	for (const raw of answer.split("\n")) {
		const line = clean(raw);
		if (line.trim().length === 0) {
			lines.push("");
			continue;
		}
		if (/^#{1,6}\s/u.test(line)) {
			for (const row of wrapTextWithAnsi(line, room)) lines.push(` ${paint.fg("heading", row, true)}`);
			continue;
		}
		const hangMarker = LIST_ITEM.exec(line)?.[1] ?? "";
		const hang = Math.min(Math.max(0, room - 1), visibleWidth(hangMarker));
		const marker = hang > 0 ? hangMarker : "";
		const rows = wrapTextWithAnsi(line.slice(marker.length), Math.max(1, room - hang));
		rows.forEach((row, index) => {
			const lead = index === 0 ? marker : " ".repeat(hang);
			lines.push(` ${paint.fg("assistantProse", `${lead}${row}`)}`);
		});
	}
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** The pinned row: `[Esc] back · <state> <identity> · <elapsed>`. */
function detailHeader(paint: BoardPaint, card: WorkerCard, width: number): string {
	const facts = runFacts(card);
	const layout = runRow(facts, {
		width: Number.MAX_SAFE_INTEGER,
		identityWidth: runIdentityWidth([facts], visibleWidth),
		measure: visibleWidth,
	});
	const identity = withStale(
		card,
		layout.cells.filter((cell) => ["state", "origin", "helper", "agent"].includes(cell.slot)),
	);
	const parts = [keyUnit(paint, "Esc", "back"), paintCells(paint, identity, (cell) => cell.slot === "agent")];
	if (facts.elapsed !== undefined && card.state !== "queued") parts.push(paint.fg("metadata", facts.elapsed));
	return cut(` ${parts.join(sep(paint))}`, width);
}

/** The scroll region: the fact block, then the answer, or the stream while the run is live. */
function detailBody(
	paint: BoardPaint,
	model: TakeoverModel,
	view: TakeoverView,
	width: number,
): { lines: string[]; answerStart: number } {
	const policy = tierPolicy();
	const { card } = model;
	const facts = runFacts(card);
	const state = runRow(facts, { width, identityWidth: 0, measure: visibleWidth }).state;
	const live = isLive(card.state);
	const record = card.record;
	const block: DetailFact[] = [];

	const calls = renderCalls(card.toolCallsDisplay ?? String(card.toolCalls), "call");
	const tokens = tokensText(card);
	const result = [
		paint.fg(card.state === "stale" ? "warning" : state.role, stateWord(card, state)),
		...(live && state.kind !== "pending" && facts.phase !== undefined ? [paint.fg("activity", facts.phase)] : []),
		...(state.kind === "pending" && facts.approval !== undefined
			? [paint.fg("attention", facts.approval.words(Number.MAX_SAFE_INTEGER))]
			: []),
		paint.fg("metadata", calls),
		...(tokens !== undefined ? [paint.fg("metadata", tokens)] : []),
		...(record?.refused !== undefined ? [paint.fg("warning", clean(record.refused))] : []),
	].join(sep(paint));
	block.push({ label: "result", value: [result], wrap: true });
	if (state.kind === "error" && facts.reason !== undefined)
		block.push({ label: "reason", value: [paint.fg("error", facts.reason)], wrap: true });

	const sideRows = policy.paneCardRows;
	if (sideRows >= 2 && !live) {
		const changed = record?.changedPaths;
		block.push({
			label: "changed",
			value: [paint.fg("body", changed === undefined ? "nothing" : changed.map(clean).join(", "))],
			wrap: true,
		});
	}
	if (sideRows >= 2 && model.fleet !== null) {
		const fleet = model.fleet;
		const progress =
			fleet.plannedSteps > 0 ? ` ${GLYPH.sep} ${fleet.settledSteps}/${fleet.plannedSteps} steps settled` : "";
		block.push({
			label: "fleet",
			value: [paint.fg("metadata", `${clean(fleet.name)}${progress}${fleet.running ? ` ${GLYPH.sep} following` : ""}`)],
			wrap: true,
		});
	}
	const task = clean(card.task);
	const taskRows = view.taskExpanded ? Number.POSITIVE_INFINITY : detailTaskRows(policy);
	if (taskRows > 0 && task.length > 0) {
		block.push({
			label: "task",
			cutLabel: `task ${GLYPH.sep} [t] all of it`,
			value: [paint.fg("body", task)],
			wrap: true,
			limit: taskRows,
		});
	}
	if (policy.runSubRows > 0) {
		const route = [clean(card.target), clean(card.model)].filter((part) => part.length > 0).join(` ${GLYPH.sep} `);
		block.push({ label: "route", value: [paint.fg("metadata", route)], wrap: true });
		if (!live) {
			const validation = record?.validation === undefined ? [] : [paint.fg("metadata", clean(record.validation))];
			block.push({
				label: "record",
				value: [verdictText(paint, card, Number.MAX_SAFE_INTEGER), ...validation],
				wrap: true,
			});
		}
	}
	if (policy.runTrail > 0 && card.trail.length > 0) {
		block.push({
			label: "trail",
			value: card.trail
				.slice(-policy.runTrail)
				.map(
					(row) =>
						`${paint.fg("toolGlyph", GLYPH.phaseTool)} ${paint.fg("toolTarget", callText(row))}${outcomeMark(paint, row)}`,
				),
			wrap: false,
		});
	}
	const lines = factLines(paint, block, width);

	if (live) {
		lines.push(sectionRule(paint, "stream", width));
		const answerStart = lines.length;
		if (!model.fold.present) {
			lines.push(
				cut(` ${paint.fg("emptyState", "no display feed for this run (fleet.history.journal may be off)")}`, width),
			);
		} else if (model.fold.droppedRows > 0 || model.fold.truncated) {
			lines.push(cut(paint.fg("metadata", `   ${GLYPH.ellipsis} earlier events are not shown`), width));
		}
		for (const row of model.fold.rows) lines.push(...streamLines(paint, row, card.startedAtMs, width));
		if (model.fold.present && model.fold.rows.length === 0) {
			lines.push(cut(` ${paint.fg("emptyState", "started; no events yet")}`, width));
		}
		return { lines: lines.map((line) => cut(line, width)), answerStart };
	}
	const answer = record?.answer;
	if (answer !== undefined && answer.trim().length > 0) {
		lines.push(sectionRule(paint, "answer", width));
		const answerStart = lines.length;
		lines.push(...answerLines(paint, answer, width));
		return { lines: lines.map((line) => cut(line, width)), answerStart };
	}
	const answerStart = lines.length;
	if (model.fleet?.running === true && view.followSuccessor) {
		lines.push(
			cut(` ${paint.fg("activity", `${GLYPH.phaseWaiting} waiting for the fleet's next step${GLYPH.ellipsis}`)}`, width),
		);
	}
	return { lines: lines.map((line) => cut(line, width)), answerStart };
}

/** Run detail: the pinned identity row, the one scroll region, the key row. */
export function renderTakeover(
	paint: BoardPaint,
	model: TakeoverModel | null,
	view: TakeoverView,
	width: number,
	height: number,
): string[] {
	const columns = Math.max(1, width);
	const rule = paint.fg("divider", GLYPH.rule.repeat(columns));
	const keys = keyRow(
		paint,
		[
			[UP_DOWN, "scroll"],
			["t", "task"],
			["Esc", "back"],
		],
		columns,
	);
	if (model === null) {
		const waiting = [
			cut(` ${keyUnit(paint, "Esc", "back")}${sep(paint)}${paint.fg("metadata", `run ${clean(view.runId)}`)}`, columns),
			rule,
			cut(` ${paint.fg("emptyState", `waiting for this run to reach the ledger${GLYPH.ellipsis}`)}`, columns),
			cut(` ${paint.fg("metadata", "a queued run appears once it starts")}`, columns),
		];
		while (waiting.length < height - 2) waiting.push("");
		return [...waiting, rule, keys];
	}
	const header = [detailHeader(paint, model.card, columns), rule];
	const footer = [rule, keys];
	const bodyHeight = Math.max(1, height - header.length - footer.length);
	const { lines, answerStart } = detailBody(paint, model, view, columns);
	// A change above the answer (the task folding, the tier) never moves the answer on screen: while its first row is
	// on screen or above it, the window moves with it. Only an answer still below the window lets the change show.
	if (view.scrollTop !== null && view.answerStart >= 0 && answerStart !== view.answerStart) {
		view.scrollTop =
			view.answerStart < view.scrollTop + view.bodyHeight
				? view.scrollTop + (answerStart - view.answerStart)
				: Math.min(view.scrollTop, answerStart);
	}
	view.answerStart = answerStart;
	view.live = isLive(model.card.state);
	view.streamLength = lines.length;
	view.bodyHeight = bodyHeight;
	const maxTop = Math.max(0, lines.length - bodyHeight);
	if (view.scrollTop !== null) view.scrollTop = Math.max(0, Math.min(view.scrollTop, maxTop));
	const top = view.scrollTop ?? maxTop;
	const body = lines.slice(top, top + bodyHeight);
	const below = lines.length - (top + bodyHeight);
	if (below > 0)
		body[body.length - 1] = cut(` ${paint.fg("scrollMarker", `${GLYPH.ellipsis} ${below + 1} more rows`)}`, columns);
	while (body.length < bodyHeight) body.push("");
	return [...header, ...body, ...footer];
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

export interface WorkersDashboardOptions {
	selectionPath: string;
	/** Where keys pressed here reach Clio. Absent when run by hand: `q` then quits. */
	tapPath: string | null;
	scope: ReturnType<typeof fleetInspectionScope>;
	source?: BoardSource;
	/** The launching Clio's color depth, pinned on argv: a pane inherits the multiplexer's environment, not Clio's. */
	colorDepth?: ColorDepth;
}

/** The interactive dashboard; resolves when the operator closes it. */
export async function runWorkersDashboard(options: WorkersDashboardOptions): Promise<number> {
	const { ProcessTerminal, TuiAltScreen, isKeyRelease, matchesKey } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal, undefined, undefined, {
		// #437: confirm copies through a system clipboard tool instead of a bare OSC 52.
		copySelection: (text) =>
			import("../engine/clipboard.js")
				.then(({ copyToSystemClipboard }) => copyToSystemClipboard(text, (sequence) => terminal.write(sequence)))
				.catch(() => "Copy failed: clipboard module did not load"),
	});
	const paint = createBoardPaint(options.colorDepth);
	const source = options.source ?? createBoardSource();

	let request: WatchRequest | null = readWatchRequest(options.selectionPath);
	let lastSeq: string | null = null;
	let mode: "board" | "takeover" = "board";
	const boardView: BoardView = { selectedRunId: null, top: 0 };
	let takeoverView: TakeoverView | null = null;
	let cards: WorkerCard[] = [];
	let takeover: TakeoverModel | null = null;

	/**
	 * `follow` arms the jump to a retry or the fleet's next step. Enter on a card that already finished inspects it
	 * and stays; a run Clio asked for by name is followed even when the request lands after it finished.
	 */
	const enterTakeover = (runId: string, follow: "always" | "when-live"): void => {
		mode = "takeover";
		boardView.selectedRunId = runId;
		takeover = loadTakeover(source, runId, Date.now());
		const live = takeover === null || isLive(takeover.card.state);
		takeoverView = newTakeoverView(runId, live, follow === "always" || live);
	};

	const applyRequest = (): void => {
		request = readWatchRequest(options.selectionPath) ?? request;
		if (request === null) return;
		// The tier rides on every request; a refresh changes it without a new `seq`, so selection and scroll stay.
		setPresentationTier(request.outputDetail);
		if (request.seq === lastSeq) return;
		lastSeq = request.seq;
		if (request.runId === null) {
			mode = "board";
			takeoverView = null;
		} else enterTakeover(request.runId, "always");
	};

	const refresh = (): void => {
		const nowMs = Date.now();
		applyRequest();
		if (mode === "takeover" && takeoverView !== null) {
			const view: TakeoverView = takeoverView;
			takeover = loadTakeover(source, view.runId, nowMs);
			if (takeover !== null && !isLive(takeover.card.state) && view.followSuccessor) {
				const next = successorRun(source, view.runId);
				if (next !== null) {
					boardView.selectedRunId = next;
					takeover = loadTakeover(source, next, nowMs);
					takeoverView = newTakeoverView(next, true, true);
				}
			}
			return;
		}
		cards = orderedCards(loadBoard(source, request, options.scope, nowMs));
		if (!cards.some((card) => card.runId === boardView.selectedRunId)) boardView.selectedRunId = cards[0]?.runId ?? null;
	};

	const moveSelection = (delta: number): void => {
		if (cards.length === 0) return;
		const index = cards.findIndex((card) => card.runId === boardView.selectedRunId);
		const next = Math.max(0, Math.min(cards.length - 1, (index < 0 ? 0 : index) + delta));
		boardView.selectedRunId = cards[next]?.runId ?? null;
	};

	/** Scroll by rows; reaching the newest row of a live run resumes following it. */
	const scrollTakeover = (view: TakeoverView, delta: number): void => {
		const maxTop = Math.max(0, view.streamLength - view.bodyHeight);
		const next = Math.max(0, Math.min(maxTop, (view.scrollTop ?? maxTop) + delta));
		view.scrollTop = next >= maxTop && view.live ? null : next;
	};

	const view = {
		render(width: number): string[] {
			const height = Math.max(6, terminal.rows);
			if (mode === "takeover" && takeoverView !== null) {
				return renderTakeover(paint, takeover, takeoverView, width, height);
			}
			return renderBoard(paint, cards, boardView, width, height);
		},
		invalidate(): void {},
	};
	tui.addChild(view);

	const tap = (word: "hide" | "key"): boolean => {
		if (options.tapPath === null) return false;
		try {
			appendFileSync(options.tapPath, `${word}\n`);
			return true;
		} catch {
			// Clio is gone or the state root moved; the key does nothing rather than crash the dock.
			return false;
		}
	};

	refresh();
	return await new Promise<number>((resolve) => {
		let settled = false;
		const timer = setInterval(() => {
			refresh();
			tui.requestRender();
		}, POLL_MS);
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearInterval(timer);
			removeInput();
			tui.stop();
			resolve(0);
		};
		const removeInput = tui.addInputListener((data: string) => {
			if (isKeyRelease(data)) return undefined;
			// Raw mode delivers Ctrl+C as a byte; it ends the dashboard and its pane.
			if (matchesKey(data, "ctrl+c")) {
				finish();
				return { consume: true };
			}
			if (matchesKey(data, "alt+w")) {
				tap("key");
				return { consume: true };
			}
			if (data === "q") {
				if (!tap("hide")) finish();
				return { consume: true };
			}
			const open = mode === "takeover" ? takeoverView : null;
			if (open !== null) {
				const half = Math.max(1, Math.floor(open.bodyHeight / 2));
				if (matchesKey(data, "escape") || matchesKey(data, "left") || matchesKey(data, "backspace") || data === "h") {
					mode = "board";
					takeoverView = null;
					refresh();
				} else if (matchesKey(data, "up") || data === "k") scrollTakeover(open, -1);
				else if (matchesKey(data, "down") || data === "j") scrollTakeover(open, 1);
				else if (matchesKey(data, "ctrl+u")) scrollTakeover(open, -half);
				else if (matchesKey(data, "ctrl+d")) scrollTakeover(open, half);
				else if (data === "t") open.taskExpanded = !open.taskExpanded;
				else if (data === "g") open.scrollTop = 0;
				else if (data === "G") open.scrollTop = open.live ? null : Math.max(0, open.streamLength - open.bodyHeight);
				else return undefined;
				tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "up") || data === "k") moveSelection(-1);
			else if (matchesKey(data, "down") || data === "j") moveSelection(1);
			else if (data === "g") moveSelection(-cards.length);
			else if (data === "G") moveSelection(cards.length);
			else if (matchesKey(data, "enter") || matchesKey(data, "right") || data === "l") {
				if (boardView.selectedRunId !== null) enterTakeover(boardView.selectedRunId, "when-live");
			} else return undefined;
			tui.requestRender();
			return { consume: true };
		});
		tui.start();
		tui.requestRender();
	});
}
