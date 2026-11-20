/** The shutdown phase lives in a leaf so a domain can read it without the coordinator's render imports. */
export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

let phase: TerminationPhase = "idle";

export function terminationPhase(): TerminationPhase {
	return phase;
}

export function setTerminationPhase(next: TerminationPhase): void {
	phase = next;
}

let runDeadline: number | null = null;

/**
 * The `performance.now()` instant at which the headless run's `--timeout` shuts
 * this process down, or null when no run deadline is armed. A tool arms its own
 * wait against it when the wait starts, so no wait outlives the run (XR-12).
 */
export function runDeadlineAt(): number | null {
	return runDeadline;
}

/** Armed by `clio-coder run --timeout` with its deadline instant; null disarms it once the run settles. */
export function setRunDeadline(at: number | null): void {
	runDeadline = at;
}
