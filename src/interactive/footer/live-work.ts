/**
 * One line of what keeps running behind a surface that hides the composer rail.
 *
 * A docked overlay draws its own title and keys on the composer's rails, so a
 * run looked like it had stopped for as long as `/settings` or `/fleet` stayed
 * open (F05). The phase words come from the rail's own presentation, never a
 * second reading of the status, so the two cannot disagree when the rail
 * returns.
 */

import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { truncateToWidth, visibleWidth } from "../../engine/tui.js";
import type { BackgroundCall } from "../background-calls.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import type { AgentStatus } from "../status/index.js";
import type { ClioTheme } from "../theme/index.js";
import { formatCompactMs, GLYPH } from "../theme/index.js";
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

/** A label that already states its age (`has no output · 12s`) must not gain a second clock. */
const CARRIES_ELAPSED = /\b\d+(?:\.\d+)?(?:ms|s|m|h)\b/u;

function workerElapsed(row: DispatchBoardRow): string | null {
	const elapsed = row.telemetry?.activity.elapsed.display;
	return elapsed && elapsed !== "not available" ? elapsed : null;
}

/** `verifier reading README.md · 12s`: which worker, what it is doing, for how long. */
export function workerSummary(facts: LiveWorkFacts): string | null {
	const first = facts.workers[0];
	if (first === undefined) return null;
	const name = sanitizeCallTargetText(first.agentId);
	const doing = sanitizeCallTargetText(facts.workerActivity(first));
	const elapsed = workerElapsed(first);
	const others = facts.workers.length - 1;
	return [`${name} ${doing}`, elapsed, others > 0 ? `+${others} more` : null].filter(Boolean).join(" · ");
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
	const background = backgroundSummary(facts, width);
	if (background === null) return null;
	const waiting = facts.background.some((call) => call.blocksTurn);
	const consequence = waiting ? "the turn waits" : isMainActive(facts.status) ? null : "you can send";
	return [background, width >= 60 ? consequence : null].filter(Boolean).join(" · ");
}

/** What Esc does in this view, and that it does not reach the run. */
function escapeNote(verb: string | null, subject: string): { long: string; short: string; tiny: string } {
	const going = `${subject} keeps going`;
	const action =
		verb === "close"
			? `Esc closes this view, ${going}`
			: verb === "back"
				? `Esc goes back, ${going}`
				: verb === "clear filter"
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
	const note = escapeNote(escVerb, mainActive ? "the run" : facts.workers.length > 1 ? "work" : "the worker");
	const quiet = (text: string): string => theme.fg("annotation", text);
	const render = (lead: string, parts: ReadonlyArray<string | null>): string =>
		[lead, ...parts.filter((part): part is string => part !== null).map(quiet)].join(dot);
	let candidates: string[];
	if (mainActive) {
		const phase = composerPhasePresentation(facts.status, room, facts.now);
		const glyph = theme.fg(phase.token, phase.live ? GLYPH.running : phase.glyph);
		const elapsed = CARRIES_ELAPSED.test(phase.label) ? null : formatCompactMs(phaseElapsedMs(facts.status, facts.now));
		const clocked = (text: string): string =>
			`${glyph} ${theme.fg(phase.token, elapsed === null ? text : `${text} · ${elapsed}`)}`;
		const owned = clocked(`${facts.actor} ${phase.label}`);
		const bare = clocked(phase.label.replace(/^is /u, ""));
		candidates = [
			render(owned, [workers, note.long]),
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
