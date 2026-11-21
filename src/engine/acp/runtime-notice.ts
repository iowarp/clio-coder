/**
 * Runtime notices over ACP (M-32). The residency, degraded-inference, memory
 * route and quota producers publish `runtime.notice_raised` on the bus, and
 * the terminal shows each one as a keyed notice. An ACP client gets the same
 * notice as `session_info_update` with `_meta["clio-coder/notice"]`, the channel
 * startup and host status lines use, once per notice key per session. A notice
 * raised before a session is bound waits for that session's next prompt, the
 * way startup hints do, so the client already holds the session id.
 */
import type { RuntimeNoticePayload } from "../../core/telemetry/live-events.js";

export interface AcpRuntimeNotice {
	level: RuntimeNoticePayload["level"];
	text: string;
	/** The terminal's notice key: `runtime-notice:<kind>:<targetId>`. */
	key: string;
}

/** Notices held while no session is bound; distinct keys, oldest kept. */
const MAX_HELD_NOTICES = 32;

const LEVELS: ReadonlySet<string> = new Set(["info", "warning", "error"]);

function readRuntimeNotice(payload: unknown): AcpRuntimeNotice | null {
	if (payload === null || typeof payload !== "object") return null;
	const notice = payload as Partial<Record<keyof RuntimeNoticePayload, unknown>>;
	if (typeof notice.kind !== "string" || typeof notice.message !== "string" || notice.message.trim().length === 0) {
		return null;
	}
	const level = typeof notice.level === "string" && LEVELS.has(notice.level) ? notice.level : "info";
	const targetId = typeof notice.targetId === "string" ? notice.targetId : "";
	return {
		level: level as AcpRuntimeNotice["level"],
		text: notice.message,
		key: `runtime-notice:${notice.kind}:${targetId}`,
	};
}

export interface AcpRuntimeNoticeRelay {
	/** One `runtime.notice_raised` payload; `sessionId` is the bound session, or null before one is bound. */
	raise(payload: unknown, sessionId: string | null): void;
	/** Sends the notices held while no session was bound. */
	flush(sessionId: string): void;
}

export function createAcpRuntimeNoticeRelay(
	send: (sessionId: string, notice: AcpRuntimeNotice) => void,
): AcpRuntimeNoticeRelay {
	const shown = new Set<string>();
	const held = new Map<string, AcpRuntimeNotice>();
	const deliver = (sessionId: string, notice: AcpRuntimeNotice): void => {
		const id = `${sessionId}\u0000${notice.key}`;
		if (shown.has(id)) return;
		shown.add(id);
		send(sessionId, notice);
	};
	return {
		raise(payload, sessionId) {
			const notice = readRuntimeNotice(payload);
			if (notice === null) return;
			if (sessionId !== null) deliver(sessionId, notice);
			else if (!held.has(notice.key) && held.size < MAX_HELD_NOTICES) held.set(notice.key, notice);
		},
		flush(sessionId) {
			const pending = [...held.values()];
			held.clear();
			for (const notice of pending) deliver(sessionId, notice);
		},
	};
}
