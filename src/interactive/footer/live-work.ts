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
	/** How the worker's current action reads on the fleet dock. */
	workerActivity: (row: DispatchBoardRow) => string;
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
const RAIL_ONLY_FACTS = / · (?:Esc cancels|Esc|then \/model switches|then \/model)(?= · |$)/gu;

/** A label that already states its age (`has no output · 12s`) must not gain a second clock. */
const CARRIES_ELAPSED = /\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/u;

function workerElapsed(row: DispatchBoardRow): string | null {
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

/** `verifier reading README.md · 12s`: which worker, what it is doing, for how long. */
function workerSummary(facts: LiveWorkFacts): string | null {
	const first = foregroundWorker(facts);
	if (first === undefined) return null;
	const name = sanitizeCallTargetText(first.agentId);
	const doing = sanitizeCallTargetText(facts.workerActivity(first));
	const elapsed = workerElapsed(first);
	// A queued run is held up and a running one is not, so `+1 more` must not stand for both.
	const rest = facts.workers.filter((row) => row !== first);
	const queued = rest.filter((row) => row.status === "enqueued").length;
	const others = rest.length - queued;
	return [`${name} ${doing}`, elapsed, others > 0 ? `+${others} more` : null, queued > 0 ? `+${queued} queued` : null]
		.filter(Boolean)
		.join(" · ");
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
	const worker = workerSummary(facts);
	const background = backgroundSummary(facts, width);
	if (worker === null && background === null) return null;
	const waiting = facts.background.some((call) => call.blocksTurn);
	const consequence = waiting ? "the turn waits" : isMainActive(facts.status) ? null : "you can send";
	// A worker the turn is blocked on reads straight after `is waiting for a worker`
	// and leads whatever else is going; the consequence goes first on a short rail.
	return [worker, background, width >= 60 ? consequence : null].filter(Boolean).join(" · ");
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
	const workers = [workerSummary(facts), backgroundSummary(facts, room)].filter(Boolean).join(" · ") || null;
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
