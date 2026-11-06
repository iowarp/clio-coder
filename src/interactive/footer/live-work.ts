/**
 * One line of what keeps running behind a surface that hides the composer rail.
 *
 * A docked overlay draws its own title and keys on the composer's rails, so a
 * run looked like it had stopped for as long as `/settings` or `/fleet` stayed
 * open (F05). The phase words come from the rail's own presentation, never a
 * second reading of the status, so the two cannot disagree when the rail
 * returns.
 */

import { ToolNames } from "../../core/tool-names.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "../../engine/tui.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../../session-control/council.js";
import type { BackgroundCall } from "../background-calls.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import type { AgentStatus } from "../status/index.js";
import type { ClioTheme } from "../theme/index.js";
import { formatCompactMs, formatWaitClock, GLYPH } from "../theme/index.js";
import { modelNickname } from "../theme/labels.js";
import { type CompactionRailFacts, composerPhasePresentation } from "./widgets.js";

export interface LiveWorkFacts {
	/** The name the composer rail gives the main agent. */
	actor: string;
	/** The target the main turn's requests go to, by its configured name, which the rail names too. */
	target?: string;
	status: AgentStatus;
	/** The running compaction's stage and start, which the rail reads too; null or absent when none runs. */
	compaction?: CompactionRailFacts | null;
	/** Active fleet runs, helpers excluded; only the first is named. */
	workers: ReadonlyArray<DispatchBoardRow>;
	/** How the worker's current action reads on the fleet dock, in the columns its row leaves it. */
	workerActivity: (row: DispatchBoardRow, room: number) => string;
	/** Side-agent model calls in flight, from their journaled start to their settle. */
	background: ReadonlyArray<BackgroundCall>;
	now: number;
}

/** Whole seconds of the phase on screen; a tool's elapsed is its own call's, as on its card. */
function phaseElapsedMs(status: AgentStatus, now: number): number {
	const start = status.phase === "tool_running" ? (status.toolStartedAt ?? status.since) : status.since;
	return Math.max(0, now - start);
}

/** Keys the rail offers that reach nothing under a dock, which takes Esc and any typing for itself. */
const RAIL_ONLY_FACTS =
	/ · (?:Esc stops|Esc|then \/model to switch|then \/model|\/model to reroute|\/model to switch|\/model)(?= · |$)/gu;

/** A label that already states its age (`has no output · 12s`) must not gain a second clock. */
// `1m6s` is one clock too: its minutes and seconds are joined, so the pattern takes a compound form whole (B3).
const CARRIES_ELAPSED = /\b\d+(?:\.\d+)?(?:ms|s|m|h)(?:\d+(?:\.\d+)?(?:s|m))*\b/u;

function workerElapsed(row: DispatchBoardRow): string | null {
	// A plan has no run telemetry of its own; its clock is the board row's, from its start.
	if (row.plan !== undefined) return formatWaitClock(row.elapsedMs);
	const elapsed = row.telemetry?.activity.elapsed.display;
	// Whole seconds, as the rail's own phase counts them: tenths beside it read as a different clock.
	return elapsed && elapsed !== "not available" ? elapsed.replace(/\.\d+(?=s$)/u, "") : null;
}

/**
 * The worker that says the most about what is holding work up: one waiting on
 * the operator, then the main agent's own dispatch over a run the operator
 * started beside it, then a started run over a queued one.
 */
function foregroundWorker(facts: LiveWorkFacts): DispatchBoardRow | undefined {
	const asking = facts.workers.find((row) => row.progress?.awaitingApproval === true);
	if (asking !== undefined) return asking;
	const blocked = facts.status.phase === "dispatching" || facts.status.tool?.toolName === ToolNames.Dispatch;
	return (
		(blocked ? facts.workers.find((row) => row.requestOrigin === "agent") : undefined) ??
		facts.workers.find((row) => row.status !== "enqueued") ??
		facts.workers[0]
	);
}

/** A second worker on the rail says what it is doing in about this much, so it never squeezes the first. */
const SECOND_WORKER_WORDS = 28;

/** The share of a rail the work beside the phase may take by naming a second worker. */
const SECOND_WORKER_RAIL_SHARE = 0.6;
const SECOND_WORKER_MIN_RAIL = 100;

/** `verifier reading README.md · 12s`: which worker, what it is doing, for how long. */
/** A council member goes by the label the operator watches it under, as its notice does, not the recipe all share. */
function workerRailName(row: DispatchBoardRow): string {
	const council = row.council;
	if (council === undefined) return sanitizeCallTargetText(row.agentId);
	return sanitizeCallTargetText(
		council.label === COUNCIL_SYNTHESIS_LABEL ? "council synthesis" : `council member ${council.label}`,
	);
}

function workerSummary(facts: LiveWorkFacts, width: number, cap = width): string | null {
	const first = foregroundWorker(facts);
	if (first === undefined) return null;
	const name = workerRailName(first);
	const elapsed = workerElapsed(first);
	// A queued run is held up and a running one is not, so `+1 more` must not stand for both.
	const rest = facts.workers.filter((row) => row !== first);
	const queued = rest.filter((row) => row.status === "enqueued").length;
	const others = rest.length - queued;
	const trail = [elapsed, others > 0 ? `+${others} more` : null, queued > 0 ? `+${queued} queued` : null].filter(
		Boolean,
	);
	const taken = visibleWidth(name) + 1 + trail.reduce((sum, part) => sum + visibleWidth(part as string) + 3, 0);
	const doing = sanitizeCallTargetText(facts.workerActivity(first, width - taken));
	// With room, the second running worker is named too, because `+1 more` sends the reader to /fleet to learn who.
	const second = rest.find((row) => row.status !== "enqueued");
	if (second !== undefined) {
		const secondElapsed = workerElapsed(second);
		const named = [
			`${name} ${doing}`,
			elapsed,
			`${workerRailName(second)} ${sanitizeCallTargetText(facts.workerActivity(second, SECOND_WORKER_WORDS))}`,
			secondElapsed,
			others > 1 ? `+${others - 1} more` : null,
			queued > 0 ? `+${queued} queued` : null,
		]
			.filter(Boolean)
			.join(" · ");
		if (visibleWidth(named) <= cap) return named;
	}
	return [`${name} ${doing}`, ...trail].join(" · ");
}

/** `memory review on Qwopus3.8 · 3s`, shedding the route first when the room is short. */
function backgroundSummary(facts: LiveWorkFacts, width: number): string | null {
	const call = facts.background[0];
	if (call === undefined) return null;
	const elapsed = formatCompactMs(Math.max(0, facts.now - call.startedAt));
	const others = facts.background.length - 1;
	return [
		width >= 60 ? `${call.purpose} on ${modelNickname(call.model)}` : call.purpose,
		elapsed,
		others > 0 ? `+${others} more` : null,
	]
		.filter(Boolean)
		.join(" · ");
}

function isMainActive(status: AgentStatus): boolean {
	return status.phase !== "idle" && status.phase !== "ended";
}

/**
 * What runs beside the main phase, for the rail to say after it. A finished turn
 * keeps reading finished; this only adds what is still going and whether a prompt
 * can go in now, which it can unless the turn itself is waiting on this work.
 */
export function railDetail(facts: LiveWorkFacts, width: number): string | null {
	// An 80-column rail cannot hold two workers and the main phase's name and clock, and those come first.
	const worker = workerSummary(
		facts,
		width,
		width >= SECOND_WORKER_MIN_RAIL ? Math.floor(width * SECOND_WORKER_RAIL_SHARE) : 0,
	);
	const background = backgroundSummary(facts, width);
	if (worker === null && background === null) return null;
	const waiting = facts.background.some((call) => call.blocksTurn);
	const consequence = waiting ? "the turn waits" : isMainActive(facts.status) ? null : "you can send";
	// A worker the turn is blocked on reads straight after `is waiting for a worker`
	// and leads whatever else is going; the consequence goes first on a short rail.
	return [worker, background, width >= 60 ? consequence : null].filter(Boolean).join(" · ");
}

/**
 * Whether the main turn is working on its own while a card holds the rail. An ask from anyone blocks the status, so
 * the phase alone says nothing: the caller knows whether a run is streaming and whether it parked a call of its own.
 */
function mainKeepsRunning(status: AgentStatus, turn: { streaming: boolean; parked: boolean }): boolean {
	if (!turn.streaming || turn.parked || status.tool?.toolName === ToolNames.AskUser) return false;
	return status.phase !== "cancelling" && status.phase !== "dispatching" && status.tool?.toolName !== ToolNames.Dispatch;
}

/**
 * What goes on beside the card holding the rail: the card foregrounds the decision, and this says what it is not holding
 * up. Null when nothing is, or when the room cannot state it whole.
 */
export function besideCardDetail(
	facts: LiveWorkFacts,
	room: number,
	turn: { streaming: boolean; parked: boolean },
): string | null {
	const main = mainKeepsRunning(facts.status, turn) ? "the main turn keeps running" : null;
	const free = facts.workers.filter((row) => row.progress?.awaitingApproval !== true);
	const workers = free.length === 0 ? null : workerSummary({ ...facts, workers: free }, room);
	const both = main !== null && workers !== null ? `${main} · ${workers}` : null;
	return [both, workers, main].find((text) => text !== null && visibleWidth(text) <= room) ?? null;
}

/**
 * The one tail the strip gives what runs behind a view: whole or absent. Two tails, `the run keeps going` and
 * `continues`, read as two different claims depending on the width (S2). The view's own rail carries its Esc.
 */
const BEHIND_VIEW = "continues behind this view";

/**
 * The line, or null when nothing is active. Candidates run from fullest to leanest and the first that fits wins. The
 * subject is the rail's own name and stays down to the narrowest widths, because a phase with no subject cannot say
 * whose it is (S1); the worker summary, then the tail, give way first, and words are never cut mid-phrase while a
 * shorter form exists.
 */
export function liveWorkStrip(
	theme: ClioTheme,
	facts: LiveWorkFacts,
	width: number,
	_escVerb: string | null,
): string | null {
	const room = Math.max(1, width);
	const mainActive = isMainActive(facts.status);
	const workers = [workerSummary(facts, room), backgroundSummary(facts, room)].filter(Boolean).join(" · ") || null;
	if (!mainActive && workers === null) return null;
	const dot = theme.fg("separator", " · ");
	const quiet = (text: string): string => theme.fg("annotation", text);
	const render = (lead: string, parts: ReadonlyArray<string | null>): string =>
		[lead, ...parts.filter((part): part is string => part !== null).map(quiet)].join(dot);
	let candidates: string[];
	if (mainActive) {
		const compaction = facts.compaction ?? null;
		const present = (labelRoom: number) =>
			composerPhasePresentation(
				facts.status,
				room,
				facts.now,
				facts.actor,
				Math.max(10, labelRoom),
				0,
				compaction,
				facts.target,
			);
		const loose = present(room - 2);
		const subject = loose.subject ?? facts.actor;
		const glyph = theme.fg(loose.token, loose.live ? GLYPH.running : loose.glyph);
		const railFree = (text: string): string => text.replace(RAIL_ONLY_FACTS, "");
		const clocked = (text: string): string => {
			const elapsed = CARRIES_ELAPSED.test(stripTerminalSequences(text))
				? null
				: formatWaitClock(phaseElapsedMs(facts.status, facts.now));
			return theme.fg(loose.token, elapsed === null ? text : `${text} · ${elapsed}`);
		};
		// The clock the strip may add takes up to eight cells, which the words leave for it.
		const ownedLabel = railFree(present(room - 2 - visibleWidth(subject) - 1 - 8).label);
		const owned = `${glyph} ${theme.fg("activeModelIdentity", subject)} ${clocked(ownedLabel)}`;
		const bare = `${glyph} ${clocked(railFree(loose.label).replace(/^is /u, ""))}`;
		candidates = [
			render(owned, [workers, BEHIND_VIEW]),
			...(workers === null ? [] : [render(owned, [workers])]),
			// A worker asking outranks the tail: with an overlay over its card, this row is all that says time is running.
			...(facts.workers.some((row) => row.progress?.awaitingApproval === true)
				? [
						render(bare, [workerSummary(facts, room - visibleWidth(bare) - 3)]),
						`${glyph} ${quiet(workerSummary(facts, room - 2) ?? "")}`,
					]
				: []),
			render(owned, [BEHIND_VIEW]),
			render(owned, []),
			render(bare, []),
		];
	} else {
		const lead = `${theme.fg("activity", GLYPH.running)} ${theme.fg("activity", workers ?? "")}`;
		candidates = [render(lead, [BEHIND_VIEW]), lead];
	}
	const fitted = candidates.find((candidate) => visibleWidth(candidate) <= room);
	return fitted ?? truncateToWidth(candidates.at(-1) ?? "", room, GLYPH.ellipsis, false);
}
