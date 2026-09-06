import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withWikiDispatchLifecycle } from "../../src/cli/wiki-generate.js";

describe("wiki dispatch lifecycle", { concurrency: false }, () => {
	it("releases only its own signal handlers after normal cleanup", async () => {
		const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
		const before = signals.map((signal) => process.listeners(signal));
		const events: string[] = [];
		await withWikiDispatchLifecycle(
			{
				dispatch: {
					async drain() {
						events.push("drain");
					},
				},
				async stop() {
					events.push("stop");
				},
			},
			async (signal) => {
				assert.equal(signal.aborted, false);
				for (const [index, name] of signals.entries()) {
					assert.equal(process.listeners(name).length, (before[index]?.length ?? 0) + 1);
				}
				events.push("generate");
			},
		);
		assert.deepEqual(events, ["generate", "drain", "stop"]);
		assert.deepEqual(
			signals.map((signal) => process.listeners(signal)),
			before,
		);
	});

	it("attempts domain cleanup after drain failure and preserves the drain error", async () => {
		const failure = new Error("original drain failure");
		let stopped = false;
		await assert.rejects(
			withWikiDispatchLifecycle(
				{
					dispatch: {
						async drain() {
							throw failure;
						},
					},
					async stop() {
						stopped = true;
						throw new Error("secondary stop failure");
					},
				},
				async () => {},
			),
			(error) => error === failure,
		);
		assert.equal(stopped, true);
	});

	it("preserves a generation failure when cleanup also rejects", async () => {
		const failure = new Error("original generation failure");
		const before = process.listeners("SIGTERM");
		await assert.rejects(
			withWikiDispatchLifecycle(
				{
					dispatch: {
						async drain() {
							throw new Error("secondary drain failure");
						},
					},
					async stop() {},
				},
				async () => {
					throw failure;
				},
			),
			(error) => error === failure,
		);
		assert.deepEqual(process.listeners("SIGTERM"), before);
	});
});
