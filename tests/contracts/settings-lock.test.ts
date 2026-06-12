import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { stringify as stringifyYaml } from "yaml";
import {
	type ClioSettings,
	readSettings,
	settingsLockPath,
	settingsPath,
	updateSettings,
} from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { resetXdgCache } from "../../src/core/xdg.js";

const ORIGINAL_ENV = { ...process.env };

function seededSettings(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	settings.orchestrator = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	settings.workers.default = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	return settings;
}

describe("contracts/settings-lock", () => {
	let scratch = "";

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-settings-lock-"));
		process.env.CLIO_HOME = scratch;
		process.env.CLIO_DATA_DIR = join(scratch, "data");
		process.env.CLIO_CONFIG_DIR = join(scratch, "config");
		process.env.CLIO_CACHE_DIR = join(scratch, "cache");
		resetXdgCache();
		updateSettings(() => seededSettings());
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		rmSync(scratch, { recursive: true, force: true });
		resetXdgCache();
	});

	it("preserves a concurrent write that lands between a stale read and a locked update", () => {
		// Simulated process A reads the file and goes off to think.
		const staleReadByA = readSettings();
		strictEqual(staleReadByA.retry.maxRetries, 3);

		// Simulated process B saves a default in the meantime.
		updateSettings((settings) => {
			settings.retry.maxRetries = 9;
		});

		// Old behavior: A writes its whole stale blob back, dropping B's patch.
		// New behavior: A's mutation runs against a re-read inside the lock, so
		// B's change survives alongside A's.
		updateSettings((settings) => {
			settings.budget.sessionCeilingUsd = 7;
		});

		const merged = readSettings();
		strictEqual(merged.retry.maxRetries, 9, "B's patch must survive A's later update");
		strictEqual(merged.budget.sessionCeilingUsd, 7, "A's patch must apply too");

		// Contrast: the naive lost-update sequence really does lose B's patch,
		// which is exactly what updateSettings exists to prevent.
		const naive = structuredClone(staleReadByA);
		naive.budget.sessionCeilingUsd = 11;
		writeFileSync(settingsPath(), stringifyYaml(naive), "utf8");
		strictEqual(readSettings().retry.maxRetries, 3, "naive whole-blob write clobbers concurrent patches");
	});

	it("interleaves field-level patches from two simulated sessions without losing either", () => {
		// Mirrors the orchestrator write-through: each session re-reads under the
		// lock and applies only its own routing fields.
		const sessionAPatch = (settings: ClioSettings): void => {
			settings.orchestrator.target = "target-b";
			settings.orchestrator.model = "model-b";
		};
		const sessionBPatch = (settings: ClioSettings): void => {
			settings.orchestrator.thinkingLevel = "high";
		};
		// Both sessions captured their pre-read before either wrote; the locked
		// re-read makes the interleaving safe regardless of order.
		updateSettings(sessionAPatch);
		updateSettings(sessionBPatch);
		const saved = readSettings();
		strictEqual(saved.orchestrator.target, "target-b");
		strictEqual(saved.orchestrator.model, "model-b");
		strictEqual(saved.orchestrator.thinkingLevel, "high");
	});

	it("times out on a fresh foreign lock instead of corrupting the file", () => {
		writeFileSync(settingsLockPath(), `${JSON.stringify({ pid: 999999, at: new Date().toISOString() })}\n`, "utf8");
		throws(
			() =>
				updateSettings(
					(settings) => {
						settings.retry.maxRetries = 1;
					},
					{ timeoutMs: 120, pollIntervalMs: 10 },
				),
			/timed out .* waiting for/,
		);
		// The blocked writer changed nothing.
		strictEqual(readSettings().retry.maxRetries, 3);
		rmSync(settingsLockPath(), { force: true });
	});

	it("takes over a stale lock left by a dead process", () => {
		const lockPath = settingsLockPath();
		writeFileSync(lockPath, `${JSON.stringify({ pid: 999999, at: new Date(0).toISOString() })}\n`, "utf8");
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockPath, past, past);

		updateSettings(
			(settings) => {
				settings.retry.maxRetries = 5;
			},
			{ timeoutMs: 1_000, staleLockMs: 5_000, pollIntervalMs: 10 },
		);
		strictEqual(readSettings().retry.maxRetries, 5);
		strictEqual(existsSync(lockPath), false, "lock must be released after takeover");
	});

	it("releases the lock when the mutator throws", () => {
		throws(() =>
			updateSettings(() => {
				throw new Error("mutator boom");
			}),
		);
		strictEqual(existsSync(settingsLockPath()), false);
		// And the file is still usable for the next writer.
		updateSettings((settings) => {
			settings.retry.maxRetries = 4;
		});
		strictEqual(readSettings().retry.maxRetries, 4);
	});

	it("writes atomically: no partially written settings.yaml and no leftover temp files", () => {
		for (let i = 0; i < 5; i += 1) {
			updateSettings((settings) => {
				settings.budget.sessionCeilingUsd = i;
			});
			// Every read between writes parses a complete document.
			const parsed = readSettings();
			strictEqual(parsed.budget.sessionCeilingUsd, i);
		}
		const configDir = join(scratch, "config");
		const leftovers = readdirSync(configDir).filter((name) => name.includes(".tmp-") || name.endsWith(".lock"));
		deepStrictEqual(leftovers, [], `expected no temp/lock leftovers, found: ${leftovers.join(", ")}`);
		ok(statSync(settingsPath()).isFile());
	});
});
