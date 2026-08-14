/**
 * Opt-in boot phase tracing. When `CLIO_CODER_TRACE_BOOT=1` each call stamps a phase
 * marker to stderr with elapsed-from-process-start; when unset every call is a
 * single env read and an early return, so there is no cost on the hot path.
 *
 * `performance.now()` in Node is measured from `performance.timeOrigin`, which
 * is the moment the process started, so it already reads as "ms since process
 * start" without a captured T0. That means the first mark also reflects the
 * module-load tax paid before any application code ran.
 *
 * The zero-code alternative for a full flame view is documented in the PR:
 *   node --cpu-prof --cpu-prof-dir=<dir> $(which clio-coder)
 * then open the .cpuprofile in Chrome DevTools or speedscope.
 */

const BOOT_TRACE_ENV = "CLIO_CODER_TRACE_BOOT";

/** True when boot tracing is enabled for this process. */
export function isBootTraceEnabled(): boolean {
	return process.env[BOOT_TRACE_ENV] === "1";
}

/**
 * Stamp a boot phase marker to stderr, e.g. `[clio:boot] +742.1ms cli entry`.
 * `detail` appends a parenthetical (module counts, ids). No-op unless
 * `CLIO_CODER_TRACE_BOOT=1`. Never throws: a diagnostic must not affect boot.
 */
export function traceBoot(phase: string, detail?: string): void {
	if (!isBootTraceEnabled()) return;
	try {
		const elapsedMs = performance.now();
		const suffix = detail !== undefined && detail.length > 0 ? ` (${detail})` : "";
		process.stderr.write(`[clio:boot] +${elapsedMs.toFixed(1)}ms ${phase}${suffix}\n`);
	} catch {
		// Tracing is best-effort; a write failure must never break boot.
	}
}
