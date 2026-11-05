/**
 * Stops Clio's whole process group, as a terminal-generated Ctrl+Z would, and
 * resolves once the shell continues it. Raw mode keeps the terminal from
 * sending SIGTSTP itself, so Clio sends it. Signalling only this process left
 * the shell waiting on a parent that never stopped whenever Clio ran under
 * another Node process of the same job: after /restart, the restart handoff
 * parent, or the launcher's CLIO_CODER_NODE re-exec (#413).
 *
 * Resolves true when the group was stopped and continued, false when the
 * signal was discarded because the group has no job-control shell (an
 * orphaned group, such as a process started with `exec` or under a pty proxy).
 */
export async function suspendProcessUntilContinued(): Promise<boolean> {
	let continued = false;
	let resume!: () => void;
	const settled = new Promise<void>((resolve) => {
		resume = resolve;
	});
	const onContinue = (): void => {
		continued = true;
		resume();
	};
	process.once("SIGCONT", onContinue);
	const started = performance.now();
	// SIGTSTP stops execution before the next event-loop turn. If an orphaned
	// group discards it, do not leave the terminal handed off forever (#413).
	const fallback = setImmediate(resume);
	let grace: NodeJS.Timeout | undefined;
	try {
		process.kill(0, "SIGTSTP");
		await settled;
		if (!continued) {
			// A real stop delivers SIGCONT on resume, but its handler may run after
			// this immediate; give it a moment before calling the signal discarded.
			await new Promise<void>((resolve) => {
				grace = setTimeout(resolve, 60);
			});
		}
	} finally {
		clearImmediate(fallback);
		if (grace) clearTimeout(grace);
		process.removeListener("SIGCONT", onContinue);
	}
	return continued || performance.now() - started > 250;
}
