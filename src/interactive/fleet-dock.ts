import { tierPolicy } from "../core/presentation-tier.js";
import {
	compareRuns,
	type RunApprovalFacts,
	type RunCell,
	type RunFacts,
	type RunIntegrity,
	type RunOrigin,
	type RunTelemetryFacts,
	type RunValidation,
	runCountBuckets,
	runCountRow,
	runIdentityWidth,
	runRow,
} from "../core/run-row.js";
import { workerFailureHeadline } from "../domains/dispatch/failure-headline.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";
import type { TaskBoardSnapshot } from "../domains/session/task-board.js";
import { taskBoardCounts } from "../domains/session/task-board.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { isHelperRun } from "../session-control/worker-stream.js";
import type { DispatchBoardRow } from "./dispatch-board.js";
import { taskBoardValue } from "./footer/widgets.js";
import { actionKeyLabel } from "./keybinding-manager.js";
import type { VariantRail } from "./rails-budget.js";
import { clioTheme, formatCount, formatElapsed, GLYPH, keyCap } from "./theme/index.js";
import {
	approvalWaitWords,
	compactQuantity,
	dockedWorkerApprovalRun,
	workerActionParts,
	workerActivityWords,
} from "./worker-activity.js";

export interface FleetDockDeps {
	getRows: () => ReadonlyArray<DispatchBoardRow>;
	/**
	 * Every run this session, settled ones included. A failed run is no longer live, yet the dock keeps it until the
	 * operator acknowledges it by opening Fleet Runs: a failure is never hidden (6.4).
	 */
	getSettledRows?: () => ReadonlyArray<DispatchBoardRow>;
	/** Bound to TaskBoardStore.cachedSnapshot; a repaint must never fold the session ledger. */
	getTaskBoard?: () => TaskBoardSnapshot | null;
	/** The expanded footer carries the board's own rows, so the tasks strip steps aside. */
	isFooterExpanded?: () => boolean;
	/** Fleet Runs is open and already shows every run, so the dock steps aside rather than repeat one. */
	isFleetBoardOpen?: () => boolean;
	/** Terminal height: the dock's variants and its own cap are set in physical rows of it. */
	getTerminalRows?: () => number;
	/**
	 * The main agent's turn is live. While it is, a run the model started is on the dispatch card at the transcript's
	 * live tail, so a dock of only such runs would say it twice.
	 */
	isMainTurnLive?: () => boolean;
}

/** Under this many terminal rows the dock has no row at all; the top rail names the count. */
const DOCK_SUMMARY_MIN_ROWS = 16;
/** From this many terminal rows the dock may list its runs under a titled rule. */
const DOCK_ROWS_MIN_ROWS = 30;
/** Fill the titled rule keeps between its title and its counts. */
const RULE_MIN_FILL = 3;
const FLEET_KEY_ACTION = "clio-coder.dispatchBoard.toggle";

/**
 * The task board's strip: its progress and the task that needs the operator next, and from standard the board's
 * title. It replaced a top-right overlay that painted over transcript words, so it takes a row of its own above the
 * composer instead.
 */
function taskBoardStrip(board: TaskBoardSnapshot, width: number, titled: boolean): string | null {
	const counts = taskBoardCounts(board);
	if (counts.open === 0 || width < 1) return null;
	const theme = clioTheme();
	const blocked = board.tasks.find((task) => task.status === "blocked");
	const next =
		board.tasks.find((task) => task.status === "active") ?? board.tasks.find((task) => task.status === "pending");
	const separator = theme.fg("annotation", ` ${GLYPH.sep} `);
	const focus = blocked
		? `${theme.fg("warning", GLYPH.phaseBlocked)} ${theme.fg("annotation", blocked.id)} ${theme.fg("body", sanitizeCallTargetText(blocked.title))}`
		: next
			? `${theme.fg(next.status === "active" ? "activity" : "annotation", next.status === "active" ? GLYPH.running : GLYPH.queued)} ${theme.fg("annotation", next.id)} ${theme.fg("body", sanitizeCallTargetText(next.title))}`
			: null;
	const lead = [
		theme.style("sectionHeading", "Tasks", { bold: true }),
		...(titled ? [theme.fg("body", sanitizeCallTargetText(board.title))] : []),
		taskBoardValue(theme, board),
	].join(separator);
	const hint = theme.fg("commandHint", "/tasks");
	const room = Math.max(1, width - 2);
	const withHint = [lead, ...(focus ? [focus] : []), hint].join(separator);
	const row = visibleWidth(withHint) <= room ? withHint : [lead, ...(focus ? [focus] : [])].join(separator);
	return `  ${truncateToWidth(row, room, GLYPH.ellipsis, false)}`;
}

function isTerminal(row: DispatchBoardRow): boolean {
	return row.status === "completed" || row.status === "failed" || row.status === "aborted" || row.status === "dead";
}

/** A settled run whose state is `✗`: it failed, or it exited with a failed check or a compromised record (2.7). */
function settledFailure(row: DispatchBoardRow): boolean {
	if (row.status === "failed" || row.status === "dead") return true;
	return row.status === "completed" && (validationOf(row) === "failed" || integrityOf(row) === "compromised");
}

/**
 * The runs the dock counts: a running plan already names the steps it is running, so the workers those steps started
 * are its own and not more work beside it. A step's worker waiting on the operator stays, because that wait is the
 * part that blocks the plan.
 */
function dockRuns(rows: ReadonlyArray<DispatchBoardRow>): DispatchBoardRow[] {
	const planLive = rows.some((row) => row.plan !== undefined && !isTerminal(row));
	if (!planLive) return [...rows];
	return rows.filter(
		(row) => row.plan !== undefined || row.phase === undefined || row.progress?.awaitingApproval === true,
	);
}

function originOf(row: DispatchBoardRow): RunOrigin {
	switch (row.requestOrigin) {
		case "agent":
			return "model";
		case "internal":
		case "harness":
			return "harness";
		default:
			return "operator";
	}
}

/** The record's integrity from the sealed receipt's trust projection; absent reads as unverified. */
function integrityOf(row: DispatchBoardRow): RunIntegrity {
	const state = row.trust?.axes.artifactIntegrity;
	return state === "verified" ? "verified" : state === "failed" ? "compromised" : "unverified";
}

/** The validation verdict: a host rejection or a named validator failure is a failed check, whatever the exit said. */
function validationOf(row: DispatchBoardRow): RunValidation {
	if (row.hostVerification === "rejected" || row.validationFailure !== undefined) return "failed";
	switch (row.trust?.axes.validationGrounding) {
		case "validated":
			return "passed";
		case "failed":
			return "failed";
		case "ungrounded":
			return "self-reported";
		case "absent":
			return "none";
		default:
			return "unknown";
	}
}

/** A read-model count in the shared row form, its qualifier kept: `≥15,208` reads `≥15.2k`. */
function tokenWords(row: DispatchBoardRow): string | undefined {
	const display = row.telemetry?.row.tokens.display ?? (row.usage.kind === "ready" ? row.usage.total.display : null);
	const figure = display === null ? null : compactQuantity(display);
	if (figure === null) return undefined;
	const match = /^(≥|≈|~|>=)?\s*(\d[\d,]*(?:\.\d+)?)$/u.exec(figure);
	const value = Number(match?.[2]?.replaceAll(",", ""));
	return `${match === null || !Number.isFinite(value) ? figure : `${match[1] ?? ""}${formatCount(value)}`} tokens`;
}

/** The telemetry row under a run: route, calls, tokens, then its last call while live or its reference once settled. */
function telemetryOf(row: DispatchBoardRow): RunTelemetryFacts {
	const route = [row.targetId, row.wireModelId].filter((part) => part !== "-" && part.length > 0);
	const calls = row.progress?.toolCalls ?? row.completion?.toolCalls;
	const tokens = tokenWords(row);
	const last = row.progress?.recentActions[0];
	const lastWords =
		last === undefined
			? undefined
			: (() => {
					const parts = workerActionParts(last, "finished");
					return sanitizeCallTargetText(parts.object.length === 0 ? parts.verb : `${parts.verb} ${parts.object}`);
				})();
	return {
		...(route.length > 0 ? { route: sanitizeCallTargetText(route.join(` ${GLYPH.sep} `)) } : {}),
		...(calls === undefined ? {} : { calls }),
		...(tokens === undefined ? {} : { tokens }),
		...(isTerminal(row)
			? { reference: `/view dispatch:${row.runId}` }
			: lastWords === undefined
				? {}
				: { lastAction: lastWords }),
	};
}

function approvalOf(row: DispatchBoardRow, now: number): RunApprovalFacts | undefined {
	const progress = row.progress;
	if (progress?.awaitingApproval !== true) return undefined;
	const window = progress.approvalWindow;
	return {
		decider: window?.decider ?? "operator",
		...(window?.owner !== undefined ? { owner: window.owner } : {}),
		words: (room) => approvalWaitWords(progress, { now, room, ownerFirst: true }),
		...(dockedWorkerApprovalRun() === row.runId ? { cardDocked: true } : {}),
	};
}

/** What a live run is doing, in the words the top rail and the board use for it. */
function livePhase(row: DispatchBoardRow): string | undefined {
	if (row.plan !== undefined) return undefined;
	if (row.status === "retrying") return row.retry ? `retrying · attempt ${row.retry.attempt}` : "retrying";
	if (row.progress === undefined) return "starting";
	return workerActivityWords(row.progress, { room: 40, history: row.routeFirstOutput ?? null });
}

/** A board row as run-row facts: outcome from its status, validation and integrity from its sealed trust record. */
function runFactsOf(row: DispatchBoardRow, now: number, telemetry: boolean): RunFacts {
	const task = row.taskSummary === undefined ? undefined : sanitizeCallTargetText(row.taskSummary);
	const base = {
		agent: sanitizeCallTargetText(row.plan !== undefined ? `plan ${row.plan.name}` : (row.council?.label ?? row.agentId)),
		origin: originOf(row),
		...(isHelperRun(row) && row.council === undefined ? { helper: true } : {}),
		runId: row.runId,
		elapsed: formatElapsed(row.elapsedMs),
		startedAt: now - row.elapsedMs,
		...(task === undefined ? {} : { task }),
		...(telemetry ? { telemetry: telemetryOf(row) } : {}),
	};
	const reason = workerFailureHeadline(row.outcomeDetail?.replace(/^dispatch:\s*/u, "") ?? null) ?? undefined;
	switch (row.status) {
		case "enqueued":
			return {
				...base,
				outcome: "queued",
				phase: row.endpoint
					? `waiting for a slot ${GLYPH.sep} ${sanitizeCallTargetText(row.endpoint.label)}`
					: "waiting for a slot",
			};
		case "cancelling":
			return { ...base, outcome: "cancelled", reason: "stopping" };
		case "aborted":
			return { ...base, outcome: "cancelled", ...(reason === undefined ? {} : { reason }) };
		case "failed":
		case "dead":
			return { ...base, outcome: "failed", ...(reason === undefined ? {} : { reason }) };
		case "completed":
			return {
				...base,
				outcome: "succeeded",
				validation: validationOf(row),
				integrity: integrityOf(row),
				...(row.validationFailure === undefined ? {} : { reason: sanitizeCallTargetText(row.validationFailure) }),
			};
		default: {
			const approval = approvalOf(row, now);
			const phase = livePhase(row);
			return {
				...base,
				outcome: "running",
				...(phase === undefined ? {} : { phase }),
				...(approval === undefined ? {} : { approval }),
			};
		}
	}
}

/** Paint run-row cells: each cell's lead, then its glyph and text in its role. */
function paintCells(cells: readonly RunCell[]): string {
	const theme = clioTheme();
	let out = "";
	for (const cell of cells) {
		const body = `${cell.glyph === undefined ? "" : GLYPH[cell.glyph]}${cell.text}`;
		out += `${cell.lead}${body.length === 0 ? "" : theme.fg(cell.role, body)}`;
	}
	return out;
}

function fleetKey(): string {
	return actionKeyLabel(FLEET_KEY_ACTION) ?? "Alt+W";
}

/** Glyph and text cells measured as the count row measures them: each glyph one cell. */
function plainWidth(cells: readonly RunCell[]): number {
	let width = 0;
	for (const cell of cells) width += cell.lead.length + (cell.glyph === undefined ? 0 : 1) + cell.text.length;
	return width;
}

/** Whether `kept` holds every count that never shrinks (failed, waiting, unverified, cancelled) that `all` holds. */
function keepsAdverse(kept: readonly RunCell[], all: readonly RunCell[]): boolean {
	const adverse = (cells: readonly RunCell[]) =>
		cells.filter((cell) => cell.glyph === "error" || cell.glyph === "phaseBlocked" || cell.glyph === "warn").length;
	return adverse(kept) >= adverse(all);
}

/**
 * The one-row dock: the counts worst first, cut from the right, and the key cap at the right edge. The cap gives up
 * its `fleet` word before a count that never shrinks is cut.
 */
function summaryRow(facts: readonly RunFacts[], width: number): string {
	const theme = clioTheme();
	const buckets = runCountBuckets(facts);
	const key = fleetKey();
	const all = runCountRow(buckets, Number.POSITIVE_INFINITY);
	const forms = [
		{ cap: `${keyCap(theme, key)} ${theme.fg("keyboardHint", "fleet")}`, cells: visibleWidth(`[${key}] fleet`) },
		{ cap: keyCap(theme, key), cells: visibleWidth(`[${key}]`) },
	];
	for (const [index, form] of forms.entries()) {
		const counts = runCountRow(buckets, width - form.cells - 2);
		if (counts.length === 0) continue;
		if (index < forms.length - 1 && !keepsAdverse(counts, all)) continue;
		const gap = Math.max(2, width - plainWidth(counts) - form.cells);
		return `${paintCells(counts)}${" ".repeat(gap)}${form.cap}`;
	}
	return truncateToWidth(paintCells(runCountRow(buckets, width)), width, GLYPH.ellipsis, false);
}

/** `Fleet ───✗ 1 failed · ● 2 running · [Alt+W] ─`: the light titled rule counting every run, listed or not. */
function titledRule(facts: readonly RunFacts[], width: number): string {
	const theme = clioTheme();
	const key = keyCap(theme, fleetKey());
	const keyCells = visibleWidth(key);
	const title = `${theme.style("sectionHeading", "Fleet", { bold: true })} `;
	const tail = ` ${theme.fg("divider", GLYPH.rule)}`;
	const sep = theme.fg("separator", ` ${GLYPH.sep} `);
	const room = width - visibleWidth(title) - RULE_MIN_FILL - keyCells - 3 - visibleWidth(tail);
	const counts = room > 0 ? runCountRow(runCountBuckets(facts), room) : [];
	const meta = counts.length > 0 ? `${paintCells(counts)}${sep}${key}` : key;
	const fill = width - visibleWidth(title) - visibleWidth(meta) - visibleWidth(tail);
	if (fill < 1) return truncateToWidth(`${title}${meta}`, width, GLYPH.ellipsis, false);
	return `${title}${theme.fg("divider", GLYPH.rule.repeat(fill))}${meta}${tail}`;
}

/** One row per listed run, and with `telemetry` its telemetry row under it; never a cut reason's continuation. */
function runRows(rows: readonly DispatchBoardRow[], now: number, width: number, telemetry: boolean): string[] {
	const facts = rows.map((row) => runFactsOf(row, now, telemetry));
	const identityWidth = runIdentityWidth(facts, visibleWidth);
	return facts.flatMap((fact) => {
		const layout = runRow(fact, { width, identityWidth, measure: visibleWidth, rail: false });
		return [paintCells(layout.cells), ...(telemetry ? [paintCells(layout.telemetry ?? [])] : [])];
	});
}

/** The dock with its variants, largest first, for the rails budget to grant whole. */
export type FleetDock = VariantRail;

/**
 * The fleet dock above the composer (6.4): whole variants in physical rows, largest first. Detailed lists its runs
 * with their telemetry rows only when every listed run fits with them; standard and detailed list runs under a
 * titled rule from 30 terminal rows; every tier keeps the one summary row from 16. Among the live islands the order
 * of claim is the steering queue, the dock summary, the tasks strip, then the dock rows, so every variant that lists
 * runs carries the strip.
 */
export function createFleetDock(deps: FleetDockDeps): FleetDock {
	/** Failed runs the operator has seen on Fleet Runs; the dock stops carrying them. */
	const acknowledged = new Set<string>();
	/** The live runs, then every failed run this session the operator has not acknowledged. */
	const dockFeed = (boardOpen: boolean): ReadonlyArray<DispatchBoardRow> => {
		const live = deps.getRows();
		const failed = (deps.getSettledRows?.() ?? []).filter(settledFailure);
		if (boardOpen) for (const row of failed) acknowledged.add(row.runId);
		const listed = new Set(live.map((row) => row.runId));
		const kept = failed.filter((row) => !acknowledged.has(row.runId) && !listed.has(row.runId));
		return kept.length === 0 ? live : [...live, ...kept];
	};
	const variants = (width: number): string[][] => {
		const safe = Math.max(1, Math.floor(width));
		const terminalRows = deps.getTerminalRows?.() ?? 40;
		const policy = tierPolicy();
		const board = deps.isFooterExpanded?.() === true ? null : (deps.getTaskBoard?.() ?? null);
		const strip =
			board && terminalRows >= DOCK_SUMMARY_MIN_ROWS ? taskBoardStrip(board, safe, policy.dockRuns > 0) : null;
		const withStrip = (lines: string[]): string[] => (strip === null ? lines : [...lines, strip]);
		const boardOpen = deps.isFleetBoardOpen?.() === true;
		const rows = dockRuns(dockFeed(boardOpen));
		const modelOnly = rows.every((row) => row.requestOrigin === "agent");
		const hidden =
			rows.length === 0 ||
			boardOpen ||
			(modelOnly && deps.isMainTurnLive?.() === true) ||
			terminalRows < DOCK_SUMMARY_MIN_ROWS;
		if (hidden) return strip === null ? [[]] : [[strip], []];
		const now = Date.now();
		const ordered = rows
			.map((row) => ({ row, facts: runFactsOf(row, now, false) }))
			.sort((a, b) => compareRuns(a.facts, b.facts));
		const facts = ordered.map((entry) => entry.facts);
		const out: string[][] = [];
		const cap = Math.floor(terminalRows / 6);
		const listed = Math.min(policy.dockRuns, ordered.length, cap - 1);
		if (terminalRows >= DOCK_ROWS_MIN_ROWS && listed > 0) {
			const head = titledRule(facts, safe);
			const shown = ordered.slice(0, listed).map((entry) => entry.row);
			if (policy.runSubRows > 0 && 1 + 2 * listed <= cap) out.push(withStrip([head, ...runRows(shown, now, safe, true)]));
			out.push(withStrip([head, ...runRows(shown, now, safe, false)]));
		}
		const summary = summaryRow(facts, safe);
		if (strip !== null) out.push([summary, strip]);
		out.push([summary], []);
		return out;
	};
	return {
		render(width) {
			return variants(width)[0] ?? [];
		},
		renderVariants: variants,
		invalidate() {},
	};
}
