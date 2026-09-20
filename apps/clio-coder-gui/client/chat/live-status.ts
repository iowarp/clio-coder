// The live status chip. The whole liveness signal today is the string " · Clio Coder is working…"
// appended to a status line, which tells the operator nothing during a silent five-minute run. Nine
// states are derivable from facts already on the wire, and the running tool's own Clio-reported
// title is carried as the chip's detail, so the chip is where the operator learns which command is
// running.

import type { Permission } from "../../contracts/permissions.js";
import type { Turn } from "../../contracts/sessions.js";
import type { StatusTone } from "../design/status.js";
import type { ChatTurn } from "./turns.js";

export type LiveState =
	| "starting"
	| "thinking"
	| "writing"
	| "acting"
	| "waiting"
	| "stopping"
	| "done"
	| "failed"
	| "stopped";

export interface LiveStatus {
	readonly state: LiveState;
	readonly label: string;
	readonly detail: string | null;
}

/**
 * Single-codepoint glyphs, so the chip never reflows as the state changes.
 */
export const LIVE_GLYPHS: Readonly<Record<LiveState, string>> = {
	starting: "◌",
	thinking: "◔",
	writing: "◑",
	acting: "◐",
	waiting: "!",
	stopping: "–",
	done: "✓",
	failed: "✕",
	stopped: "–",
};

/**
 * The tone is supplementary. `StatusMark` renders a glyph and a word alongside it, so the state
 * survives a greyscale screenshot.
 */
export const LIVE_TONES: Readonly<Record<LiveState, StatusTone>> = {
	starting: "unverified",
	thinking: "running",
	writing: "running",
	acting: "running",
	waiting: "warn",
	stopping: "warn",
	done: "success",
	failed: "fail",
	stopped: "neutral",
};

/** True while the turn can still change, which is what the shared one-second clock keys on. */
export const isLive = (status: LiveStatus): boolean =>
	status.state !== "done" && status.state !== "failed" && status.state !== "stopped";

/**
 * `row` is the `Turn` row for this turn, which carries the outcome; `pending` is the permission the
 * conversation is currently parked on, if any; `stopping` is the cancel mutation's own in-flight
 * flag, because the contract has no session-level cancelling phase to read.
 *
 * A running tool may carry `partialOutput`. That is a progress snapshot and never means the call
 * finished, so only `status` decides the state here.
 */
export function liveStatus(
	turn: ChatTurn,
	row: Turn | undefined,
	pending: Permission | null,
	stopping = false,
): LiveStatus {
	if (row !== undefined && row.status !== "running") {
		if (row.status === "failed") return { state: "failed", label: "Failed", detail: row.problem?.detail ?? null };
		if (row.status === "cancelled") return { state: "stopped", label: "Stopped", detail: null };
		return { state: "done", label: "Complete", detail: null };
	}
	if (turn.origin === "replay") return { state: "done", label: "Earlier record", detail: null };
	if (stopping) return { state: "stopping", label: "Stopping", detail: null };
	if (pending !== null && pending.turnId === turn.turnId)
		return { state: "waiting", label: "Waiting for your approval", detail: pending.title };
	const last = turn.items.at(-1);
	if (last === undefined || last.kind === "user") return { state: "starting", label: "Starting", detail: null };
	if (last.kind === "tool" && last.status === "in_progress")
		return { state: "acting", label: "Running", detail: last.title ?? null };
	if (last.kind === "thought") return { state: "thinking", label: "Thinking", detail: null };
	if (last.kind === "text") return { state: "writing", label: "Writing", detail: null };
	if (last.kind === "notice")
		return { state: "waiting", label: "Waiting for your approval", detail: last.title ?? null };
	return { state: "acting", label: "Working", detail: null };
}

/**
 * The placeholder for a live turn that has produced no segments yet, so the response block is never
 * a blank box while the model is still deciding what to do.
 */
export const livePlaceholder = (status: LiveStatus): string => `${status.label}…`;
