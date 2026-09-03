import { match, ok, strictEqual } from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { runUpgradeCommand } from "../../src/cli/upgrade.js";
import { resetXdgCache } from "../../src/core/xdg.js";
import { getVersionInfo } from "../../src/domains/lifecycle/version.js";

function isolatedEnv(): {
	root: string;
	stateDir: string;
	env: Record<string, string>;
	cleanup: () => void;
} {
	const rand = Math.random().toString(36).slice(2, 8);
	const root = join(tmpdir(), `clio-test-upgrade-${rand}`);
	const configDir = join(root, ".config", "clio-coder");
	const dataDir = join(root, ".local", "share", "clio-coder");
	const stateDir = join(root, ".local", "state", "clio-coder");
	const cacheDir = join(root, ".cache", "clio-coder");

	mkdirSync(configDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(cacheDir, { recursive: true });

	const env: Record<string, string> = {
		HOME: root,
		CLIO_CODER_HOME: "",
		CLIO_CODER_CONFIG_DIR: configDir,
		CLIO_CODER_DATA_DIR: dataDir,
		CLIO_CODER_STATE_DIR: stateDir,
		CLIO_CODER_CACHE_DIR: cacheDir,
		CLIO_CODER_TEST_UPGRADE_NO_NETWORK: "1",
	};

	return {
		root,
		stateDir,
		env,
		cleanup: () => {
			resetXdgCache();
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				// Ignore cleanup errors
			}
		},
	};
}

async function captureUpgrade(
	argv: ReadonlyArray<string>,
	extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	const origEnv = { ...process.env };
	const origStdoutWrite = process.stdout.write;
	const origStderrWrite = process.stderr.write;

	let stdout = "";
	let stderr = "";

	Object.assign(process.env, extraEnv);
	resetXdgCache();

	process.stdout.write = ((chunk: unknown) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;

	process.stderr.write = ((chunk: unknown) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;

	try {
		const code = await runUpgradeCommand(argv);
		return { code, stdout, stderr };
	} finally {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		for (const key of Object.keys(extraEnv)) {
			if (origEnv[key] === undefined) delete process.env[key];
			else process.env[key] = origEnv[key];
		}
		resetXdgCache();
	}
}

describe("contracts/upgrade-lifecycle", () => {
	it("skips upgrade and exits 0 when version is already current with no pending migrations", async () => {
		const testEnv = isolatedEnv();
		const version = getVersionInfo().clio;
		try {
			// Pre-mark all migrations as applied and state as current version
			const manifest = {
				applied: [
					"2026-09-01-settings-v2",
					"2026-09-01-extension-install-digests",
					"2026-09-01-clio-coder-naming",
					"2026-09-01-retire-panes-knobs",
					"2026-08-18-lmstudio-runtime-id",
				],
			};
			writeFileSync(join(testEnv.stateDir, "migrations.json"), JSON.stringify(manifest), "utf8");
			writeFileSync(join(testEnv.stateDir, "install.json"), JSON.stringify({ version }), "utf8");

			const res = await captureUpgrade([], {
				...testEnv.env,
				CLIO_CODER_TEST_UPGRADE_AVAILABLE: version,
			});

			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Installation method:/u);
			match(res.stdout, new RegExp(`Current version: ${version}`, "u"));
			match(res.stdout, new RegExp(`upgrade skipped: ${version} is already installed`, "u"));
			match(res.stdout, /Done/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("previews upgrade in dry-run mode without modifying state", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureUpgrade(["--dry-run"], testEnv.env);
			strictEqual(res.code, 0, res.stderr);
			match(res.stdout, /Upgrade/u);
			match(res.stdout, /Installation method:/u);
			match(res.stdout, /Current version:/u);
			match(res.stdout, /Dry run - no changes made/u);
		} finally {
			testEnv.cleanup();
		}
	});

	it("emits structured JSON when --json flag is provided", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureUpgrade(["--dry-run", "--json"], testEnv.env);
			strictEqual(res.code, 0, res.stderr);
			const parsed = JSON.parse(res.stdout);
			strictEqual(parsed.command, "upgrade");
			strictEqual(typeof parsed.method, "string");
			ok(parsed.steps.length > 0);
		} finally {
			testEnv.cleanup();
		}
	});

	it("rejects invalid channel arguments with exit code 2", async () => {
		const res = await captureUpgrade(["--channel=unknown-chan"]);
		strictEqual(res.code, 2);
		match(res.stderr, /--channel must be one of/u);
	});

	it("provides clear manual recovery instructions on migration failure", async () => {
		const testEnv = isolatedEnv();
		try {
			const res = await captureUpgrade([], {
				...testEnv.env,
				CLIO_CODER_TEST_UPGRADE_FAIL: "migration",
			});
			strictEqual(res.code, 1);
			match(res.stderr, /migration failed/u);
			ok(
				res.stdout.includes("clio-coder upgrade --skip-migrations") ||
					res.stderr.includes("clio-coder upgrade --skip-migrations"),
			);
		} finally {
			testEnv.cleanup();
		}
	});
});
