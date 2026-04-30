import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runResetCommand } from "../../src/cli/reset.js";
import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { initializeClioHome } from "../../src/core/init.js";
import { resetXdgCache } from "../../src/core/xdg.js";

const ORIGINAL_ENV = { ...process.env };

describe("cli reset and uninstall", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-reset-"));
		process.env.CLIO_HOME = scratch;
		resetXdgCache();
		initializeClioHome();
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

	it("reset --config recreates default settings without removing credentials", () => {
		const settingsPath = join(scratch, "settings.yaml");
		const credentialsPath = join(scratch, "credentials.yaml");
		writeFileSync(settingsPath, "identity: changed\n", "utf8");
		writeFileSync(credentialsPath, "api_keys: {}\n", "utf8");

		const code = runResetCommand(["--config", "--force"]);
		strictEqual(code, 0);
		ok(readFileSync(settingsPath, "utf8").includes("targets: []"));
		ok(readFileSync(credentialsPath, "utf8").includes("api_keys"));
	});

	it("reset --auth recreates credentials without changing settings", () => {
		const settingsPath = join(scratch, "settings.yaml");
		const before = readFileSync(settingsPath, "utf8");
		const credentialsPath = join(scratch, "credentials.yaml");
		writeFileSync(credentialsPath, "api_keys:\n  openai: sk-test\n", "utf8");

		const code = runResetCommand(["--auth", "--force"]);
		strictEqual(code, 0);
		strictEqual(readFileSync(settingsPath, "utf8"), before);
		ok(readFileSync(credentialsPath, "utf8").includes("{}"));
	});

	it("reset --all recreates a fresh state tree", () => {
		const settingsPath = join(scratch, "settings.yaml");
		writeFileSync(settingsPath, "identity: changed\n", "utf8");
		const code = runResetCommand(["--all", "--force"]);
		strictEqual(code, 0);
		ok(existsSync(settingsPath));
		ok(readFileSync(settingsPath, "utf8").includes("targets: []"));
		ok(existsSync(join(scratch, "data", "install.json")));
		ok(existsSync(join(scratch, "data", "evidence")));
		ok(existsSync(join(scratch, "data", "memory")));
		ok(existsSync(join(scratch, "cache")));
	});

	it("uninstall removes selected state and keeps the binary intent separate from reset", () => {
		const code = runUninstallCommand(["--force"]);
		strictEqual(code, 0);
		ok(!existsSync(scratch));
	});

	it("uninstall --keep-config removes data and cache but leaves settings", () => {
		const settingsPath = join(scratch, "settings.yaml");
		const dataDir = join(scratch, "data");
		const cacheDir = join(scratch, "cache");
		ok(existsSync(join(dataDir, "evidence")));
		ok(existsSync(join(dataDir, "memory")));
		const code = runUninstallCommand(["--keep-config", "--force"]);
		strictEqual(code, 0);
		ok(existsSync(settingsPath));
		ok(!existsSync(dataDir));
		ok(!existsSync(cacheDir));
	});

	it("initializeClioHome creates evidence and memory data directories", () => {
		ok(existsSync(join(scratch, "data", "evidence")));
		ok(existsSync(join(scratch, "data", "memory")));
	});
});
