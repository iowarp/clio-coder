/**
 * NDJSON stdout emitter for the worker subprocess. One JSON object per line.
 *
 * Failures while serializing or writing go to stderr so a single bad event does
 * not abort the run. The orchestrator consumes stdout line-by-line; stderr is a
 * separate channel for operator diagnostics.
 */
export function emitEvent(event: unknown): void {
	try {
		process.stdout.write(`${JSON.stringify(event)}\n`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[worker] failed to emit event: ${msg}\n`);
	}
}

/**
 * Resolve once every previously queued stdout line has been handed to the OS,
 * or after timeoutMs when the pipe is wedged (reader gone). Write callbacks
 * are FIFO, so an empty write's callback fires only after all buffered lines
 * flushed. A large single NDJSON line (a big tool result) can still be
 * buffered when the run settles; process.exit would truncate it mid-line.
 */
export function drainStdout(timeoutMs = 2000): Promise<void> {
	return new Promise((resolve) => {
		let done = false;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		try {
			process.stdout.write("", finish);
		} catch {
			finish();
		}
	});
}
