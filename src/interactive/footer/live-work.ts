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
import type { BackgroundCall } from "../background-calls.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import type { AgentStatus } from "../status/index.js";
import type { ClioTheme } from "../theme/index.js";
import { formatCompactMs, formatWaitClock, GLYPH } from "../theme/index.js";
import { modelNickname } from "../theme/labels.js";
import { composerPhasePresentation } from "./widgets.js";

export interface LiveWorkFacts {
	/** The name the composer rail gives the main agent. */
	actor: string;
	status: AgentStatus;
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
const RAIL_ONLY_FACTS = / · (?:Esc cancels|Esc|then \/model switches|then \/model|\/model moves it|\/model)(?= · |$)/gu;

/** A label that already states its age (`has no output · 12s`) must not gain a second clock. */
const CARRIES_ELAPSED = /\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/u;

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
function workerSummary(facts: LiveWorkFacts, width: number, cap = width): string | null {
	const first = foregroundWorker(facts);
	if (first === undefined) return null;
	const name = sanitizeCallTargetText(first.agentId);
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
			`${sanitizeCallTargetText(second.agentId)} ${sanitizeCallTargetText(facts.workerActivity(second, SECOND_WORKER_WORDS))}`,
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

/** What Esc does in this view, and that it does not reach the run. */
function escapeNote(verb: string | null, subject: string): { long: string; short: string; tiny: string } {
	const going = `${subject} keeps going`;
	const action = verb?.startsWith("close")
		? `Esc closes this view, ${going}`
		: verb?.startsWith("back")
			? `Esc goes back, ${going}`
			: verb?.endsWith("filter")
				? `Esc clears the filter, ${going}`
				: `closing this view leaves ${subject} going`;
	return { long: action, short: going, tiny: "continues" };
}

/**
 * The line, or null when nothing is active. Candidates run from fullest to
 * leanest and the first that fits wins, so at 40 columns the phase and its
 * elapsed are what remain: identity, then the worker, then the Esc note go
 * first, and the words are never cut mid-phrase while a shorter form exists.
 */
export function liveWorkStrip(
	theme: ClioTheme,
	facts: LiveWorkFacts,
	width: number,
	escVerb: string | null,
): string | null {
	const room = Math.max(1, width);
	const mainActive = isMainActive(facts.status);
	const workers = [workerSummary(facts, room), backgroundSummary(facts, room)].filter(Boolean).join(" · ") || null;
	if (!mainActive && workers === null) return null;
	const dot = theme.fg("border", " · ");
	const note = escapeNote(
		escVerb,
		mainActive
			? facts.status.tool?.operatorShell === true
				? "the command"
				: "the run"
			: facts.workers.length > 1
				? "work"
				: facts.workers.length === 1
					? "the worker"
					: "it",
	);
	const quiet = (text: string): string => theme.fg("annotation", text);
	const render = (lead: string, parts: ReadonlyArray<string | null>): string =>
		[lead, ...parts.filter((part): part is string => part !== null).map(quiet)].join(dot);
	let candidates: string[];
	if (mainActive) {
		const phase = composerPhasePresentation(facts.status, room, facts.now);
		const glyph = theme.fg(phase.token, phase.live ? GLYPH.running : phase.glyph);
		const railFree = (text: string): string => text.replace(RAIL_ONLY_FACTS, "");
		const clockFor = (text: string): string | null => {
			if (CARRIES_ELAPSED.test(stripTerminalSequences(text))) return null;
			return formatWaitClock(phaseElapsedMs(facts.status, facts.now));
		};
		const label = railFree(phase.label);
		// Without the actor the words get the whole line, so a countdown or a command is not cut for a name no longer drawn.
		const looseLabel = railFree(composerPhasePresentation(facts.status, room, facts.now, undefined, room - 2).label);
		const clocked = (text: string): string => {
			const elapsed = clockFor(text);
			return `${glyph} ${theme.fg(phase.token, elapsed === null ? text : `${text} · ${elapsed}`)}`;
		};
		const owned = clocked(`${phase.subject ?? facts.actor} ${label}`);
		const bare = clocked(looseLabel.replace(/^is /u, ""));
		candidates = [
			render(owned, [workers, note.long]),
			...(workers === null ? [] : [render(owned, [workers, note.short]), render(bare, [workers, note.short])]),
			// A worker asking outranks the Esc note: with an overlay over its card, this row is all that says time is running.
			...(facts.workers.some((row) => row.progress?.awaitingApproval === true)
				? [
						render(bare, [workerSummary(facts, room - visibleWidth(bare) - 3)]),
						`${glyph} ${quiet(workerSummary(facts, room - 2) ?? "")}`,
					]
				: []),
			render(owned, [note.long]),
			render(owned, [note.short]),
			render(bare, [note.short]),
			render(bare, [note.tiny]),
			render(bare, []),
		];
	} else {
		const lead = `${theme.fg("activity", GLYPH.running)} ${theme.fg("activity", workers ?? "")}`;
		candidates = [render(lead, [note.long]), render(lead, [note.short]), render(lead, [note.tiny]), lead];
	}
	const fitted = candidates.find((candidate) => visibleWidth(candidate) <= room);
	return fitted ?? truncateToWidth(candidates.at(-1) ?? "", room, GLYPH.ellipsis, false);
}
