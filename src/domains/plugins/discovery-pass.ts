import path from "node:path";
import type { PluginCandidate, PluginSnapshot } from "./types.js";

/**
 * One synchronous discovery reads each installed plugin tree once.
 *
 * Every plugin listing re-verifies each installed tree against its recorded
 * digest, and that walk is the integrity check. A single agent or skill
 * discovery used to list plugins once per skill-binding recipe, walking every
 * tree dozens of times with the event loop blocked. Inside a pass, the first
 * listing verifies each tree and later listings in the same pass reuse that
 * verdict. The memo lives only while the pass body runs, so the next pass,
 * every reload, and every install or removal verify from disk again.
 *
 * The body must be synchronous. An awaited continuation runs after the pass has
 * closed and simply reads from disk again.
 */
interface DiscoveryPass {
	readonly candidates: Map<string, PluginCandidate>;
	readonly snapshots: Map<string, PluginSnapshot>;
}

let active: DiscoveryPass | null = null;

export function withPluginDiscoveryPass<T>(body: () => T): T {
	if (active) return body();
	active = { candidates: new Map(), snapshots: new Map() };
	try {
		return body();
	} finally {
		active = null;
	}
}

/** Reloads commit a fresh verification even when called from inside a pass. */
export function outsidePluginDiscoveryPass<T>(body: () => T): T {
	const suspended = active;
	active = null;
	try {
		return body();
	} finally {
		active = suspended;
	}
}

export function passPluginCandidate(root: string, read: (root: string) => PluginCandidate): PluginCandidate {
	if (!active) return read(root);
	const key = path.resolve(root);
	let candidate = active.candidates.get(key);
	if (!candidate) {
		candidate = read(root);
		active.candidates.set(key, candidate);
	}
	return candidate;
}

export function passPluginSnapshot(key: string, build: () => PluginSnapshot): PluginSnapshot {
	if (!active) return build();
	let snapshot = active.snapshots.get(key);
	if (!snapshot) {
		snapshot = build();
		active.snapshots.set(key, snapshot);
	}
	return snapshot;
}
