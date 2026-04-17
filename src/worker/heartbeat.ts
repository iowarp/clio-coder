/**
 * Worker-side heartbeat emitter (Phase 6 slice 3).
 *
 * Writes a `{"type":"heartbeat"}` NDJSON event to stdout on a fixed interval
 * so the orchestrator's watchdog registers regular activity even when the
 * model is mid-thinking with no streaming output. An initial heartbeat fires
 * immediately so short runs still register at least one beat before exit.
 *
 * The interval timer is `unref`'d: it must not keep the worker process alive
 * past the agent run, and the returned stop fn is called from the worker
 * entry once `handle.promise` resolves.
 */

import { emitEvent } from "./ndjson.js";

export function startWorkerHeartbeat(intervalMs = 1000): () => void {
	emitEvent({ type: "heartbeat", at: Date.now() });
	const id = setInterval(() => emitEvent({ type: "heartbeat", at: Date.now() }), intervalMs);
	id.unref?.();
	return () => clearInterval(id);
}
