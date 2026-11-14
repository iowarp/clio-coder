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
 * The merged files the slices and the composition root load, in the order Node would evaluate them. The build
 * writes the list over this marker (scripts/chunk-merge.ts); a source run and a watch build keep the marker and
 * load by slice alone.
 */
const MERGED = { files: "clio:stage1-files" };

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
	// A slice is one task however many files it links: the providers slice held the loop for about 75 ms and the
	// session slice for about 170 ms. Imported one at a time, after everything it imports, a file costs only its
	// own link and evaluation, so a key typed during Stage 1 waits for one file instead of one slice.
	try {
		for (const file of MERGED.files.startsWith("clio:") ? [] : MERGED.files.split(",")) {
			await nextTurn();
			signal.throwIfAborted();
			await import(new URL(file, import.meta.url).href);
		}
	} catch (error) {
		if (signal.aborted) throw error;
		// A file that will not load fails the same way in its slice below, where the boot path reports it.
	}
	for (const slice of SLICES) {
		// The first turn also separates the Stage 0 commit's own work from the first slice.
		await nextTurn();
		signal.throwIfAborted();
		await slice();
	}
	await nextTurn();
	signal.throwIfAborted();
}
