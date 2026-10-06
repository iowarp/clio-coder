/**
 * The workers dashboard: the process the workers dock (Alt+W) runs.
 *
 * It opens on a board of worker cards, one per worker of this Clio session,
 * running ones first. Each card says who the worker is, what it was asked,
 * its state and clock, its route, its tool budget, what it spent, and what it
 * is doing now, or for a finished one, how the sealed receipt judged it.
 * Enter takes the whole dock over for the selected worker: a pinned header and
 * the worker's live stream underneath (calls with their targets and results,
 * prose as it is written, approvals, refusals, errors), then the receipt
 * summary once it seals. Esc returns to the board at the same card.
 *
 * Everything comes from durable state (src/cli/fleet-board-model.ts), so the
 * dashboard is a read-only viewer that also works over SSH and never runs a
 * second Clio on top of a worker. Clio talks to it through two small files:
 * the watch selection file asks for a takeover (`/panes show`, the panes tool,
 * Enter in the Fleet Runs board), and the dock tap file carries keys pressed
 * here back to Clio: `q` hides the dock and hands the keyboard back, and
 * Alt+W is the same tap Clio's own workers key makes.
 *
 * Rows are width-aware and byte-stable: a card's three rows change only when
 * its facts do, so the differential renderer repaints the moving clock and
 * the live line rather than the screen. Narrow docks shed text in a fixed
 * order: the task first, then the model, then cost and route; the state glyph
 * and the clock always stay.
 */

import { appendFileSync } from "node:fs";
import { terminalBackground } from "../core/terminal-background.js";
import { colorDisabled } from "../core/terminal-preferences.js";
import { resolveRole, type SemanticRole } from "../core/theme-roles.js";
import { paletteProjection } from "../core/theme-token-hex.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import { redactSecretString } from "../domains/safety/redaction.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui-primitives.js";
import {
	ANSWER_PREVIEW_LINES,
	type BoardModel,
	type BoardSource,
	type CardState,
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
	type WorkerPhase,
} from "./fleet-board-model.js";
import type { fleetInspectionScope } from "./fleet-project-scope.js";

/** Poll cadence, matching the monitor tool and the journal's coalescing window. */
const POLL_MS = 250;
const MIN_WIDTH = 24;
const TIMER_WIDTH = 7;
const NAME_MAX = 16;
const SEPARATOR = " · ";
const RULE = "─";

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

function detectTruecolor(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = `${env.COLORTERM ?? ""} ${env.TERM ?? ""}`.toLowerCase();
	return value.includes("truecolor") || value.includes("24bit");
}

/**
 * Semantic roles painted from the same palette the TUI uses, through core
 * rather than the interactive theme, which this process must not load. Color
 * off (NO_COLOR and friends) paints nothing, and every glyph still says what
 * its color would.
 */
export interface BoardPaint {
	fg(role: SemanticRole, text: string, bold?: boolean): string;
	dim(text: string): string;
}

function createBoardPaint(enabled: boolean = !colorDisabled()): BoardPaint {
	const background = terminalBackground();
	const truecolor = detectTruecolor();
	const codes = new Map<SemanticRole, string>();
	const code = (role: SemanticRole): string => {
		let sequence = codes.get(role);
		if (sequence === undefined) {
			const [hex, xterm] = paletteProjection(resolveRole(role).color, background);
			const rgb = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
			sequence = truecolor ? `\u001b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : `\u001b[38;5;${xterm}m`;
			codes.set(role, sequence);
		}
		return sequence;
	};
	return {
		fg(role, text, bold = false): string {
			if (!enabled || text.length === 0) return text;
			return `${code(role)}${bold ? "\u001b[1m" : ""}${text}${bold ? "\u001b[22m" : ""}\u001b[39m`;
		},
		dim(text): string {
			return enabled && text.length > 0 ? `\u001b[2m${text}\u001b[22m` : text;
		},
	};
}

/** Worker-adjacent text crosses a trust boundary: one line, no control bytes, no secrets. */
function clean(text: string): string {
	return sanitizeCallTargetText(redactSecretString(text));
}

function cut(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "…", false);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	if (hours < 1000) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d`;
}

/** `+m:ss` from the run's start, the stream's time column. */
function formatOffset(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `+${minutes}:${String(seconds % 60).padStart(2, "0")}`;
	return `+${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
}

export function formatTokens(tokens: number): string {
	if (tokens < 1000) return `${tokens}`;
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}

function formatDuration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : formatClock(ms);
}

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
	verifying: "verified",
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

function elapsedOf(card: WorkerCard, nowMs: number): number {
	return (card.endedAtMs ?? nowMs) - card.startedAtMs;
}

// ---------------------------------------------------------------------------
// Card rows
// ---------------------------------------------------------------------------

function stateGlyph(paint: BoardPaint, card: WorkerCard): string {
	switch (card.state) {
		case "running":
			return paint.fg("activity", "●");
		case "queued":
			return paint.fg("toolMetadata", "◌");
		case "stale":
			return paint.fg("warning", "!");
		case "succeeded":
			return card.toolCalls === 0 ? paint.fg("toolMetadata", "◌") : paint.fg("success", "✓");
		case "canceled":
			return paint.fg("toolMetadata", "⊘");
		default:
			return paint.fg("error", "✗");
	}
}

function stateWord(state: CardState): string {
	return state === "succeeded" ? "done" : state;
}

function meter(calls: number, cap: number | undefined): string {
	if (cap === undefined) return `tools ${calls}`;
	const filled = Math.min(3, Math.ceil((calls / cap) * 3));
	return `${"▰".repeat(filled)}${"▱".repeat(3 - filled)} tools ${calls}/${cap}`;
}

/**
 * The facts row, shed in a fixed order as the dock narrows: the model is cut,
 * then cost, route and tokens leave; the tool budget stays longest.
 */
function factsText(card: WorkerCard, width: number): string {
	const target = clean(card.target);
	const model = clean(card.model);
	const tools = meter(card.toolCalls, card.toolCap);
	const tokens = card.tokens === undefined ? null : `${formatTokens(card.tokens)} tok`;
	const cost = card.cost ?? null;
	const join = (parts: ReadonlyArray<string | null>): string => parts.filter((part) => part !== null).join(SEPARATOR);
	const tail = [tools, tokens, cost];
	const withoutRoute = join(tail);
	const routeRoom = width - visibleWidth(withoutRoute) - SEPARATOR.length;
	const full = model.length > 0 ? `${target}/${model}` : target;
	if (routeRoom >= visibleWidth(full)) return join([full, ...tail]);
	if (model.length > 0 && routeRoom >= visibleWidth(target) + 4) return join([cut(full, routeRoom), ...tail]);
	if (routeRoom >= Math.min(visibleWidth(target), 8)) return join([cut(target, routeRoom), ...tail]);
	const noCost = join([tools, tokens]);
	if (visibleWidth(noCost) <= width) return noCost;
	return cut(tools, width);
}

function phaseWords(phase: WorkerPhase): [string, string] {
	switch (phase) {
		case "thinking":
			return ["◐", "thinking"];
		case "writing":
			return ["◑", "writing"];
		case "tool":
			return ["⚙", "calling a tool"];
		case "waiting":
			return ["◔", "waiting for the model"];
		case "settled":
			return ["◔", "sealing the receipt"];
		default:
			return ["◌", "starting"];
	}
}

/** What a finished worker's receipt says, in the transcript's words. */
function verdictText(paint: BoardPaint, card: WorkerCard): string {
	const receipt = card.receipt;
	if (receipt === null) {
		const detail = card.ledgerDetail === undefined ? "receipt unavailable" : clean(card.ledgerDetail);
		return `${stateGlyph(paint, card)} ${paint.fg(card.state === "failed" ? "error" : "toolMetadata", `${stateWord(card.state)} · ${detail}`)}`;
	}
	const parts: string[] = [];
	if (receipt.outcome === "succeeded") {
		parts.push(card.toolCalls === 0 ? paint.fg("toolMetadata", "◌ ran no tools") : paint.fg("success", "✓ succeeded"));
	} else if (receipt.outcome === "canceled") {
		parts.push(paint.fg("toolMetadata", "⊘ canceled"));
	} else {
		parts.push(paint.fg("error", `✗ ${clean(receipt.outcomeCode ?? receipt.outcome)}`));
	}
	if (receipt.contract !== undefined) {
		parts.push(paint.fg(receipt.contract === "fail" ? "error" : "toolMetadata", `contract ${receipt.contract}`));
	}
	// A broken or unchecked seal outranks the verdict built on it.
	if (receipt.seal !== undefined && receipt.seal !== "sealed") parts.push(paint.fg("warning", clean(receipt.seal)));
	else if (receipt.verdict !== undefined) {
		const sound = ["reviewed", "grounded", "unverified", "unknown"].includes(receipt.verdict);
		parts.push(paint.fg(sound ? "toolMetadata" : "warning", sound ? `trust ${receipt.verdict}` : clean(receipt.verdict)));
	}
	return parts.join(paint.fg("toolMetadata", SEPARATOR));
}

/** The live row: the call running now, the prose being written, or the phase. */
function activityText(paint: BoardPaint, card: WorkerCard): string {
	if (!isLive(card.state)) return verdictText(paint, card);
	if (card.state === "queued") return paint.fg("toolMetadata", "◌ queued, waiting for a slot");
	if (card.current !== null) return `${paint.fg("toolGlyph", "⚙")} ${paint.fg("toolTarget", callText(card.current))}`;
	if (card.phase === "writing" && card.lastText !== undefined) {
		const prose = clean(card.lastText.replace(/\s+/gu, " ").trim());
		return `${paint.fg("activity", "◑")} ${paint.fg("assistantProse", prose)}`;
	}
	if (card.phase === "waiting" && card.last !== null) {
		return `${paint.fg("toolMetadata", "◔")} ${paint.fg("toolMetadata", `last: ${callText(card.last)}`)}`;
	}
	const [glyph, words] = phaseWords(card.phase);
	return paint.fg("activity", `${glyph} ${words}`);
}

/** One card: the aligned header, the facts, and the live or verdict row. */
function renderCard(
	paint: BoardPaint,
	card: WorkerCard,
	width: number,
	options: { selected: boolean; nameWidth: number; nowMs: number },
): string[] {
	const gutter = options.selected ? paint.fg("selectionBadge", "▌") : " ";
	const inner = width - 1;
	const name = clean(card.agentId);
	const nameWidth = Math.max(1, Math.min(options.nameWidth, inner - TIMER_WIDTH - 4));
	const shownName = cut(name, nameWidth);
	const timer = formatClock(elapsedOf(card, options.nowMs)).padStart(TIMER_WIDTH);
	const head = `${stateGlyph(paint, card)} ${paint.fg(options.selected ? "selectedOption" : "workerIdentity", shownName, options.selected)}${" ".repeat(Math.max(0, nameWidth - visibleWidth(shownName)))} ${paint.fg("toolMetadata", timer)}`;
	const taskRoom = inner - visibleWidth(head) - 2;
	const task = clean(card.task);
	const first = taskRoom >= 4 && task.length > 0 ? `${head}  ${paint.fg("body", cut(task, taskRoom))}` : head;
	const attempt = card.attempt > 0 ? `↻${card.attempt + 1} ` : "";
	const facts = `  ${paint.fg("toolMetadata", `${attempt}${factsText(card, inner - 2 - attempt.length)}`)}`;
	const activity = `  ${cut(activityText(paint, card), inner - 2)}`;
	return [first, facts, activity].map((row) => `${gutter}${cut(row, inner)}`);
}

// ---------------------------------------------------------------------------
// Board
// ---------------------------------------------------------------------------

export interface BoardView {
	selectedRunId: string | null;
	/** First row of the card list on screen; kept across frames so the list does not jump. */
	top: number;
}

function boardCounts(paint: BoardPaint, board: BoardModel): string {
	const done = board.finished.filter((card) => card.state === "succeeded").length;
	const failed = board.finished.length - done;
	return [
		paint.fg("activity", `● ${board.running.length} running`),
		paint.fg("success", `✓ ${done} done`),
		...(failed > 0 ? [paint.fg("error", `✗ ${failed} failed`)] : []),
	].join("  ");
}

function hints(paint: BoardPaint, parts: ReadonlyArray<string>, width: number): string {
	const row: string[] = [];
	for (const part of parts) {
		if (visibleWidth([...row, part].join("  ")) > width - 1) break;
		row.push(part);
	}
	return ` ${paint.fg("keyboardHint", row.join("  "))}`;
}

const EMPTY_BOARD = [
	"No workers in this session yet.",
	"",
	"Dispatch one from Clio:",
	"  /run <agent> <task>    one worker on a task",
	"  /fleet run <playbook>      a playbook",
	"  or ask Clio to delegate the work.",
	"",
	"Cards appear here as workers start.",
];

/** The whole board screen, exactly `height` rows (fewer only when the terminal is tiny). */
function renderBoard(
	paint: BoardPaint,
	board: BoardModel,
	view: BoardView,
	width: number,
	height: number,
	nowMs: number,
): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = paint.fg("divider", RULE.repeat(columns));
	const cards = [...board.running, ...board.finished];
	const header = [cut(` ${paint.fg("heading", "workers", true)}  ${boardCounts(paint, board)}`, columns), rule];
	const footer = [rule, hints(paint, ["↑↓ select", "⏎ open", "q hide", "ctrl+c close"], columns)];
	const bodyHeight = Math.max(1, height - header.length - footer.length);
	if (cards.length === 0) {
		const body = EMPTY_BOARD.map((line) =>
			cut(` ${paint.fg(line.startsWith("  ") ? "commandHint" : "emptyState", line)}`, columns),
		);
		while (body.length < bodyHeight) body.push("");
		return [...header, ...body.slice(0, bodyHeight), ...footer];
	}
	const nameWidth = Math.min(NAME_MAX, Math.max(...cards.map((card) => visibleWidth(clean(card.agentId)))));
	const rows: string[] = [];
	let selectedStart = 0;
	let selectedEnd = 0;
	cards.forEach((card, index) => {
		if (index === board.running.length && board.running.length > 0) {
			rows.push(cut(` ${paint.fg("groupHeading", "finished")}`, columns));
		}
		const selected = card.runId === view.selectedRunId;
		if (selected) selectedStart = rows.length;
		rows.push(...renderCard(paint, card, columns, { selected, nameWidth, nowMs }));
		if (selected) selectedEnd = rows.length;
	});
	// Keep the selected card whole on screen, moving the window as little as possible.
	let top = Math.min(view.top, Math.max(0, rows.length - bodyHeight));
	if (selectedStart < top) top = selectedStart;
	if (selectedEnd > top + bodyHeight) top = selectedEnd - bodyHeight;
	top = Math.max(0, top);
	view.top = top;
	const body = rows.slice(top, top + bodyHeight);
	if (top > 0) body[0] = cut(` ${paint.fg("scrollMarker", `↑ ${top} more`)}`, columns);
	const below = rows.length - (top + bodyHeight);
	if (below > 0) body[body.length - 1] = cut(` ${paint.fg("scrollMarker", `↓ ${below} more`)}`, columns);
	while (body.length < bodyHeight) body.push("");
	return [...header, ...body, ...footer];
}

// ---------------------------------------------------------------------------
// Takeover
// ---------------------------------------------------------------------------

export interface TakeoverView {
	runId: string;
	/** First stream line on screen, or null to follow the newest. */
	scrollTop: number | null;
	/** Move to the run that carries this one's work on once it finishes. */
	followSuccessor: boolean;
	/** Written by each render: stream lines and the rows the window shows them in. */
	streamLength: number;
	bodyHeight: number;
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
	const took = row.durationMs === undefined ? "" : ` ${formatDuration(row.durationMs)}`;
	if (row.pending) return paint.fg("activity", " …");
	if (row.outcome === "error") return paint.fg("error", ` ✗ failed${took}`);
	if (row.outcome === "blocked") return paint.fg("warning", ` ⊘ blocked${took}`);
	if (row.outcome === "ok") return paint.fg("success", ` ✓${paint.fg("toolMetadata", took)}`);
	return paint.fg("toolMetadata", took);
}

/** One stream row as screen lines, its time offset in the left column. */
function streamLines(paint: BoardPaint, row: StreamRow, startedAtMs: number, width: number): string[] {
	const at = Date.parse(row.at);
	const offset = paint.fg("toolMetadata", formatOffset(Number.isFinite(at) ? at - startedAtMs : 0).padStart(6));
	const prefixWidth = 9;
	const room = Math.max(1, width - prefixWidth);
	const lead = (glyph: string): string => `${offset} ${glyph} `;
	switch (row.kind) {
		case "tool": {
			const mark = outcomeMark(paint, row);
			const call = cut(callText(row), Math.max(1, room - visibleWidth(mark)));
			const lines = [
				`${lead(paint.fg("toolGlyph", "⚙"))}${paint.fg(row.pending ? "activity" : "toolTarget", call)}${mark}`,
			];
			if (row.reason !== undefined && row.outcome !== "ok") {
				// Two rows say why; the whole reason is in the receipt and `fleet view`.
				const why = wrapPrefixed(" ".repeat(prefixWidth), clean(row.reason), width, prefixWidth);
				if (why.length > 2) why[1] = cut(`${why[1]}…`, width);
				lines.push(...why.slice(0, 2).map((line) => paint.fg("warning", line)));
			}
			return lines;
		}
		case "text": {
			const prose = row.text
				.split("\n")
				.map((line) => clean(line))
				.join("\n");
			return wrapPrefixed(lead(paint.fg("assistantProse", "✦")), prose, width, prefixWidth).map((line, index) =>
				index === 0 ? line : paint.fg("assistantProse", line),
			);
		}
		case "thinking":
			return [`${lead(paint.fg("toolMetadata", "◐"))}${paint.dim("thinking")}`];
		case "approval": {
			const what = [row.tool, row.text].filter((part) => part !== undefined && part.length > 0).join(" ");
			return wrapPrefixed(
				lead(paint.fg("warning", "⏸")),
				paint.fg("warning", `approval asked · ${clean(what)}`),
				width,
				prefixWidth,
			);
		}
		case "decision": {
			const approved = row.outcome === "ok";
			const words = `${approved ? "approved" : clean(row.text || "denied")} ${clean(row.tool ?? "")}`.trim();
			const reason = row.reason === undefined ? "" : `: ${clean(row.reason)}`;
			return wrapPrefixed(
				lead(paint.fg(approved ? "success" : "warning", approved ? "✓" : "⊘")),
				paint.fg(approved ? "success" : "warning", `${words}${reason}`),
				width,
				prefixWidth,
			);
		}
		case "error": {
			const reason = row.reason === undefined ? "" : `: ${clean(row.reason)}`;
			return wrapPrefixed(
				lead(paint.fg("error", "✗")),
				paint.fg("error", `${clean(row.text)}${reason}`),
				width,
				prefixWidth,
			);
		}
		default:
			return wrapPrefixed(
				lead(paint.fg("toolMetadata", "·")),
				paint.fg("toolMetadata", clean(row.text)),
				width,
				prefixWidth,
			);
	}
}

function receiptLines(paint: BoardPaint, model: TakeoverModel, width: number): string[] {
	const { card } = model;
	if (isLive(card.state)) return [];
	const lines: string[] = ["", paint.fg("divider", `${RULE.repeat(2)} receipt ${RULE.repeat(Math.max(0, width - 11))}`)];
	lines.push(cut(verdictText(paint, card), width));
	const receipt = card.receipt;
	if (receipt === null) return lines;
	const spend = [
		`${receipt.toolCalls ?? card.toolCalls} tool call${(receipt.toolCalls ?? card.toolCalls) === 1 ? "" : "s"}`,
		...(card.tokens !== undefined ? [`${formatTokens(card.tokens)} tokens`] : []),
		...(card.cost !== undefined ? [card.cost] : []),
		...(receipt.durationMs !== undefined ? [formatClock(receipt.durationMs)] : []),
	].join(SEPARATOR);
	lines.push(cut(paint.fg("toolMetadata", spend), width));
	const trust = [
		receipt.seal,
		receipt.verdict === undefined ? undefined : `trust ${receipt.verdict}`,
		receipt.validation,
	]
		.filter((part) => part !== undefined)
		.map((part) => clean(part as string))
		.join(SEPARATOR);
	if (trust.length > 0) lines.push(...wrapPrefixed("", paint.fg("toolMetadata", trust), width, 2));
	if (receipt.failure !== undefined) {
		const first = (receipt.failure.split("\n", 1)[0] ?? "").trim();
		if (first.length > 0) lines.push(...wrapPrefixed("", paint.fg("error", clean(first)), width, 2));
	}
	if (receipt.changedPaths !== undefined) {
		lines.push(...wrapPrefixed("", paint.fg("body", `changed ${receipt.changedPaths.map(clean).join(", ")}`), width, 2));
	}
	if (receipt.answer !== undefined) {
		const answer = receipt.answer.split("\n").map((line) => clean(line));
		const shown = answer.slice(0, ANSWER_PREVIEW_LINES);
		lines.push(paint.fg("groupHeading", "answer"));
		lines.push(...wrapPrefixed("  ", paint.fg("assistantProse", shown.join("\n")), width, 2));
		if (answer.length > shown.length) {
			lines.push(
				cut(
					paint.fg("toolMetadata", `  … ${answer.length - shown.length} more lines · clio-coder fleet view ${card.runId}`),
					width,
				),
			);
		}
	}
	return lines;
}

function takeoverHeader(paint: BoardPaint, model: TakeoverModel, width: number, nowMs: number): string[] {
	const { card } = model;
	const back = paint.fg("keyboardHint", "◂ esc");
	const who = `${stateGlyph(paint, card)} ${paint.fg("workerIdentity", clean(card.agentId), true)}`;
	const clock = paint.fg("toolMetadata", formatClock(elapsedOf(card, nowMs)));
	const run = paint.fg("toolMetadata", `run ${card.runId}`);
	const left = `${back}  ${who} ${paint.fg("toolMetadata", stateWord(card.state))} ${clock}`;
	const first =
		visibleWidth(`${left}  ${run}`) <= width
			? `${left}${" ".repeat(width - visibleWidth(left) - visibleWidth(run))}${run}`
			: cut(left, width);
	const task = wrapTextWithAnsi(clean(card.task), Math.max(1, width - 1))
		.slice(0, 2)
		.map((line) => ` ${paint.fg("body", line)}`);
	const facts = ` ${paint.fg("toolMetadata", factsText(card, width - 1))}`;
	const lines = [first, ...task, facts];
	if (model.fleet !== null) {
		const fleet = model.fleet;
		const progress = fleet.plannedSteps > 0 ? ` · ${fleet.settledSteps}/${fleet.plannedSteps} steps settled` : "";
		lines.push(
			cut(
				` ${paint.fg("dispatchAction", `⇲ fleet ${clean(fleet.name)}`)}${paint.fg("toolMetadata", `${progress}${fleet.running ? " · following" : ""}`)}`,
				width,
			),
		);
	}
	return lines.map((line) => cut(line, width));
}

/** The takeover screen: pinned header, the stream window, the hint row. */
function renderTakeover(
	paint: BoardPaint,
	model: TakeoverModel | null,
	view: TakeoverView,
	width: number,
	height: number,
	nowMs: number,
): string[] {
	const columns = Math.max(MIN_WIDTH, width);
	const rule = paint.fg("divider", RULE.repeat(columns));
	if (model === null) {
		const waiting = [
			cut(` ${paint.fg("keyboardHint", "◂ esc")}  ${paint.fg("toolMetadata", `run ${clean(view.runId)}`)}`, columns),
			rule,
			cut(` ${paint.fg("emptyState", "waiting for this run to reach the ledger…")}`, columns),
			cut(` ${paint.fg("toolMetadata", "a queued run appears once it starts")}`, columns),
		];
		while (waiting.length < height - 2) waiting.push("");
		return [...waiting, rule, hints(paint, ["esc board", "q hide"], columns)];
	}
	const header = [...takeoverHeader(paint, model, columns, nowMs), rule];
	const stream: string[] = [];
	if (!model.fold.present) {
		stream.push(
			cut(` ${paint.fg("emptyState", "no event journal for this run (fleet.history.journal may be off)")}`, columns),
		);
	} else if (model.fold.droppedRows > 0 || model.fold.truncated) {
		stream.push(cut(paint.fg("toolMetadata", "   … earlier events are not shown"), columns));
	}
	for (const row of model.fold.rows) stream.push(...streamLines(paint, row, model.card.startedAtMs, columns));
	if (model.fold.present && model.fold.rows.length === 0 && isLive(model.card.state)) {
		stream.push(cut(` ${paint.fg("emptyState", "started; no events yet")}`, columns));
	}
	if (isLive(model.card.state) && model.card.current === null && model.card.state !== "queued") {
		const [glyph, words] = phaseWords(model.card.phase);
		if (model.card.phase !== "writing") stream.push(cut(`        ${paint.fg("activity", `${glyph} ${words}`)}`, columns));
	}
	stream.push(...receiptLines(paint, model, columns - 1).map((line) => (line.length === 0 ? line : ` ${line}`)));
	if (!isLive(model.card.state) && model.fleet?.running === true && view.followSuccessor) {
		stream.push(cut(` ${paint.fg("activity", "◔ waiting for the fleet's next step…")}`, columns));
	}
	const footerHints =
		view.scrollTop === null
			? ["esc board", "↑↓ scroll", "q hide", "ctrl+c close"]
			: ["esc board", "↑↓ scroll", "G newest", "q hide"];
	const footer = [rule, hints(paint, footerHints, columns)];
	const bodyHeight = Math.max(1, height - header.length - footer.length);
	view.streamLength = stream.length;
	view.bodyHeight = bodyHeight;
	const maxTop = Math.max(0, stream.length - bodyHeight);
	if (view.scrollTop !== null && view.scrollTop >= maxTop) view.scrollTop = null;
	const top = view.scrollTop ?? maxTop;
	const body = stream.slice(top, top + bodyHeight);
	if (view.scrollTop !== null) {
		const newer = stream.length - (top + bodyHeight);
		if (newer > 0)
			body[body.length - 1] = cut(` ${paint.fg("scrollMarker", `↓ ${newer} newer lines · G to follow`)}`, columns);
	}
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
}

/** The interactive dashboard; resolves when the operator closes it. */
export async function runWorkersDashboard(options: WorkersDashboardOptions): Promise<number> {
	const { ProcessTerminal, TuiAltScreen, isKeyRelease, matchesKey } = await import("../engine/tui-primitives.js");
	const terminal = new ProcessTerminal();
	const tui = new TuiAltScreen(terminal);
	const paint = createBoardPaint();
	const source = options.source ?? createBoardSource();

	let request: WatchRequest | null = readWatchRequest(options.selectionPath);
	let lastSeq: string | null = null;
	let mode: "board" | "takeover" = "board";
	const boardView: BoardView = { selectedRunId: null, top: 0 };
	let takeoverView: TakeoverView | null = null;
	let board: BoardModel = { running: [], finished: [], scopedToSession: false };
	let takeover: TakeoverModel | null = null;

	const cards = (): WorkerCard[] => [...board.running, ...board.finished];

	/**
	 * `follow` arms the jump to a retry or the fleet's next step. Enter on a
	 * card that already finished inspects it and stays; a run Clio asked for
	 * by name is followed even when the request lands after it finished.
	 */
	const enterTakeover = (runId: string, follow: "always" | "when-live"): void => {
		mode = "takeover";
		boardView.selectedRunId = runId;
		takeover = loadTakeover(source, runId, Date.now());
		const live = takeover === null || isLive(takeover.card.state);
		takeoverView = {
			runId,
			scrollTop: null,
			followSuccessor: follow === "always" || live,
			streamLength: 0,
			bodyHeight: 1,
		};
	};

	const applyRequest = (): void => {
		request = readWatchRequest(options.selectionPath) ?? request;
		if (request === null || request.seq === lastSeq) return;
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
					view.runId = next;
					view.scrollTop = null;
					boardView.selectedRunId = next;
					takeover = loadTakeover(source, next, nowMs);
				}
			}
			return;
		}
		board = loadBoard(source, request, options.scope, nowMs);
		const all = cards();
		if (!all.some((card) => card.runId === boardView.selectedRunId)) boardView.selectedRunId = all[0]?.runId ?? null;
	};

	const moveSelection = (delta: number): void => {
		const all = cards();
		if (all.length === 0) return;
		const index = all.findIndex((card) => card.runId === boardView.selectedRunId);
		const next = Math.max(0, Math.min(all.length - 1, (index < 0 ? 0 : index) + delta));
		boardView.selectedRunId = all[next]?.runId ?? null;
	};

	/** Scroll by lines; reaching the newest line resumes following. */
	const scrollTakeover = (view: TakeoverView, delta: number): void => {
		const maxTop = Math.max(0, view.streamLength - view.bodyHeight);
		const next = Math.max(0, Math.min(maxTop, (view.scrollTop ?? maxTop) + delta));
		view.scrollTop = next >= maxTop ? null : next;
	};

	const view = {
		render(width: number): string[] {
			const height = Math.max(6, terminal.rows);
			const nowMs = Date.now();
			if (mode === "takeover" && takeoverView !== null) {
				return renderTakeover(paint, takeover, takeoverView, width, height, nowMs);
			}
			return renderBoard(paint, board, boardView, width, height, nowMs);
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
				else if (data === "g") open.scrollTop = 0;
				else if (data === "G") open.scrollTop = null;
				else return undefined;
				tui.requestRender();
				return { consume: true };
			}
			if (matchesKey(data, "up") || data === "k") moveSelection(-1);
			else if (matchesKey(data, "down") || data === "j") moveSelection(1);
			else if (data === "g") moveSelection(-cards().length);
			else if (data === "G") moveSelection(cards().length);
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
