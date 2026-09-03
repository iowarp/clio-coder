import { ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runUninstallCommand } from "../../src/cli/uninstall.js";

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
	const root = mkdtempSync(join(tmpdir(), "clio-test-uninstall-"));
	const configDir = join(root, ".config", "clio-coder");
	const dataDir = join(root, ".local", "share", "clio-coder");
	const stateDir = join(root, ".local", "state", "clio-coder");
	const cacheDir = join(root, ".cache", "clio-coder");

	mkdirSync(configDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	writeFileSync(join(configDir, "settings.yaml"), "theme: default\n", "utf8");
	writeFileSync(join(configDir, "credentials.yaml"), "{}\n", "utf8");
	writeFileSync(join(dataDir, "records.json"), "[]\n", "utf8");

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

describe("contracts/uninstall-lifecycle", () => {
	it("dry-run inventories all paths with sizes and removes nothing", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		try {
			const exitCode = await runUninstallCommand(["--dry-run"]);
			strictEqual(exitCode, 0);

			// Files must still exist after dry run
			ok(existsSync(join(tempHome.configDir, "settings.yaml")));
			ok(existsSync(join(tempHome.dataDir, "records.json")));
		} finally {
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("dry-run supports --keep-config and --keep-data flags", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		try {
			const exitCode = await runUninstallCommand(["--dry-run", "--keep-config", "--keep-data"]);
			strictEqual(exitCode, 0);
		} finally {
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("dry-run --json emits structured machine-readable output", async () => {
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
			const exitCode = await runUninstallCommand(["--dry-run", "--json"]);
			strictEqual(exitCode, 0);
			const parsed = JSON.parse(jsonOutput);
			strictEqual(parsed.command, "uninstall");
			strictEqual(parsed.status, "success");
			ok(Array.isArray(parsed.items));
			ok(parsed.items.some((i: { label: string }) => i.label === "Config"));
			ok(parsed.items.some((i: { label: string }) => i.label === "Data"));
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
			const exitCode = await runUninstallCommand([]);
			strictEqual(exitCode, 2);
		} finally {
			process.stdin.isTTY = origIsTTY;
			process.env = origEnv;
			tempHome.cleanup();
		}
	});

	it("executes uninstall with --force and respects --keep-config", async () => {
		const tempHome = setupTempHome();
		const origEnv = { ...process.env };
		Object.assign(process.env, tempHome.env);

		try {
			const exitCode = await runUninstallCommand(["--force", "--keep-config"]);
			strictEqual(exitCode, 0);

			// Config was kept
			ok(existsSync(join(tempHome.configDir, "settings.yaml")));
			// Data was removed
			ok(!existsSync(join(tempHome.dataDir, "records.json")));
		} finally {
			process.env = origEnv;
			tempHome.cleanup();
		}
	});
});
