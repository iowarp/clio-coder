/** The shutdown phase lives in a leaf so a domain can read it without the coordinator's render imports. */
export type TerminationPhase = "idle" | "draining" | "terminating" | "persisting" | "exiting";

let phase: TerminationPhase = "idle";

export function terminationPhase(): TerminationPhase {
	return phase;
}

export function setTerminationPhase(next: TerminationPhase): void {
	phase = next;
}
