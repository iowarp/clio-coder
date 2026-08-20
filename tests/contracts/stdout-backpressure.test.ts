import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { installStdoutBackpressureGate } from "../../src/interactive/stdout-backpressure.js";

class FakeStdout extends EventEmitter {
	returns: boolean[] = [];
	writes: string[] = [];

	write = ((chunk: unknown): boolean => {
		this.writes.push(String(chunk));
		return this.returns.shift() ?? true;
	}) as typeof process.stdout.write;
}

describe("stdout backpressure gate", () => {
	it("blocks after false, releases every waiter on drain, and restores exactly once", async () => {
		const stdout = new FakeStdout();
		const original = stdout.write;
		stdout.returns.push(false, false, true);
		const gate = installStdoutBackpressureGate(stdout);
		const calls: string[] = [];

		strictEqual(stdout.write("frame-1"), false);
		strictEqual(gate.blocked, true);
		strictEqual(gate.observed, true);
		gate.onWritable(() => calls.push("listener"));
		const settled = gate.whenWritable().then(() => calls.push("promise"));
		strictEqual(stdout.write("cursor"), false, "the current frame may finish its cursor write");
		stdout.emit("drain");
		await settled;

		strictEqual(gate.blocked, false);
		deepStrictEqual(calls, ["listener", "promise"]);
		strictEqual(stdout.listenerCount("drain"), 0);
		gate.restore();
		gate.restore();
		strictEqual(stdout.write, original);
		deepStrictEqual(stdout.writes, ["frame-1", "cursor"]);
	});

	it("settles pending waiters when teardown happens before drain", async () => {
		const stdout = new FakeStdout();
		stdout.returns.push(false);
		const gate = installStdoutBackpressureGate(stdout);
		stdout.write("frame");
		const settled = gate.whenWritable();
		strictEqual(stdout.listenerCount("drain"), 1);
		gate.restore();
		await settled;
		strictEqual(gate.blocked, false);
		strictEqual(stdout.listenerCount("drain"), 0);
	});

	it("bounds a missing drain and releases the native listener", async () => {
		const stdout = new FakeStdout();
		stdout.returns.push(false);
		const gate = installStdoutBackpressureGate(stdout);
		stdout.write("stalled frame");
		strictEqual(await gate.whenWritable(5), false);
		strictEqual(stdout.listenerCount("drain"), 1, "the gate still owns one observer for later writes");
		gate.restore();
		strictEqual(stdout.listenerCount("drain"), 0);
	});
});
