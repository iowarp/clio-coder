/**
 * Live readouts for an opted-in ACP client: the yolo posture and window, the live rate, the armed skills and the
 * provider retry, as one closed frame per session on `_clio-coder/session/readouts`. Every text is the terminal's own,
 * built by the shared helpers with the engine's choices for the parts the terminal styles. Pure but for `send`; the
 * clock is injected, so the throttle is deterministic and holds no timer.
 */

import type { AutonomyLevel, YoloConfinement } from "../../domains/safety/autonomy.js";
import { autonomyModeReadout, autonomyWindowReadout } from "../../domains/safety/autonomy-readout.js";
import type { AutonomyStatus } from "../../domains/safety/autonomy-window.js";
import { sanitizeCallTargetText } from "../../domains/safety/call-target.js";
import {
	createAssistantGenerationTiming,
	liveThroughput,
	tokensPerSecondText,
} from "../../session-control/assistant-generation-timing.js";
import { retryStatusText } from "../../session-control/retry-status-text.js";
import type { RetryStatusPayload } from "../../session-control/turn-recovery.js";
import { hasAssistantGenerationDelta } from "../generation-delta.js";
import type { AcpReadouts, AcpReadoutsNotification } from "./types.js";
import { ACP_READOUTS_MIN_INTERVAL_MS } from "./types.js";

/** The yolo containment the host runs under: the confinement setting and whether an OS sandbox backs the shell. */
export interface AcpAutonomyPosture {
	confinement: YoloConfinement;
	osSandbox: boolean;
}

/** The session a frame is for, as the server holds it. */
export interface AcpReadoutsSession {
	id: string;
	autonomy: AutonomyLevel;
	/** It holds the running prompt, so the chat's autonomy window is this session's own. */
	holdsPrompt: boolean;
}

export interface AcpReadoutsEmitterOptions {
	now(): number;
	send(params: AcpReadoutsNotification): void;
	autonomyPosture?: () => AcpAutonomyPosture;
	autonomyStatus?: () => AutonomyStatus | null;
	activeSkillSurface?: () => ReadonlyArray<string>;
}

export interface AcpReadoutsEmitter {
	/** Records one chat event; a trigger sends a frame for `session` when there is one to send to. */
	chatEvent(event: unknown, session: AcpReadoutsSession | null): void;
	/** A frame for a session just opened, loaded, resumed or switched to another mode. */
	publish(session: AcpReadoutsSession): void;
	/** The turn's closing frame, with no rate and no retry. It skips the interval, never the dedupe. */
	turnEnd(session: AcpReadoutsSession): void;
}

type RetryReadout = NonNullable<AcpReadouts["retry"]>;
type AutonomyWindowFrame = NonNullable<NonNullable<AcpReadouts["autonomy"]>["window"]>;

const TRIGGERS: ReadonlySet<string> = new Set([
	"agent_start",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_end",
	"retry_status",
]);
const RETRY_PHASES: ReadonlySet<string> = new Set([
	"scheduled",
	"waiting",
	"retrying",
	"moved",
	"cancelled",
	"exhausted",
	"recovered",
]);
const SETTLED_RETRY_PHASES: ReadonlySet<string> = new Set(["cancelled", "exhausted", "recovered"]);
const MAX_SKILLS = 16;
const DOT = "·";
const ELLIPSIS = "…";

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** At most `max` UTF-16 units, closing on `…` when cut, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max - 1;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end)}${ELLIPSIS}`;
}

function isRetryStatus(value: unknown): value is RetryStatusPayload {
	const status = record(value);
	return (
		status !== null &&
		typeof status.phase === "string" &&
		RETRY_PHASES.has(status.phase) &&
		typeof status.attempt === "number" &&
		typeof status.maxAttempts === "number"
	);
}

function windowFrame(status: AutonomyStatus): AutonomyWindowFrame | null {
	const readout = autonomyWindowReadout(status, { narrow: false, dot: DOT, resumeHint: "a new message continues" });
	if (readout === null) return null;
	const detail = status.halted ? sanitizeCallTargetText(status.halted.detail).replace(/\.+$/u, "") : "";
	return {
		display: cut(readout.text, 128),
		tone: readout.tone,
		halted: readout.halted,
		...(status.halted
			? { haltDetail: cut(`yolo paused: ${detail}. A new message continues with a fresh window.`, 512) }
			: {}),
	};
}

export function createAcpReadoutsEmitter(options: AcpReadoutsEmitterOptions): AcpReadoutsEmitter {
	const timing = createAssistantGenerationTiming();
	let sequence = 0;
	let live = false;
	let flowing = false;
	let retry: RetryReadout | null = null;
	const sessions = new Map<
		string,
		{ last: AcpReadouts | null; lastJson: string | null; lastSentAt: number; window: AutonomyStatus | null }
	>();
	const stateFor = (id: string) => {
		let state = sessions.get(id);
		if (state === undefined) {
			state = { last: null, lastJson: null, lastSentAt: 0, window: null };
			sessions.set(id, state);
		}
		return state;
	};

	const autonomy = (session: AcpReadoutsSession, state: { window: AutonomyStatus | null }): AcpReadouts["autonomy"] => {
		if (session.autonomy !== "yolo") {
			state.window = null;
			return null;
		}
		// The chat resolves its window from the ACP session only while that session's prompt runs; between
		// prompts the last one read stands.
		if (session.holdsPrompt && options.autonomyStatus !== undefined) state.window = options.autonomyStatus();
		const posture = options.autonomyPosture?.();
		if (posture === undefined) return null;
		const mode = autonomyModeReadout({ ...posture, narrow: false, dot: DOT });
		return {
			level: "yolo",
			confinement: posture.confinement,
			osSandbox: posture.osSandbox,
			label: cut(mode.text, 64),
			tone: mode.tone,
			window: state.window === null ? null : windowFrame(state.window),
		};
	};

	const throughput = (at: number): AcpReadouts["throughput"] => {
		if (!live) return null;
		const snapshot = liveThroughput(timing, at);
		if (snapshot === null || !Number.isFinite(snapshot.tokensPerSecond) || snapshot.tokensPerSecond <= 0) return null;
		const estimated = snapshot.estimated === true;
		const rate = tokensPerSecondText(snapshot.tokensPerSecond, estimated);
		return { display: cut(`${flowing ? "" : "last "}${rate} tok/s`, 32), estimated, flowing };
	};

	const skills = (): AcpReadouts["skills"] => {
		const names = (options.activeSkillSurface?.() ?? [])
			.slice(0, MAX_SKILLS)
			.map((name) => cut(sanitizeCallTargetText(name), 64))
			.filter((name) => name.length > 0);
		return names.length === 0 ? null : { names, display: cut(`skill ${names.join(", ")}`, 256) };
	};

	const emit = (session: AcpReadoutsSession, closing: boolean): void => {
		const at = options.now();
		const state = stateFor(session.id);
		const readouts: AcpReadouts = {
			autonomy: autonomy(session, state),
			throughput: closing ? null : throughput(at),
			skills: skills(),
			retry: closing ? null : retry,
		};
		const json = JSON.stringify(readouts);
		if (json === state.lastJson) return;
		const previous = state.last?.throughput;
		// A frame that only moves the rate waits out the interval; any other change goes at once.
		if (
			!closing &&
			previous &&
			readouts.throughput &&
			at - state.lastSentAt < ACP_READOUTS_MIN_INTERVAL_MS &&
			JSON.stringify({ ...readouts, throughput: { ...readouts.throughput, display: previous.display } }) === state.lastJson
		)
			return;
		sequence += 1;
		state.last = readouts;
		state.lastJson = json;
		state.lastSentAt = at;
		options.send({ version: 1, sessionId: session.id, sequence, readouts });
	};

	return {
		chatEvent(event, session) {
			const fields = record(event);
			if (fields === null || typeof fields.type !== "string") return;
			const type = fields.type;
			timing.record(fields as Parameters<typeof timing.record>[0], options.now());
			const assistant = record(fields.message)?.role === "assistant";
			if (type === "agent_start") {
				live = true;
				flowing = false;
			} else if (type === "agent_end") {
				live = false;
				flowing = false;
			} else if (type === "message_update" && hasAssistantGenerationDelta(fields.assistantMessageEvent)) {
				flowing = true;
			} else if (type === "tool_execution_start" || type === "message_end") {
				flowing = false;
			} else if (type === "message_start" && assistant && retry !== null && !retry.active) {
				retry = null;
			} else if (type === "retry_status" && isRetryStatus(fields.status)) {
				const { errorMessage: _withheld, ...status } = fields.status;
				retry = {
					phase: status.phase,
					active: !SETTLED_RETRY_PHASES.has(status.phase),
					display: cut(retryStatusText(status, { modelName: sanitizeCallTargetText }), 512),
				};
			}
			if (session !== null && TRIGGERS.has(type)) emit(session, false);
		},
		publish(session) {
			emit(session, false);
		},
		turnEnd(session) {
			retry = null;
			emit(session, true);
		},
	};
}
