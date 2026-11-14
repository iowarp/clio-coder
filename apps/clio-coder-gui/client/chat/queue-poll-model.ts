import type { QueueSnapshot } from "../../contracts/steering.js";

/** How often an agent without queue push is asked for its queue. */
export const QUEUE_POLL_MS = 3_000;

/**
 * The queue read's polling interval, or false. An agent with the queue capability pushes every change, so it is never
 * asked. An older one is asked only while something can move the queue on its own: a running turn, or entries still
 * waiting to land. An idle, empty queue changes only through this window, whose own writes re-read it.
 */
export function queuePollInterval(
	readable: boolean,
	pushes: boolean,
	running: boolean,
	snapshot: QueueSnapshot | undefined,
): number | false {
	if (!readable || pushes) return false;
	if (running) return QUEUE_POLL_MS;
	const waiting = (snapshot?.steer.length ?? 0) + (snapshot?.followUp.length ?? 0) + (snapshot?.entries?.length ?? 0);
	return waiting > 0 ? QUEUE_POLL_MS : false;
}
