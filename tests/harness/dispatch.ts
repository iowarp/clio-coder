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

import { createDispatchBundle } from "../../src/domains/dispatch/extension.js";
import type { RunReceiptReproducibility } from "../../src/domains/dispatch/types.js";
import { compileWorker } from "../../src/domains/prompts/compiler.js";
import type { PromptsContract } from "../../src/domains/prompts/contract.js";
import { loadFragments } from "../../src/domains/prompts/fragment-loader.js";
import type { SafetyPolicyMetadata } from "../../src/domains/safety/policy-engine.js";
import { type IsolatedClioEnv, isolateClioEnv } from "./scratch-env.js";

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
	const promptTable = loadFragments();
	const prompts: PromptsContract = {
		compileSessionPrompt: async () => {
			throw new Error("dispatch test harness does not compile session prompts");
		},
		compileWorkerPrompt: async (input) => compileWorker(promptTable, input),
		reload() {},
	};
	const context = {
		bus: ctx.bus,
		getContract<T extends object>(name: string): T | undefined {
			if (name === "prompts") return prompts as T;
			return ctx.getContract<T>(name);
		},
	};
	return createDispatchBundle(context, { collectReproducibility: fastReproducibility, ...options });
}

let isolated: IsolatedClioEnv | null = null;

export function isolateDispatchState(): void {
	isolated = isolateClioEnv("clio-dispatch-state-");
}

export function restoreDispatchState(): void {
	isolated?.restore();
	isolated = null;
}
