import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clioCacheDir, clioConfigDir, clioDataDir, resetXdgCache } from "../../src/core/xdg.js";

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
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in original)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(original)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("CLIO_HOME routes all three dirs under it", () => {
		Reflect.deleteProperty(process.env, "CLIO_DATA_DIR");
		Reflect.deleteProperty(process.env, "CLIO_CONFIG_DIR");
		Reflect.deleteProperty(process.env, "CLIO_CACHE_DIR");
		resetXdgCache();

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
