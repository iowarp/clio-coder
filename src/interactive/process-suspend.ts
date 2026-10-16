export async function suspendProcessUntilContinued(): Promise<void> {
	let resume!: () => void;
	const continued = new Promise<void>((resolve) => {
		resume = resolve;
	});
	process.once("SIGCONT", resume);
	// SIGTSTP stops execution before the next event-loop turn. If an orphaned
	// group discards it, do not leave the terminal handed off forever (#413).
	const fallback = setImmediate(resume);
	try {
		process.kill(process.pid, "SIGTSTP");
		await continued;
	} finally {
		clearImmediate(fallback);
		process.off("SIGCONT", resume);
	}
}
