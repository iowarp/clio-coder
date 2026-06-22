/**
 * Shared test harness for dispatch-bundle contract tests.
 *
 * Two concerns every dispatch test shares:
 *   - State isolation. extension.start() opens the run ledger and scans the
 *     receipts directory under CLIO_STATE_DIR, and run completion records a
 *     receipt and persists runs.json. Without isolation a test reads, locks,
 *     and rewrites the developer's real multi-megabyte ledger (a state leak,
 *     and the dominant cost of the contracts lane).
 *   - Reproducibility cost. The production collector shells out to three
 *     synchronous git subprocesses per receipt. The fast collector here skips
 *     git but stays argument-preserving: cwd and safety metadata still flow
 *     through, so receipt-content and orphan-recovery plumbing remain testable.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetXdgCache } from "../../src/core/xdg.js";
import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { RunReceiptReproducibility } from "../../src/domains/dispatch/types.js";
import type { SafetyPolicyMetadata } from "../../src/domains/safety/policy-engine.js";

/**
 * Drop-in for collectReproducibilityMetadata that never spawns git. It mirrors
 * the real collector's signature and preserves both arguments, so a regression
 * that passes the wrong cwd or safety metadata to the collector still surfaces.
 */
export function fastReproducibility(cwd: string, safety: SafetyPolicyMetadata | null): RunReceiptReproducibility {
	return {
		cwd,
		git: { branch: null, commit: null, dirty: null, dirtyEntries: null, statusHash: null },
		safetyPolicy: {
			version: safety?.version ?? 1,
			rulePackHash: safety?.rulePackHash ?? null,
			rulePackVersion: safety?.rulePackVersion ?? null,
			projectPolicyPath: safety?.projectPolicyPath ?? null,
			projectPolicyHash: safety?.projectPolicyHash ?? null,
			projectPolicyValid: safety?.projectPolicyValid ?? null,
		},
	};
}

export function makeDispatchBundle(
	ctx: Parameters<typeof createDispatchBundle>[0],
	options: Parameters<typeof createDispatchBundle>[1] = {},
): ReturnType<typeof createDispatchBundle> {
	return createDispatchBundle(ctx, { collectReproducibility: fastReproducibility, ...options });
}

let envBackup: NodeJS.ProcessEnv = {};
let stateScratch = "";

export function isolateDispatchState(): void {
	envBackup = { ...process.env };
	stateScratch = mkdtempSync(join(tmpdir(), "clio-dispatch-state-"));
	process.env.CLIO_HOME = stateScratch;
	process.env.CLIO_DATA_DIR = join(stateScratch, "data");
	process.env.CLIO_CONFIG_DIR = join(stateScratch, "config");
	process.env.CLIO_STATE_DIR = join(stateScratch, "state");
	process.env.CLIO_CACHE_DIR = join(stateScratch, "cache");
	resetXdgCache();
}

export function restoreDispatchState(): void {
	for (const key of Object.keys(process.env)) {
		if (!(key in envBackup)) Reflect.deleteProperty(process.env, key);
	}
	for (const [key, value] of Object.entries(envBackup)) {
		if (value !== undefined) process.env[key] = value;
	}
	rmSync(stateScratch, { recursive: true, force: true });
	resetXdgCache();
}
