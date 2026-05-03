import { ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { Semaphore, TokenBucket } from "../../src/core/concurrency.js";
import { ALL_TOOL_NAMES, ToolNames } from "../../src/core/tool-names.js";

describe("core/tool-names", () => {
	it("ALL_TOOL_NAMES matches enum values", () => {
		const expected = Object.values(ToolNames).sort();
		const actual = [...ALL_TOOL_NAMES].sort();
		strictEqual(JSON.stringify(actual), JSON.stringify(expected));
	});

	it("tool names are lowercase", () => {
		for (const name of ALL_TOOL_NAMES) {
			strictEqual(name.toLowerCase(), name);
		}
	});
});

describe("core/concurrency/Semaphore", () => {
	it("rejects permits < 1", () => {
		throws(() => new Semaphore(0));
	});

	it("gates to permit count", async () => {
		const sem = new Semaphore(2);
		const r1 = await sem.acquire();
		const r2 = await sem.acquire();
		strictEqual(sem.available(), 0);
		let third = false;
		const p = sem.acquire().then((release) => {
			third = true;
			release();
		});
		// yield microtasks; third should still be pending
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(third, false);
		r1();
		await p;
		strictEqual(third, true);
		r2();
	});
});

describe("core/concurrency/TokenBucket", () => {
	it("allows take up to capacity", () => {
		const b = new TokenBucket(3, 0);
		strictEqual(b.tryTake(1), true);
		strictEqual(b.tryTake(1), true);
		strictEqual(b.tryTake(1), true);
		strictEqual(b.tryTake(1), false);
	});

	it("refills at given rate", () => {
		let now = 1_000;
		const b = new TokenBucket(2, 10, () => now);
		b.tryTake(2);
		strictEqual(b.tryTake(1), false);
		now += 200;
		strictEqual(b.tryTake(1), true);
	});
});
