import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runInstallCommand } from "../../src/cli/install.js";
import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { resetXdgCache } from "../../src/core/xdg.js";

const ORIGINAL_ENV = { ...process.env };

describe("cli uninstall", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-uninstall-"));
		process.env.CLIO_HOME = scratch;
		resetXdgCache();
		runInstallCommand();
	});

	afterEach(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, key);
		}
		for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
			if (value !== undefined) process.env[key] = value;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("full removes config, data, and cache", () => {
		const code = runUninstallCommand(["--full", "--yes"]);
		strictEqual(code, 0);
		ok(!existsSync(scratch));
	});

	it("keep-settings removes data and cache but leaves settings", () => {
		const settingsPath = join(scratch, "settings.yaml");
		const dataDir = join(scratch, "data");
		const cacheDir = join(scratch, "cache");
		const code = runUninstallCommand(["--keep-settings", "--yes"]);
		strictEqual(code, 0);
		ok(existsSync(settingsPath));
		ok(!existsSync(dataDir));
		ok(!existsSync(cacheDir));
	});

	it("reset-defaults recreates a fresh install", () => {
		const settingsPath = join(scratch, "settings.yaml");
		writeFileSync(settingsPath, "identity: changed\n", "utf8");
		const code = runUninstallCommand(["--reset-defaults", "--yes"]);
		strictEqual(code, 0);
		ok(existsSync(settingsPath));
		ok(readFileSync(settingsPath, "utf8").includes("version: 1"));
		ok(existsSync(join(scratch, "data", "install.json")));
		ok(existsSync(join(scratch, "cache")));
	});
});
