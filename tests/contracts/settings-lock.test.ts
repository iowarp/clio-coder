import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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
import { clearScratchClioHome, newScratchClioHome } from "../harness/scratch-env.js";

const ORIGINAL_ENV = { ...process.env };

function seededSettings(): ClioSettings {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.targets = [
		{ id: "target-a", runtime: "openai-compat", url: "http://localhost:1111", defaultModel: "model-a" },
		{ id: "target-b", runtime: "openai-compat", url: "http://localhost:2222", defaultModel: "model-b" },
	];
	Object.assign(settings.chat, { target: "target-a", model: "model-a", thinkingLevel: "off" });
	settings.fleet.default = { target: "target-a", model: "model-a", thinkingLevel: "off" };
	return settings;
}

describe("contracts/settings-lock", () => {
	let scratch = "";

	beforeEach(async () => {
		scratch = await newScratchClioHome("clio-settings-lock-");
		updateSettings(() => seededSettings());
	});

	afterEach(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in ORIGINAL_ENV)) Reflect.deleteProperty(process.env, k);
		}
		for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
			if (v !== undefined) process.env[k] = v;
		}
		clearScratchClioHome(scratch);
	});

	it("preserves a concurrent write that lands between a stale read and a locked update", () => {
		// Simulated process A reads the file and goes off to think.
		const staleReadByA = readSettings();
		strictEqual(staleReadByA.chat.retry.maxRetries, 3);

		// Simulated process B saves a default in the meantime.
		updateSettings((settings) => {
			settings.chat.retry.maxRetries = 9;
		});

		// Old behavior: A writes its whole stale blob back, dropping B's patch.
		// New behavior: A's mutation runs against a re-read inside the lock, so
		// B's change survives alongside A's.
		updateSettings((settings) => {
			settings.safety.limits.sessionCostUsd = 7;
		});

		const merged = readSettings();
		strictEqual(merged.chat.retry.maxRetries, 9, "B's patch must survive A's later update");
		strictEqual(merged.safety.limits.sessionCostUsd, 7, "A's patch must apply too");

		// Contrast: the naive lost-update sequence really does lose B's patch,
		// which is exactly what updateSettings exists to prevent.
		const naive = structuredClone(staleReadByA);
		naive.safety.limits.sessionCostUsd = 11;
		writeFileSync(settingsPath(), stringifyYaml(naive), "utf8");
		strictEqual(readSettings().chat.retry.maxRetries, 3, "naive whole-blob write clobbers concurrent patches");
	});

	it("interleaves field-level patches from two simulated sessions without losing either", () => {
		// Mirrors the orchestrator write-through: each session re-reads under the
		// lock and applies only its own routing fields.
		const sessionAPatch = (settings: ClioSettings): void => {
			settings.chat.target = "target-b";
			settings.chat.model = "model-b";
		};
		const sessionBPatch = (settings: ClioSettings): void => {
			settings.chat.thinkingLevel = "high";
		};
		// Both sessions captured their pre-read before either wrote; the locked
		// re-read makes the interleaving safe regardless of order.
		updateSettings(sessionAPatch);
		updateSettings(sessionBPatch);
		const saved = readSettings();
		strictEqual(saved.chat.target, "target-b");
		strictEqual(saved.chat.model, "model-b");
		strictEqual(saved.chat.thinkingLevel, "high");
	});

	it("times out on a lock held by a live process instead of corrupting the file", () => {
		// This process is the stand-in for a sibling that is alive and working.
		writeFileSync(settingsLockPath(), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
		throws(
			() =>
				updateSettings(
					(settings) => {
						settings.chat.retry.maxRetries = 1;
					},
					{ timeoutMs: 120 },
				),
			/timed out .* waiting for/,
		);
		// The blocked writer changed nothing.
		strictEqual(readSettings().chat.retry.maxRetries, 3);
		rmSync(settingsLockPath(), { force: true });
	});

	it("leaves a live holder's lock alone well past the retired 5s stale window", () => {
		// The old settings policy treated a lockfile older than 5s as abandoned
		// with no liveness check, so a settings write that stalled past five
		// seconds on a slow filesystem had its lock stolen mid-write. Age no
		// longer decides for a lock whose owner is demonstrably alive.
		const lockPath = settingsLockPath();
		writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`, "utf8");
		const past = new Date(Date.now() - 60_000);
		utimesSync(lockPath, past, past);

		throws(
			() =>
				updateSettings(
					(settings) => {
						settings.chat.retry.maxRetries = 1;
					},
					{ timeoutMs: 120 },
				),
			/timed out .* waiting for/,
		);
		strictEqual(readSettings().chat.retry.maxRetries, 3);
		ok(existsSync(lockPath), "the live holder's lock must survive the failed acquisition");
		rmSync(lockPath, { force: true });
	});

	it("takes over a lock left by a dead process", () => {
		const lockPath = settingsLockPath();
		writeFileSync(lockPath, `${JSON.stringify({ pid: 999999, at: new Date(0).toISOString() })}\n`, "utf8");

		updateSettings(
			(settings) => {
				settings.chat.retry.maxRetries = 5;
			},
			{ timeoutMs: 1_000 },
		);
		strictEqual(readSettings().chat.retry.maxRetries, 5);
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
			settings.chat.retry.maxRetries = 4;
		});
		strictEqual(readSettings().chat.retry.maxRetries, 4);
	});

	it("writes atomically: no partially written settings.yaml and no leftover temp files", () => {
		for (let i = 0; i < 5; i += 1) {
			updateSettings((settings) => {
				settings.safety.limits.sessionCostUsd = i;
			});
			// Every read between writes parses a complete document.
			const parsed = readSettings();
			strictEqual(parsed.safety.limits.sessionCostUsd, i);
		}
		const configDir = join(scratch, "config");
		const leftovers = readdirSync(configDir).filter((name) => name.includes(".tmp-") || name.endsWith(".lock"));
		deepStrictEqual(leftovers, [], `expected no temp/lock leftovers, found: ${leftovers.join(", ")}`);
		ok(statSync(settingsPath()).isFile());
	});
});
