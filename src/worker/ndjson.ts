/**
 * NDJSON stdout emitter for the worker subprocess. One JSON object per line.
 *
 * The orchestrator consumes stdout line-by-line and pauses it when its own
 * evidence backlog fills, so stdout is a bounded lane here too: a frame that
 * cannot be serialized, would pass the lane's frame ceiling, would grow the
 * unwritten backlog past its bound, or fails to write leaves a gap in the
 * receipt trail. The first such failure is reported on stderr behind
 * WORKER_STDOUT_INCOMPLETE_MARKER, the run is stopped through the handler the
 * entry registers, nothing further is written, and the exit code cannot be 0.
 */

import {
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_STDOUT_BACKLOG_MAX_BYTES,
	WORKER_STDOUT_INCOMPLETE_MARKER,
} from "./protocol.js";

/** Start of the drain-timeout reason; failure classification reads it as the orchestrator falling behind (#425). */
export const WORKER_STDOUT_UNDRAINED_REASON = "stdout did not drain within";

let failure: string | null = null;
let failureHandler: ((reason: string) => void) | null = null;
let errorListenerInstalled = false;

function failOutput(reason: string): void {
	if (failure !== null) return;
	failure = reason;
	try {
		process.stderr.write(`${WORKER_STDOUT_INCOMPLETE_MARKER}${reason}\n`);
	} catch {
		// The nonzero exit code still carries the failure when stderr is gone.
	}
	failureHandler?.(reason);
}

/** Why the bulk trail is incomplete, or null while every frame was handed to stdout. */
export function stdoutFailure(): string | null {
	return failure;
}

/** Stop the run when output fails; called at once if it already failed. */
export function onStdoutFailure(handler: (reason: string) => void): void {
	failureHandler = handler;
	if (failure !== null) handler(failure);
}

export function emitEvent(event: unknown): void {
	if (failure !== null) return;
	if (!errorListenerInstalled) {
		errorListenerInstalled = true;
		// An EPIPE from a vanished reader is a lost trail, not an uncaught exception.
		process.stdout.on("error", (err) => failOutput(`stdout write failed: ${err.message}`));
	}
	let json: string | undefined;
	try {
		json = JSON.stringify(event);
	} catch (err) {
		failOutput(`an event could not be serialized: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}
	if (typeof json !== "string") {
		failOutput("an event serialized to nothing");
		return;
	}
	const line = `${json}\n`;
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes - 1 > WORKER_BULK_FRAME_MAX_BYTES) {
		failOutput(`a ${bytes} byte frame exceeds the ${WORKER_BULK_FRAME_MAX_BYTES} byte bulk lane limit`);
		return;
	}
	if (process.stdout.writableLength + bytes > WORKER_STDOUT_BACKLOG_MAX_BYTES) {
		failOutput(
			`the unwritten stdout backlog would pass ${WORKER_STDOUT_BACKLOG_MAX_BYTES} bytes (${process.stdout.writableLength} pending)`,
		);
		return;
	}
	try {
		process.stdout.write(line, (err) => {
			if (err) failOutput(`stdout write failed: ${err.message}`);
		});
	} catch (err) {
		failOutput(`stdout write failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

/**
 * Resolve once every previously queued stdout line has been handed to the OS,
 * or after timeoutMs when the pipe is wedged (reader gone or paused). Write
 * callbacks are FIFO, so an empty write's callback fires only after all
 * buffered lines flushed. Resolves true only when the whole trail was handed
 * over; a timeout records the output failure, since process.exit would drop
 * whole buffered frames with no trace on the reader's side.
 */
export function drainStdout(timeoutMs = 2000): Promise<boolean> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (drained: boolean): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			if (!drained) failOutput(`${WORKER_STDOUT_UNDRAINED_REASON} ${timeoutMs} ms`);
			resolve(failure === null);
		};
		const timer = setTimeout(() => finish(false), timeoutMs);
		try {
			process.stdout.write("", (err) => finish(!err));
		} catch {
			finish(false);
		}
	});
}

/** Exit after draining stdout; an incomplete trail turns a clean code into 1. */
export async function exitAfterDrain(code: number): Promise<never> {
	const complete = await drainStdout();
	process.exit(complete || code !== 0 ? code : 1);
}
