import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { runResetCommand } from "../../src/cli/reset.js";
import { runUninstallCommand } from "../../src/cli/uninstall.js";
import { runUpgradeCommand } from "../../src/cli/upgrade.js";
import { initializeClioHome } from "../../src/core/init.js";
import { readClioVersion } from "../../src/core/package-root.js";
import { resetXdgCache } from "../../src/core/xdg.js";

const ORIGINAL_ENV = { ...process.env };

describe("cli reset and uninstall", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-reset-"));
		// Override all four env vars; CLIO_CONFIG_DIR/CLIO_DATA_DIR/CLIO_CACHE_DIR
		// take precedence over CLIO_HOME, so leaving them set from the parent
		// process leaks the test's writes into whatever sandbox the caller is in.
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
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
		const settingsPath = join(scratch, "config", "settings.yaml");
		const credentialsPath = join(scratch, "config", "credentials.yaml");
		writeFileSync(settingsPath, "identity: changed\n", "utf8");
		writeFileSync(credentialsPath, "api_keys: {}\n", "utf8");

		const code = runResetCommand(["--config", "--force"]);
		strictEqual(code, 0);
		ok(readFileSync(settingsPath, "utf8").includes("targets: []"));
		ok(readFileSync(credentialsPath, "utf8").includes("api_keys"));
	});

	it("reset --auth recreates credentials without changing settings", () => {
		const settingsPath = join(scratch, "config", "settings.yaml");
		const before = readFileSync(settingsPath, "utf8");
		const credentialsPath = join(scratch, "config", "credentials.yaml");
		writeFileSync(credentialsPath, "api_keys:\n  openai: sk-test\n", "utf8");

		const code = runResetCommand(["--auth", "--force"]);
		strictEqual(code, 0);
		strictEqual(readFileSync(settingsPath, "utf8"), before);
		ok(readFileSync(credentialsPath, "utf8").includes("{}"));
	});

	it("reset --all recreates a fresh state tree", () => {
		const settingsPath = join(scratch, "config", "settings.yaml");
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
		ok(!existsSync(join(scratch, "config")));
		ok(!existsSync(join(scratch, "data")));
		ok(!existsSync(join(scratch, "cache")));
	});

	it("uninstall --keep-config removes data and cache but leaves settings", () => {
		const settingsPath = join(scratch, "config", "settings.yaml");
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

	it("initializeClioHome refreshes stale install metadata to the current package version", () => {
		const installPath = join(scratch, "data", "install.json");
		writeFileSync(
			installPath,
			`${JSON.stringify(
				{
					version: "0.0.0",
					installedAt: "2026-01-01T00:00:00.000Z",
					platform: process.platform,
					nodeVersion: process.version,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);

		initializeClioHome();

		const parsed = JSON.parse(readFileSync(installPath, "utf8")) as { version?: string; installedAt?: string };
		strictEqual(parsed.version, readClioVersion());
		ok(parsed.installedAt !== "2026-01-01T00:00:00.000Z");
	});

	it("upgrade refreshes stale install metadata after the install and migration flow", async () => {
		const installPath = join(scratch, "data", "install.json");
		writeFileSync(
			installPath,
			`${JSON.stringify(
				{
					version: "0.0.0",
					installedAt: "2026-01-01T00:00:00.000Z",
					platform: process.platform,
					nodeVersion: process.version,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		process.env.CLIO_TEST_UPGRADE_NO_NETWORK = "1";

		const code = await runUpgradeCommand(["--skip-migrations"]);

		strictEqual(code, 0);
		const parsed = JSON.parse(readFileSync(installPath, "utf8")) as { version?: string; installedAt?: string };
		strictEqual(parsed.version, readClioVersion());
		ok(parsed.installedAt !== "2026-01-01T00:00:00.000Z");
	});

	it("upgrade post-install phase refreshes metadata under the active binary", async () => {
		const installPath = join(scratch, "data", "install.json");
		writeFileSync(
			installPath,
			`${JSON.stringify(
				{
					version: "0.0.0",
					installedAt: "2026-01-01T00:00:00.000Z",
					platform: process.platform,
					nodeVersion: process.version,
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		process.env.CLIO_TEST_UPGRADE_NO_NETWORK = "1";

		const code = await runUpgradeCommand(["--post-install", "--skip-migrations"]);

		strictEqual(code, 0);
		const parsed = JSON.parse(readFileSync(installPath, "utf8")) as { version?: string; installedAt?: string };
		strictEqual(parsed.version, readClioVersion());
		ok(parsed.installedAt !== "2026-01-01T00:00:00.000Z");
	});
});
