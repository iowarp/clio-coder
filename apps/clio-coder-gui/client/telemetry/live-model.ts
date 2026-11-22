import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { TelemetryUpdateV1 } from "../../contracts/wire.js";

/**
 * The live hook (#434 §11.1): a telemetry_update names the topics whose reads moved, and the client answers by
 * re-reading them. Nothing is folded or patched on the client; the read model's next answer is the state. Topics
 * no GUI read shows yet (quota, health) invalidate nothing until a surface reads them.
 */
const TOPIC_READS: Record<TelemetryUpdateV1["topics"][number], readonly string[]> = {
	session: ["telemetry", "session-usage"],
	calls: ["telemetry"],
	cost: ["telemetry", "session-usage"],
	cache: ["telemetry"],
	timeline: ["telemetry"],
	runs: ["telemetry"],
	quota: [],
	health: [],
};

/** The query-key families to refresh for one session, each once, in topic order. */
export function telemetryInvalidations(update: Pick<TelemetryUpdateV1, "topics">): string[] {
	const keys: string[] = [];
	for (const topic of update.topics) for (const key of TOPIC_READS[topic] ?? []) if (!keys.includes(key)) keys.push(key);
	return keys;
}

/**
 * Changes on every settle, which is when the ledger and the accounting can have moved, and has no ceiling: the id
 * of the newest settled turn. A count of settled turns stops moving once the projection drops its oldest turns.
 */
export function settledKey(turns: SessionSnapshot["turns"]): string {
	for (let index = turns.length - 1; index >= 0; index--) {
		const turn = turns[index];
		if (turn && turn.status !== "running") return turn.id;
	}
	return "none";
}

/**
 * Whether a turn's end re-reads this cached query. The usage read is keyed by the settle key, so the finished turn
 * moves its view to a new key that reads on its own; refreshing the retired key started a read that the move aborted
 * a moment later (GET /usage net::ERR_ABORTED at every turn end).
 */
export function refreshesAtSettle(queryKey: readonly unknown[], settled: string): boolean {
	return queryKey[0] !== "session-usage" || queryKey.length < 3 || queryKey[2] === settled;
}

/** A session's telemetry reads refresh at most this often while its turn streams pushes. */
export const TELEMETRY_REFRESH_MS = 1_000;

export type TelemetryRefresh = { readonly refresh: "now" } | { readonly refresh: "defer"; readonly delayMs: number };

/**
 * Whether a session's pushed telemetry keys refresh now or wait for the rest of the interval since its last refresh.
 * `now` and `last` come from one monotonic clock; a session with no refresh yet always refreshes now.
 */
export function telemetryRefresh(
	now: number,
	last: number | undefined,
	interval = TELEMETRY_REFRESH_MS,
): TelemetryRefresh {
	if (last === undefined) return { refresh: "now" };
	const elapsed = now - last;
	// A clock that went backwards cannot prove the interval has not passed; refresh rather than stall.
	if (elapsed < 0 || elapsed >= interval) return { refresh: "now" };
	return { refresh: "defer", delayMs: interval - elapsed };
}
