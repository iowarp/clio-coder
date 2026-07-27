/**
 * Worker-side control lane writer.
 *
 * Control frames go to stderr behind the lane marker, never to stdout. A run
 * that floods stdout with tool output therefore cannot delay a heartbeat or a
 * cancellation acknowledgement behind megabytes of queued bulk frames: the two
 * lanes are separate pipes with separate kernel buffers.
 *
 * Writes are synchronous and best effort. A control frame that cannot be
 * written is not worth aborting a run over, and the orchestrator already treats
 * a missing heartbeat as a stall.
 */

import { encodeControlFrame, type WorkerControlFrame } from "./protocol.js";

export function emitControlFrame(frame: WorkerControlFrame): void {
	try {
		process.stderr.write(encodeControlFrame(frame));
	} catch {
		// The orchestrator's stall watchdog covers a wedged control lane.
	}
}
