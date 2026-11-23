/**
 * The run row: one grammar for a dispatched run on every surface (dispatch card, worker card, fleet dock, Fleet Runs
 * board, the workers pane, `/usage` Workers).
 *
 *     <state> <identity> <elapsed>  <words> · <activity or reason> · <task>
 *
 * Pure layout: run facts and a width go in, ordered cells come out, each with its text, a role name from
 * `theme-roles.ts` and a glyph name from the shared glyph table. Callers paint the cells, so the TUI and the pane
 * process, which cannot import `src/interactive`, lay a run out the same way.
 *
 * Quantities arrive already formatted (elapsed per `formatElapsed`, tokens per the count form) and wording that has
 * an owner arrives from it (the approval words of `approvalWaitWords`, the phase words, the failure reason), so this
 * module decides only what shows, in what order, and where a row is cut. Cell width is the caller's terminal
 * measure, the same `visibleWidth` both painters use.
 */

import type { SemanticRole } from "./theme-roles.js";

/** Glyph names from the shared glyph table; each is one cell wide in Unicode and ASCII mode. */
export type RunGlyph =
	| "error"
	| "warn"
	| "phaseBlocked"
	| "cancelled"
	| "queued"
	| "running"
	| "ok"
	| "workerHuman"
	| "workerAgent"
	| "workerInternal"
	| "subProcess"
	| "sep"
	| "ellipsis"
	| "rail";

/** The state kinds of the status table, worst first in {@link runSortRank} order. */
export type RunStateKind = "pending" | "error" | "warning" | "running" | "queued" | "cancelled" | "done";

/** What the worker process did. `blocked` and `guarded` stopped on a policy or a guard, which is a failure here. */
export type RunOutcome = "queued" | "running" | "succeeded" | "failed" | "blocked" | "guarded" | "cancelled";

/** The validation verdict. `self-reported` passed only on the worker's own report; `none` means no check ran. */
export type RunValidation = "passed" | "failed" | "self-reported" | "none" | "unknown";

/** The integrity of the run's record. Absent on a settled run reads as `unverified`. */
export type RunIntegrity = "verified" | "unverified" | "compromised";

/** Who started the run: the operator (`◇`), the model (`◆`), or CLIO Coder for itself (`·`). */
export type RunOrigin = "operator" | "model" | "harness";

/** A live ask on the run, read from the one deadline record the approval card reads. */
export interface RunApprovalFacts {
	/** Who the ask waits on now. Only an operator wait owned by this session is the run's state. */
	decider: "operator" | "main" | "judge";
	/** The session that owns the ask when it is not this one; no key here answers it. */
	owner?: string;
	/** The owner's wording fitted to `room` cells (`approvalWaitWords(progress, { room })`). */
	words: (room: number) => string;
	/** This session has the ask's card docked, so `[Enter] on the card` answers it. */
	cardDocked?: boolean;
}

/** Telemetry for the sub-line, in the order it prints: target and model, calls, tokens, last action. */
export interface RunTelemetryFacts {
	/** `copilot · gpt-6-luna`. */
	route?: string;
	calls?: number;
	/** Formatted by the caller, qualifier and unit included: `≥10.8k tokens`. */
	tokens?: string;
	/** The last action's words: `read src/stats.py`. */
	lastAction?: string;
	/** The trust record's word once settled: `grounded`, `not trusted`. */
	record?: string;
	/** A reference the sub-line ends with and never cuts: `/view dispatch:<run>`. */
	reference?: string;
}

export interface RunFacts {
	agent: string;
	origin: RunOrigin;
	/** A helper CLIO Coder runs for the model (`↳`). */
	helper?: boolean;
	outcome: RunOutcome;
	validation?: RunValidation;
	integrity?: RunIntegrity;
	/** The live or queued phase words: `waiting on the model`, `waiting for a slot · 3/4 copilot`. */
	phase?: string;
	task?: string;
	/** Why the run failed, was blocked or guarded, or was cancelled. It replaces the task. */
	reason?: string;
	approval?: RunApprovalFacts;
	/** Formatted elapsed time, at most 6 cells. Not shown while queued. */
	elapsed?: string;
	/** Epoch milliseconds; oldest first inside a sort group. */
	startedAt?: number;
	/** Names the run in the `/view dispatch:<run>` reference a continued failure reason ends with. */
	runId?: string;
	/** Present when the surface shows the telemetry sub-line (detailed). */
	telemetry?: RunTelemetryFacts;
}

export type RunCellSlot =
	| "state"
	| "origin"
	| "helper"
	| "agent"
	| "elapsed"
	| "phase"
	| "task"
	| "reason"
	| "trust"
	| "approval"
	| "key"
	| "sep"
	| "ellipsis"
	| "rail"
	| "route"
	| "calls"
	| "tokens"
	| "lastAction"
	| "record"
	| "reference";

/**
 * One painted unit. A painter prints `lead` unpainted, then the glyph `glyph` names (if any) followed by `text`, both
 * in `role`.
 */
export interface RunCell {
	slot: RunCellSlot;
	lead: string;
	glyph?: RunGlyph;
	text: string;
	role: SemanticRole;
}

export interface RunState {
	kind: RunStateKind;
	glyph: RunGlyph;
	role: SemanticRole;
	/** The state word, always present: `failed`, `unverified`, `needs approval`, `running`, `done`. */
	word: string;
}

export interface RunRowLayout {
	state: RunState;
	/** The run row, never wider than the width asked. */
	cells: RunCell[];
	/** A failure reason too long for the row continues here, ending with `/view dispatch:<run>`. */
	continuation: RunCell[] | null;
	/** The telemetry sub-line when the facts carry telemetry. */
	telemetry: RunCell[] | null;
}

/** Terminal cell width of plain text; callers pass `visibleWidth`. */
export type CellMeasure = (text: string) => number;

export interface RunRowOptions {
	/** Cells the row may paint. */
	width: number;
	/** The identity column of the list, from {@link runIdentityWidth}. */
	identityWidth: number;
	measure: CellMeasure;
	/** Under this many cells the elapsed column drops (default 32, the pane's floor). */
	elapsedFloor?: number;
	/** Break a failure reason too long for the row onto a continuation sub-line instead of cutting it. */
	continueReason?: boolean;
	/** Hang sub-lines on the `│` rail; without it they indent by the same 4 cells. */
	rail?: boolean;
}

const ELAPSED_CELLS = 6;
const SEPARATOR_CELLS = 3;
const DEFAULT_ELAPSED_FLOOR = 32;
const CARD_KEY = "[Enter] on the card";

const STATE_GLYPH: Readonly<Record<RunStateKind, RunGlyph>> = {
	pending: "phaseBlocked",
	error: "error",
	warning: "warn",
	running: "running",
	queued: "queued",
	cancelled: "cancelled",
	done: "ok",
};

const STATE_ROLE: Readonly<Record<RunStateKind, SemanticRole>> = {
	pending: "attention",
	error: "error",
	warning: "warning",
	running: "guidance",
	queued: "annotation",
	cancelled: "annotation",
	done: "success",
};

const SORT_RANK: Readonly<Record<RunStateKind, number>> = {
	pending: 0,
	error: 1,
	warning: 2,
	running: 3,
	queued: 4,
	cancelled: 5,
	done: 6,
};

const ORIGIN_GLYPH: Readonly<Record<RunOrigin, RunGlyph>> = {
	operator: "workerHuman",
	model: "workerAgent",
	harness: "workerInternal",
};

/** The ask is the run's state only when it waits on this session's operator. */
function waitsOnOperator(approval: RunApprovalFacts | undefined): approval is RunApprovalFacts {
	return approval !== undefined && approval.decider === "operator" && approval.owner === undefined;
}

/** The adverse trust word of a run that exited successfully, or null when its record and checks stand. */
function adverseWord(facts: RunFacts): string | null {
	if ((facts.integrity ?? "unverified") === "unverified") return "unverified";
	if (facts.validation === "self-reported") return "self-reported";
	return null;
}

/**
 * Outcome, validation and integrity together; the worst wins. A successful exit is `done` only when validation did
 * not fail and the record is verified. No check ran is not adverse.
 */
function runState(facts: RunFacts): RunState {
	const state = (kind: RunStateKind, word: string): RunState => ({
		kind,
		glyph: STATE_GLYPH[kind],
		role: STATE_ROLE[kind],
		word,
	});
	switch (facts.outcome) {
		case "queued":
			return state("queued", "queued");
		case "running":
			return waitsOnOperator(facts.approval) ? state("pending", "needs approval") : state("running", "running");
		case "cancelled":
			return state("cancelled", "cancelled");
		case "failed":
		case "blocked":
		case "guarded":
			return state("error", facts.outcome);
		case "succeeded": {
			if (facts.validation === "failed" || facts.integrity === "compromised") return state("error", "failed");
			const adverse = adverseWord(facts);
			return adverse === null ? state("done", "done") : state("warning", adverse);
		}
	}
}

/** Lower sorts first: waiting on the operator, failed, warning, running, queued, cancelled, done. */
export function runSortRank(facts: RunFacts): number {
	return SORT_RANK[runState(facts).kind];
}

/** {@link runSortRank}, then oldest first inside a group; a run with no start time sorts last in its group. */
export function compareRuns(a: RunFacts, b: RunFacts): number {
	const rank = runSortRank(a) - runSortRank(b);
	if (rank !== 0) return rank;
	return (a.startedAt ?? Number.POSITIVE_INFINITY) - (b.startedAt ?? Number.POSITIVE_INFINITY);
}

/** Cells the identity's marks take before the agent name: the origin glyph and a space, and `↳ ` for a helper. */
function identityMarks(facts: RunFacts): number {
	return facts.helper === true ? 4 : 2;
}

/** The one fixed identity column of a list: origin glyph, `↳` for a helper, the widest agent name. */
export function runIdentityWidth(runs: readonly RunFacts[], measure: CellMeasure): number {
	let widest = 0;
	for (const run of runs) widest = Math.max(widest, identityMarks(run) + measure(run.agent));
	return widest;
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The longest prefix of `text`, by whole graphemes, no wider than `room` cells. */
function clipText(text: string, room: number, measure: CellMeasure): string {
	if (room <= 0) return "";
	let out = "";
	let used = 0;
	for (const { segment } of GRAPHEMES.segment(text)) {
		const width = measure(segment);
		if (used + width > room) break;
		out += segment;
		used += width;
	}
	return out;
}

function cellWidth(cell: RunCell, measure: CellMeasure): number {
	return measure(cell.lead) + (cell.glyph === undefined ? 0 : 1) + measure(cell.text);
}

function cellsWidth(cells: readonly RunCell[], measure: CellMeasure): number {
	let width = 0;
	for (const cell of cells) width += cellWidth(cell, measure);
	return width;
}

function sepCell(): RunCell {
	return { slot: "sep", lead: " ", glyph: "sep", text: "", role: "separator" };
}

interface TextUnit {
	slot: RunCellSlot;
	text: string;
	role: SemanticRole;
}

/** Units joined by ` · `, each unit's lead the space after the separator. */
function joinUnits(units: readonly TextUnit[]): RunCell[] {
	const cells: RunCell[] = [];
	for (const unit of units) {
		if (unit.text.length === 0) continue;
		if (cells.length > 0) cells.push(sepCell());
		cells.push({ slot: unit.slot, lead: cells.length > 0 ? " " : "", text: unit.text, role: unit.role });
	}
	return cells;
}

/** Cut a cell list at `room` cells and end it with `…`; a separator never sits before the mark. */
function clipCells(cells: readonly RunCell[], room: number, measure: CellMeasure): RunCell[] {
	if (cellsWidth(cells, measure) <= room) return [...cells];
	if (room <= 0) return [];
	const out: RunCell[] = [];
	let used = 0;
	let cutRole: SemanticRole = "body";
	for (const cell of cells) {
		const width = cellWidth(cell, measure);
		cutRole = cell.role;
		if (used + width <= room - 1) {
			out.push(cell);
			used += width;
			continue;
		}
		if (cell.slot !== "sep") {
			const fixed = measure(cell.lead) + (cell.glyph === undefined ? 0 : 1);
			const text = clipText(cell.text, room - 1 - used - fixed, measure);
			if (text.length > 0) out.push({ ...cell, text });
		}
		break;
	}
	while (out.length > 0 && out[out.length - 1]?.slot === "sep") out.pop();
	out.push({ slot: "ellipsis", lead: "", glyph: "ellipsis", text: "", role: cutRole });
	return out;
}

/** Fit units to `room` and keep `tail` whole at the end when it fits beside at least one cell of them. */
function fitWithTail(
	units: readonly TextUnit[],
	tail: TextUnit | undefined,
	room: number,
	measure: CellMeasure,
): RunCell[] {
	const body = joinUnits(units);
	if (tail === undefined || tail.text.length === 0) return clipCells(body, room, measure);
	const tailWidth = SEPARATOR_CELLS + measure(tail.text);
	if (body.length === 0) return clipCells(joinUnits([tail]), room, measure);
	if (room - tailWidth < 2) return clipCells(body, room, measure);
	const fitted = clipCells(body, room - tailWidth, measure);
	return [...fitted, sepCell(), { slot: tail.slot, lead: " ", text: tail.text, role: tail.role }];
}

/** Clause boundaries a reason breaks at, strongest first. */
const REASON_BREAKS = ["; ", " · ", ", ", " "] as const;

/** The longest head of `reason` ending at a clause boundary that fits `room`, and the rest. */
function breakReason(reason: string, room: number, measure: CellMeasure): { head: string; rest: string } | null {
	for (const mark of REASON_BREAKS) {
		let at = reason.lastIndexOf(mark);
		while (at > 0) {
			const head = reason.slice(0, at);
			if (measure(head) <= room) return { head, rest: reason.slice(at + mark.length) };
			at = reason.lastIndexOf(mark, at - 1);
		}
	}
	return null;
}

/** The row's text units for its state (6.1): phase then task, approval words, trust word then task, or the reason. */
function textUnits(
	facts: RunFacts,
	state: RunState,
	room: number,
	measure: CellMeasure,
): { units: TextUnit[]; tail?: TextUnit } {
	const task: TextUnit = { slot: "task", text: facts.task ?? "", role: "body" };
	const phase: TextUnit = { slot: "phase", text: facts.phase ?? "", role: "activity" };
	if (facts.outcome === "running" && facts.approval !== undefined) {
		const approval = facts.approval;
		const key: TextUnit | undefined =
			waitsOnOperator(approval) && approval.cardDocked === true
				? { slot: "key", text: CARD_KEY, role: "keyboardHint" }
				: undefined;
		const keyWidth = key === undefined ? 0 : SEPARATOR_CELLS + measure(key.text);
		const withKey = key !== undefined && room - keyWidth > 0 ? approval.words(room - keyWidth) : null;
		if (key !== undefined && withKey !== null && measure(withKey) + keyWidth <= room)
			return { units: [{ slot: "approval", text: withKey, role: "attention" }], tail: key };
		return { units: [{ slot: "approval", text: approval.words(room), role: "attention" }] };
	}
	switch (state.kind) {
		case "error":
			return { units: [{ slot: "reason", text: facts.reason ?? state.word, role: "error" }] };
		case "cancelled":
			return { units: facts.reason !== undefined ? [{ slot: "reason", text: facts.reason, role: "annotation" }] : [task] };
		case "warning":
			return { units: [{ slot: "trust", text: state.word, role: "warning" }, task] };
		case "queued":
			return { units: [facts.phase !== undefined ? phase : task] };
		case "running":
		case "pending":
			return { units: [phase, task] };
		case "done":
			return { units: [task] };
	}
}

/** The sub-line's lead: a rail two cells in from the row, or the same indent without it. */
function subLineLead(rail: boolean, error: boolean): RunCell[] {
	if (!rail) return [{ slot: "rail", lead: "    ", text: "", role: "gutter" }];
	return [{ slot: "rail", lead: "  ", glyph: "rail", text: " ", role: error ? "error" : "gutter" }];
}

function telemetryLine(
	telemetry: RunTelemetryFacts,
	width: number,
	rail: boolean,
	error: boolean,
	measure: CellMeasure,
): RunCell[] {
	const lead = subLineLead(rail, error);
	const room = width - cellsWidth(lead, measure);
	const calls = telemetry.calls === undefined ? "" : `${telemetry.calls} ${telemetry.calls === 1 ? "call" : "calls"}`;
	const units: TextUnit[] = [
		{ slot: "route", text: telemetry.route ?? "", role: "metadata" },
		{ slot: "calls", text: calls, role: "metadata" },
		{ slot: "tokens", text: telemetry.tokens ?? "", role: "metadata" },
		{
			slot: "lastAction",
			text: telemetry.lastAction === undefined ? "" : `last: ${telemetry.lastAction}`,
			role: "metadata",
		},
		{ slot: "record", text: telemetry.record === undefined ? "" : `record: ${telemetry.record}`, role: "metadata" },
	];
	const tail: TextUnit | undefined =
		telemetry.reference === undefined ? undefined : { slot: "reference", text: telemetry.reference, role: "metadata" };
	return [...lead, ...fitWithTail(units, tail, room, measure)];
}

/**
 * Lay out one run row at `width` cells, its continued failure reason and its telemetry sub-line. Every returned line
 * is at most `width` cells; text is cut at the row end with `…`.
 */
export function runRow(facts: RunFacts, options: RunRowOptions): RunRowLayout {
	const { measure } = options;
	const width = Math.max(1, Math.floor(options.width));
	const state = runState(facts);
	const cells: RunCell[] = [{ slot: "state", lead: "", glyph: state.glyph, text: "", role: state.role }];

	// Identity: origin, helper mark, agent name, padded to the list's column and never past the row.
	const identityColumn = Math.max(0, Math.min(options.identityWidth, width - 2));
	const marks = identityMarks(facts);
	cells.push({ slot: "origin", lead: " ", glyph: ORIGIN_GLYPH[facts.origin], text: "", role: "annotation" });
	if (facts.helper === true)
		cells.push({ slot: "helper", lead: " ", glyph: "subProcess", text: "", role: "annotation" });
	const agent = clipText(facts.agent, Math.max(0, Math.max(identityColumn, marks) - marks), measure);
	cells.push({ slot: "agent", lead: " ", text: agent, role: "workerIdentity" });
	const pad = " ".repeat(Math.max(0, identityColumn - marks - measure(agent)));

	const showElapsed = width >= (options.elapsedFloor ?? DEFAULT_ELAPSED_FLOOR);
	if (showElapsed) {
		const elapsed = state.kind === "queued" ? "" : clipText(facts.elapsed ?? "", ELAPSED_CELLS, measure);
		const blank = " ".repeat(ELAPSED_CELLS - measure(elapsed));
		cells.push({ slot: "elapsed", lead: `${pad} ${blank}`, text: elapsed, role: "metadata" });
	}
	const textLead = showElapsed ? "  " : `${pad}  `;
	const room = width - cellsWidth(cells, measure) - textLead.length;

	let continuation: RunCell[] | null = null;
	if (room > 0) {
		const { units, tail } = textUnits(facts, state, room, measure);
		const reason = units[0]?.slot === "reason" ? units[0].text : undefined;
		const broken =
			options.continueReason === true && reason !== undefined && measure(reason) > room
				? breakReason(reason, room, measure)
				: null;
		const text =
			broken === null
				? fitWithTail(units, tail, room, measure)
				: fitWithTail([{ slot: "reason", text: broken.head, role: "error" }], undefined, room, measure);
		if (text.length > 0) {
			const first = text[0] as RunCell;
			text[0] = { ...first, lead: textLead + first.lead };
			cells.push(...text);
		}
		if (broken !== null) {
			const lead = subLineLead(options.rail ?? true, true);
			const reference = facts.runId === undefined ? undefined : `/view dispatch:${facts.runId}`;
			const rest = fitWithTail(
				[{ slot: "reason", text: broken.rest, role: "error" }],
				reference === undefined ? undefined : { slot: "reference", text: reference, role: "metadata" },
				width - cellsWidth(lead, measure),
				measure,
			);
			continuation = [...lead, ...rest];
		}
	}
	const telemetry =
		facts.telemetry === undefined
			? null
			: telemetryLine(facts.telemetry, width, options.rail ?? true, state.kind === "error", measure);
	return { state, cells, continuation, telemetry };
}

/** Counts in the bucket order every count row uses, worst first. A successful exit with an adverse verdict is never `ok`. */
export interface RunCountBuckets {
	failed: number;
	waiting: number;
	unverified: number;
	running: number;
	queued: number;
	cancelled: number;
	ok: number;
}

const BUCKET_OF: Readonly<Record<RunStateKind, keyof RunCountBuckets>> = {
	error: "failed",
	pending: "waiting",
	warning: "unverified",
	running: "running",
	queued: "queued",
	cancelled: "cancelled",
	done: "ok",
};

export function runCountBuckets(runs: readonly RunFacts[]): RunCountBuckets {
	const buckets: RunCountBuckets = { failed: 0, waiting: 0, unverified: 0, running: 0, queued: 0, cancelled: 0, ok: 0 };
	for (const run of runs) buckets[BUCKET_OF[runState(run).kind]] += 1;
	return buckets;
}

const BUCKET_ORDER: ReadonlyArray<{
	key: keyof RunCountBuckets;
	glyph: RunGlyph;
	role: SemanticRole;
	/** Running, queued and done may shrink to glyph and count; failed, waiting and adverse keep their word. */
	shrinks: boolean;
}> = [
	{ key: "failed", glyph: "error", role: "error", shrinks: false },
	{ key: "waiting", glyph: "phaseBlocked", role: "attention", shrinks: false },
	{ key: "unverified", glyph: "warn", role: "warning", shrinks: false },
	{ key: "running", glyph: "running", role: "guidance", shrinks: true },
	{ key: "queued", glyph: "queued", role: "annotation", shrinks: true },
	{ key: "cancelled", glyph: "cancelled", role: "annotation", shrinks: false },
	{ key: "ok", glyph: "ok", role: "success", shrinks: true },
];

/**
 * The count row, worst first, cut from the right so the reassuring count goes first: a row keeps as many buckets as
 * fit, shortening running, queued and ok to glyph and count from the right before it drops a bucket. Empty when not
 * even the worst bucket fits.
 */
export function runCountRow(buckets: RunCountBuckets, width: number): RunCell[] {
	const units = BUCKET_ORDER.filter((unit) => buckets[unit.key] > 0).map((unit) => ({
		...unit,
		full: ` ${buckets[unit.key]} ${unit.key}`,
		short: ` ${buckets[unit.key]}`,
	}));
	const build = (kept: typeof units, shortFrom: number): RunCell[] =>
		kept.flatMap((unit, index) => {
			const text = unit.shrinks && index >= shortFrom ? unit.short : unit.full;
			const cell: RunCell = { slot: "state", lead: index > 0 ? " " : "", glyph: unit.glyph, text, role: unit.role };
			return index > 0 ? [sepCell(), cell] : [cell];
		});
	const plainWidth = (cells: readonly RunCell[]): number => cellsWidth(cells, (text) => text.length);
	for (let count = units.length; count > 0; count--) {
		const kept = units.slice(0, count);
		for (let shortFrom = count; shortFrom >= 0; shortFrom--) {
			const cells = build(kept, shortFrom);
			if (plainWidth(cells) <= width) return cells;
		}
	}
	return [];
}
