/**
 * What keeps running behind a surface that hides the composer rail: the rail's worker detail and the live run's short
 * state on a focused surface's top rule.
 *
 * A docked overlay draws its own title and keys on the composer's rails, so a run looked like it had stopped for as
 * long as `/settings` or `/fleet` stayed open (F05). The overlay rule now says what runs; the words come from the
 * same status the rail reads, so the two cannot disagree when the rail returns.
 */

import { ToolNames } from "../../core/tool-names.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import { visibleWidth } from "../../engine/tui.js";
import { COUNCIL_SYNTHESIS_LABEL } from "../../session-control/council.js";
import type { BackgroundCall } from "../background-calls.js";
import type { OverlayRunState } from "../clio-editor.js";
import type { DispatchBoardRow } from "../dispatch-board.js";
import type { AgentStatus } from "../status/index.js";
import { formatElapsed, formatWaitClock, GLYPH } from "../theme/index.js";
import { modelNickname } from "../theme/labels.js";
import type { CompactionRailFacts } from "./widgets.js";

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
	// The phase's own start: `is writing · 23s` once carried the whole turn's time into a reply under a second old.
	const start =
		status.phase === "tool_running"
			? (status.toolStartedAt ?? status.phaseSince ?? status.since)
			: (status.phaseSince ?? status.since);
	return Math.max(0, now - start);
}

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
	const elapsed = formatElapsed(Math.max(0, facts.now - call.startedAt));
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

/** The longest command or path an overlay rule quotes after its state word; a longer one leaves the shorter form. */
const OVERLAY_OBJECT_MAX = 24;

/**
 * The main agent's own phase in the overlay rule's shortest words, or null where the main agent is waiting: on the
 * operator (the focused surface says so as its own pending state) or on workers (the rule counts them instead).
 */
function ownPhaseWords(status: AgentStatus): string | null {
	if (status.tool?.toolName === ToolNames.AskUser || status.tool?.toolName === ToolNames.Dispatch) return null;
	switch (status.phase) {
		case "preparing":
			return "preparing";
		case "waiting_model":
			return "waiting";
		case "thinking":
			return "thinking";
		case "writing":
			return "writing";
		case "tool_running":
			return status.tool?.judging === true ? "checking" : "running";
		case "retrying":
			return "retrying";
		case "compacting":
			return "compacting";
		case "stuck":
			return "no output";
		case "cancelling":
			return "stopping";
		default:
			return null;
	}
}

/**
 * What an overlay's top rule says about the live run (unit 3 of its fit contract): the state in the rail's shortest
 * words and its elapsed time, fullest form first, and the actor that may follow (unit 4). It stands in for the strip
 * under a dock and the text beside a card. Null when nothing runs. It never carries the run's Esc: while a surface is
 * focused, Esc is that surface's key.
 */
export function overlayRunState(facts: LiveWorkFacts, room: number): OverlayRunState | null {
	const { status } = facts;
	const clockOf = (ms: number): string | null => (ms < 1000 ? null : formatWaitClock(ms));
	const timed = (words: string, clock: string | null): string =>
		clock === null ? words : `${words} ${GLYPH.sep} ${clock}`;
	const own = isMainActive(status) ? ownPhaseWords(status) : null;
	if (own !== null) {
		const clock = clockOf(phaseElapsedMs(status, facts.now));
		const subject = status.phase === "tool_running" ? sanitizeCallTargetText(status.tool?.toolSubject?.trim() ?? "") : "";
		const quoted = timed(`${own} \`${subject}\``, clock);
		const stopping = status.phase === "cancelling";
		return {
			forms: [
				...(subject.length > 0 && visibleWidth(subject) <= Math.min(OVERLAY_OBJECT_MAX, room) ? [quoted] : []),
				timed(own, clock),
			],
			live: !stopping,
			glyph: stopping ? GLYPH.cancelled : GLYPH.running,
			token: stopping ? "counter" : "harnessAction",
			actor: facts.actor.length > 0 && status.tool?.operatorShell !== true ? facts.actor : null,
		};
	}
	if (facts.workers.length > 0) {
		const count = `${facts.workers.length} ${facts.workers.length === 1 ? "worker" : "workers"}`;
		const stopping = facts.workers.every((row) => row.status === "cancelling" || row.plan?.state === "cancelling");
		// A turn waiting on its dispatch is timed by that wait, as the rail times it; a run the operator started by its own.
		const awaits = status.phase === "dispatching" || status.tool?.toolName === ToolNames.Dispatch;
		const first = foregroundWorker(facts);
		const clock = awaits ? clockOf(phaseElapsedMs(status, facts.now)) : first === undefined ? null : workerElapsed(first);
		return {
			forms: [timed(stopping ? `${count} stopping` : count, clock)],
			live: !stopping,
			glyph: stopping ? GLYPH.cancelled : GLYPH.running,
			token: stopping ? "counter" : "activity",
			actor: null,
		};
	}
	const call = facts.background[0];
	if (call === undefined) return null;
	return {
		forms: [timed(call.purpose, clockOf(Math.max(0, facts.now - call.startedAt)))],
		live: true,
		glyph: GLYPH.running,
		token: "activity",
		actor: null,
	};
}
