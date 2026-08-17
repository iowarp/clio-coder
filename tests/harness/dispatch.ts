/**
 * Shared test harness for dispatch-bundle contract tests.
 *
 * Two concerns every dispatch test shares:
 *   - State isolation. extension.start() opens the run ledger and scans the
 *     receipts directory under CLIO_CODER_STATE_DIR, and run completion records a
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

/**
 * Several call sites re-isolate per test in `beforeEach` but only call
 * `restoreDispatchState()` once, in `after`, at the end of the whole describe
 * (an intentional "leave the leftover scratch dirs for one bulk cleanup"
 * shortcut, harmless before isolateClioEnv() gained a process-wide lock).
 * Now that the lock exists, a second acquire before the first releases would
 * deadlock every test after it. Releasing whatever this module is still
 * holding before acquiring the next one preserves the "beforeEach re-isolates"
 * behavior those call sites rely on without needing an intervening
 * `restoreDispatchState()`, and cleans up the previous scratch dir eagerly
 * instead of leaking it to the end of the run as a side effect.
 */
export async function isolateDispatchState(): Promise<void> {
	isolated?.restore();
	isolated = await isolateClioEnv("clio-dispatch-state-");
}

export function restoreDispatchState(): void {
	isolated?.restore();
	isolated = null;
}

/**
 * Hold the event loop open for the duration of a test.
 *
 * The heartbeat watchdog is deliberately unref'd in production: a stall
 * detector must never be the reason a finished CLI process stays alive. In a
 * real dispatch the worker's own child-process handles keep the loop running
 * long enough for the watchdog to fire, but a test whose worker is a plain
 * object has no such handle. Node 22 then settles the loop while the test is
 * still awaiting a promise only the watchdog can resolve, and the test is
 * cancelled with "Promise resolution is still pending". Node 24 happens to
 * keep a handle of its own, which is why this only ever showed up on 22.
 *
 * Any test that waits on stall detection, heartbeat classification, or another
 * unref'd timer holds this and releases it in a `finally`.
 */
export function holdEventLoop(): { release(): void } {
	const timer = setInterval(() => {}, 1_000);
	timer.ref?.();
	return {
		release(): void {
			clearInterval(timer);
		},
	};
}
