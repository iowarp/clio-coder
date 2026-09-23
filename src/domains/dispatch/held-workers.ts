/**
 * Speculative dispatch: worker processes started ahead of the dispatch that
 * would use them.
 *
 * This works like speculative decoding. Before a turn, the `dispatchForecast`
 * site predicts which recipe the main agent is about to dispatch. When the
 * prediction is confident, the harness starts that worker's process and holds
 * it at "waiting for spec" while the main model generates. A dispatch that
 * resolves to exactly the predicted recipe, target, model, runtime and working
 * directory adopts the held process; anything else runs on an ordinary cold
 * spawn and the held process is killed when the turn settles. The agent's
 * call, its admission, its spec and its receipt are identical either way.
 *
 * Held processes take no capacity lease and are capped separately, so a
 * speculative process never takes a slot from a real dispatch. They die at
 * turn settle, cancel, session end and process exit, and one whose parent is
 * killed reads end-of-file on stdin and exits on its own.
 */

import type { HeldWorkerProcess } from "./worker-spawn.js";

/** Everything a dispatch must match exactly to adopt a held process. */
export interface HeldWorkerKey {
	readonly agentId: string;
	readonly targetId: string;
	readonly wireModelId: string;
	readonly runtimeId: string;
	readonly cwd: string;
}

/** Held processes alive at once, across every prediction. */
export const MAX_HELD_WORKERS = 2;

/**
 * Run a forecast hold before the caller awaiting the brief resumes. A later
 * event-loop task can miss a fast dispatch or run after turn settlement. The
 * returned cancellation prevents that late hold if the turn settles first.
 */
export function scheduleSpeculativeHold(hold: () => void): () => void {
	let cancelled = false;
	queueMicrotask(() => {
		if (!cancelled) hold();
	});
	return () => {
		cancelled = true;
	};
}

export interface HeldWorkerStats {
	/** Processes started on a prediction. */
	readonly held: number;
	/** Held processes a matching dispatch adopted. */
	readonly adopted: number;
	/** Held processes killed unused. */
	readonly discarded: number;
	/** Processes held right now. */
	readonly live: number;
}

export interface HeldWorkerPool {
	/**
	 * Start up to `count` processes for `key`, within the global cap. Returns
	 * how many were started. Never throws.
	 */
	hold(key: HeldWorkerKey, count: number): number;
	/** Remove and return a live held process for exactly `key`, or null. */
	take(key: HeldWorkerKey): HeldWorkerProcess | null;
	/** Kill every held process. Called at turn settle, cancel and session end. */
	releaseAll(reason: string): number;
	stats(): HeldWorkerStats;
}

export interface HeldWorkerPoolOptions {
	spawnHeld(key: HeldWorkerKey): HeldWorkerProcess;
	maxHeld?: number;
	/** Diagnostics only; the pool never throws on a spawn failure. */
	onDiagnostic?(message: string): void;
}

function keyString(key: HeldWorkerKey): string {
	return JSON.stringify([key.agentId, key.targetId, key.wireModelId, key.runtimeId, key.cwd]);
}

/** Held processes of every pool in this process, killed if the process exits with any still held. */
const everyHeld = new Set<HeldWorkerProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const held of everyHeld) held.discard();
		everyHeld.clear();
	});
}

export function createHeldWorkerPool(options: HeldWorkerPoolOptions): HeldWorkerPool {
	const maxHeld = Math.max(0, Math.floor(options.maxHeld ?? MAX_HELD_WORKERS));
	const held = new Map<string, HeldWorkerProcess[]>();
	let started = 0;
	let adopted = 0;
	let discarded = 0;

	const live = (): number => {
		let count = 0;
		for (const [id, entries] of held) {
			const alive = entries.filter((entry) => entry.alive());
			for (const entry of entries) {
				if (!alive.includes(entry)) {
					everyHeld.delete(entry);
					discarded += 1;
				}
			}
			if (alive.length === 0) held.delete(id);
			else held.set(id, alive);
			count += alive.length;
		}
		return count;
	};

	return {
		hold(key, count) {
			let spawned = 0;
			try {
				const room = Math.min(Math.max(0, Math.floor(count)), maxHeld - live());
				for (let index = 0; index < room; index += 1) {
					const child = options.spawnHeld(key);
					if (!child.alive()) {
						child.discard();
						continue;
					}
					installExitHook();
					everyHeld.add(child);
					const id = keyString(key);
					held.set(id, [...(held.get(id) ?? []), child]);
					started += 1;
					spawned += 1;
				}
			} catch (error) {
				options.onDiagnostic?.(
					`speculative dispatch: hold failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return spawned;
		},
		take(key) {
			const id = keyString(key);
			const entries = held.get(id);
			if (entries === undefined) return null;
			while (entries.length > 0) {
				const candidate = entries.shift() as HeldWorkerProcess;
				everyHeld.delete(candidate);
				if (candidate.alive()) {
					if (entries.length === 0) held.delete(id);
					adopted += 1;
					return candidate;
				}
				discarded += 1;
			}
			held.delete(id);
			return null;
		},
		releaseAll() {
			let released = 0;
			for (const entries of held.values()) {
				for (const entry of entries) {
					entry.discard();
					everyHeld.delete(entry);
					released += 1;
				}
			}
			held.clear();
			discarded += released;
			return released;
		},
		stats() {
			return { held: started, adopted, discarded, live: live() };
		},
	};
}
