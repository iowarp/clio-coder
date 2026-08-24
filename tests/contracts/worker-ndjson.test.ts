import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import { drainStdout } from "../../src/worker/ndjson.js";

describe("contracts/worker ndjson stdout drain", { concurrency: false }, () => {
	it("resolves for idle stdout, wedged stdout, and synchronous write failures", async () => {
		const originalWrite = process.stdout.write;

		process.stdout.write = ((_chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
			const done =
				typeof encodingOrCallback === "function"
					? encodingOrCallback
					: typeof callback === "function"
						? callback
						: undefined;
			queueMicrotask(() => done?.());
			return true;
		}) as typeof process.stdout.write;
		const startedAt = performance.now();
		try {
			await drainStdout(250);
		} finally {
			process.stdout.write = originalWrite;
		}

		ok(performance.now() - startedAt < 250, "idle stdout drain should not wait for the timeout");

		process.stdout.write = (() => true) as typeof process.stdout.write;
		const timeoutStartedAt = performance.now();
		try {
			await drainStdout(25);
		} finally {
			process.stdout.write = originalWrite;
		}

		ok(performance.now() - timeoutStartedAt >= 20, "swallowed write callback should resolve from the timeout");

		process.stdout.write = (() => {
			throw new Error("stdout closed");
		}) as typeof process.stdout.write;
		try {
			await drainStdout(250);
		} finally {
			process.stdout.write = originalWrite;
		}
	});
});
