/**
 * Stage 1 module preload. Node links and evaluates a statically imported module graph in one task, so the single
 * `import()` of the composition root held the event loop for 250 to 450 ms while the Stage 0 shell was already on
 * screen and taking keys. Loading the root's largest subgraphs first, one `import()` per slice with a turn of the
 * event loop between them, splits that block: the root's own import then links only what no slice loaded.
 *
 * Slices are domain entry points and other modules outside the Stage 0 seam trees, so no new path reaches
 * src/interactive, src/session-control or src/engine from outside them. Each loads code the root loads anyway.
 */
const SLICES: ReadonlyArray<() => Promise<unknown>> = [
	// About 85 ms each on a 24-core WSL2 host: the model SDK behind the providers domain, and the session domain with
	// the dispatch and telemetry code its chunk carries.
	() => import("../domains/providers/index.js"),
	() => import("../domains/session/index.js"),
	// Each of these takes 2 to 15 ms alone once the session slice is in, so they share one turn.
	() =>
		Promise.all([
			import("../domains/telemetry/index.js"),
			import("../domains/dispatch/index.js"),
			import("../domains/memory/index.js"),
			import("../domains/context/index.js"),
			import("../domains/resources/index.js"),
			import("../domains/safety/index.js"),
			import("../tools/bootstrap.js"),
		]),
];

/**
 * Give the loop a full iteration, input poll included. One setImmediate queued from the poll phase runs in that same
 * iteration's check phase, so the next slice would follow before any keystroke was read; the second one is queued
 * from the check phase and so waits for the next iteration's poll.
 */
export async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Load the slices in order, yielding between them. A lease closed by Ctrl+C or a signal aborts at the next slice
 * boundary with the lease's own reason, which the boot path already reads as an operator stop.
 */
export async function preloadStage1(signal: AbortSignal): Promise<void> {
	for (const slice of SLICES) {
		// The first turn also separates the Stage 0 commit's own work from the first slice.
		await nextTurn();
		signal.throwIfAborted();
		await slice();
	}
	await nextTurn();
	signal.throwIfAborted();
}
