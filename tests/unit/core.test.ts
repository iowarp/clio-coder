import { ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { Semaphore, TokenBucket } from "../../src/core/concurrency.js";
import { ALL_TOOL_NAMES, ToolNames } from "../../src/core/tool-names.js";
import { clioCacheDir, clioConfigDir, clioDataDir, resetXdgCache } from "../../src/core/xdg.js";

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

describe("core/xdg", () => {
	const original = {
		CLIO_HOME: process.env.CLIO_HOME,
		CLIO_DATA_DIR: process.env.CLIO_DATA_DIR,
		CLIO_CONFIG_DIR: process.env.CLIO_CONFIG_DIR,
		CLIO_CACHE_DIR: process.env.CLIO_CACHE_DIR,
	};
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-xdg-"));
		process.env.CLIO_HOME = scratch;
		Reflect.deleteProperty(process.env, "CLIO_DATA_DIR");
		Reflect.deleteProperty(process.env, "CLIO_CONFIG_DIR");
		Reflect.deleteProperty(process.env, "CLIO_CACHE_DIR");
		resetXdgCache();
	});

	afterEach(() => {
		for (const [k, v] of Object.entries(original)) {
			if (v === undefined) Reflect.deleteProperty(process.env, k);
			else process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("CLIO_HOME routes all three dirs under it", () => {
		ok(clioDataDir().startsWith(scratch));
		ok(clioConfigDir().startsWith(scratch));
		ok(clioCacheDir().startsWith(scratch));
	});

	it("individual overrides take precedence over CLIO_HOME", () => {
		const customData = join(scratch, "custom-data");
		process.env.CLIO_DATA_DIR = customData;
		resetXdgCache();
		strictEqual(clioDataDir(), customData);
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

	it("refills at given rate", async () => {
		const b = new TokenBucket(2, 1000);
		b.tryTake(2);
		strictEqual(b.tryTake(1), false);
		await new Promise((resolve) => setTimeout(resolve, 15));
		strictEqual(b.tryTake(1), true);
	});
});
