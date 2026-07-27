/**
 * Worker-side heartbeat emitter.
 *
 * Beats ride the stderr control lane on a fixed interval so the orchestrator's
 * watchdog registers activity even when the model is mid-thinking with no
 * streaming output, and so a saturated bulk stdout queue can never starve them.
 * An initial beat fires immediately, so short runs still register once before
 * exit.
 *
 * The interval timer is `unref`'d: it must not keep the worker process alive
 * past the agent run, and the returned stop fn is called from the worker
 * entry once `handle.promise` resolves.
 */

import { emitControlFrame } from "./control-lane.js";

export function startWorkerHeartbeat(intervalMs = 1000): () => void {
	emitControlFrame({ kind: "heartbeat", at: Date.now() });
	const id = setInterval(() => emitControlFrame({ kind: "heartbeat", at: Date.now() }), intervalMs);
	id.unref?.();
	return () => clearInterval(id);
}
