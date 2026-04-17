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
