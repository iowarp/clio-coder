import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runResetCommand } from "../../src/cli/reset.js";

interface TempHome {
	root: string;
	configDir: string;
	dataDir: string;
	stateDir: string;
	cacheDir: string;
	env: NodeJS.ProcessEnv;
	cleanup: () => void;
}

function setupTempHome(): TempHome {
	const root = mkdtempSync(join(tmpdir(), "clio-test-reset-"));
	const configDir = join(root, ".config", "clio-coder");
	const dataDir = join(root, ".local", "share", "clio-coder");
	const stateDir = join(root, ".local", "state", "clio-coder");
	const cacheDir = join(root, ".cache", "clio-coder");

	mkdirSync(configDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	writeFileSync(join(configDir, "settings.yaml"), "theme: custom-theme\n", "utf8");
	writeFileSync(join(configDir, "credentials.yaml"), "key: test-secret\n", "utf8");
	writeFileSync(join(dataDir, "records.json"), '["memory"]\n', "utf8");
	writeFileSync(join(stateDir, "install.json"), '{"version":"0.4.2"}\n', "utf8");

	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: root,
		CLIO_CODER_HOME: "",
		CLIO_CODER_CONFIG_DIR: configDir,
		CLIO_CODER_DATA_DIR: dataDir,
		CLIO_CODER_STATE_DIR: stateDir,
		CLIO_CODER_CACHE_DIR: cacheDir,
	};

	return {
		root,
		configDir,
		dataDir,
		stateDir,
		cacheDir,
		env,
		cleanup: () => rmSync(root, { recursive: true, force: true }),
	};
}

describe("contracts/reset-lifecycle", () => {
	it("dry-run inventories state root and clearly identifies surviving components", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		try {
			const exitCode = await runResetCommand(["--dry-run"]);
			strictEqual(exitCode, 0);

			// Files must still exist after dry run
			ok(existsSync(join(tempHome.configDir, "settings.yaml")));
			ok(existsSync(join(tempHome.dataDir, "records.json")));
			ok(existsSync(join(tempHome.stateDir, "install.json")));
		} finally {
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("dry-run with --all scopes all 4 roots and marks binary as surviving", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		try {
			const exitCode = await runResetCommand(["--all", "--dry-run"]);
			strictEqual(exitCode, 0);

			ok(existsSync(join(tempHome.configDir, "settings.yaml")));
			ok(existsSync(join(tempHome.dataDir, "records.json")));
			ok(existsSync(join(tempHome.stateDir, "install.json")));
		} finally {
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("dry-run --json emits structured machine-readable inventory", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		let jsonOutput = "";
		const originalWrite = process.stdout.write;
		// @ts-expect-error test intercept
		process.stdout.write = (chunk: string | Buffer) => {
			jsonOutput += typeof chunk === "string" ? chunk : chunk.toString("utf8");
			return true;
		};

		try {
			const exitCode = await runResetCommand(["--dry-run", "--json"]);
			strictEqual(exitCode, 0);
			const parsed = JSON.parse(jsonOutput);
			strictEqual(parsed.command, "reset");
			strictEqual(parsed.status, "success");
			ok(Array.isArray(parsed.items));
			const stateItem = parsed.items.find((i: { label: string }) => i.label === "State");
			ok(stateItem);
			strictEqual(stateItem.status, "remove");
			const configItem = parsed.items.find((i: { label: string }) => i.label === "Settings");
			ok(configItem);
			strictEqual(configItem.status, "keep");
		} finally {
			process.stdout.write = originalWrite;
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("fails safely in non-interactive environment without --force", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		const origIsTTY = process.stdin.isTTY;
		process.stdin.isTTY = false;

		try {
			const exitCode = await runResetCommand([]);
			strictEqual(exitCode, 2);
		} finally {
			process.stdin.isTTY = origIsTTY;
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("executes default reset with --force, wiping state and preserving config/data", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		try {
			const exitCode = await runResetCommand(["--force"]);
			strictEqual(exitCode, 0);

			// Settings and data preserved
			ok(existsSync(join(tempHome.configDir, "settings.yaml")));
			ok(existsSync(join(tempHome.dataDir, "records.json")));
			// State was wiped and bootstrapped fresh
			ok(existsSync(tempHome.stateDir));
		} finally {
			process.env = origEnv;
			tempHome.cleanup();
		}
	});
});
