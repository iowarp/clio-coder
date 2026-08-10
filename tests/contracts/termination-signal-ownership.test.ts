import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { getTerminationCoordinator } from "../../src/core/termination.js";

/**
 * Boot arms process termination on SIGINT long before the TUI exists, so the
 * interactive Ctrl+C contract only works if the two owners hand the signal over
 * explicitly instead of both listening at once.
 */
describe("contracts/termination signal ownership", () => {
	it("hands SIGINT to a foreground owner and takes it back", () => {
		const priorInterrupt = process.listeners("SIGINT");
		const priorTerminate = process.listeners("SIGTERM");
		process.removeAllListeners("SIGINT");
		process.removeAllListeners("SIGTERM");
		try {
			const termination = getTerminationCoordinator();
			termination.installSignalHandlers();
			// Installing twice must not orphan the first handler, because the
			// coordinator now holds the reference the handover removes.
			termination.installSignalHandlers();
			strictEqual(process.listenerCount("SIGINT"), 1);
			strictEqual(process.listenerCount("SIGTERM"), 1);

			const restore = termination.releaseInterruptOwnership();
			strictEqual(process.listenerCount("SIGINT"), 0);
			// SIGTERM is never an interactive gesture, so it stays with the
			// coordinator that turns it into an ordered shutdown.
			strictEqual(process.listenerCount("SIGTERM"), 1);

			restore();
			strictEqual(process.listenerCount("SIGINT"), 1);
			restore();
			strictEqual(process.listenerCount("SIGINT"), 1);
		} finally {
			process.removeAllListeners("SIGINT");
			process.removeAllListeners("SIGTERM");
			for (const listener of priorInterrupt) process.on("SIGINT", listener as () => void);
			for (const listener of priorTerminate) process.on("SIGTERM", listener as () => void);
		}
	});
});
