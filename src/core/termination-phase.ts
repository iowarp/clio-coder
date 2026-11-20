/** The shutdown phase lives in a leaf so a domain can read it without the coordinator's render imports. */
export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

let phase: TerminationPhase = "idle";

export function terminationPhase(): TerminationPhase {
	return phase;
}

export function setTerminationPhase(next: TerminationPhase): void {
	phase = next;
}

let runDeadline: (() => number) | null = null;

/**
 * Milliseconds left before the headless run's `--timeout` shuts this process
 * down, or null when no run deadline is armed. A tool clamps its own wait to it,
 * so no wait it starts outlives the run (XR-12).
 */
export function runDeadlineRemainingMs(): number | null {
	return runDeadline === null ? null : Math.max(0, runDeadline());
}

/** Armed by `clio-coder run --timeout` with its remaining-time reader; null disarms it once the run settles. */
export function setRunDeadline(remainingMs: (() => number) | null): void {
	runDeadline = remainingMs;
}
