/**
 * Durable route-quality sources, read incrementally.
 *
 * Dispatch admission asks the route observer for a readiness window on every dispatch, and the window needs this
 * host's route history, every settled run and every gate decision artifact. Runs come from the telemetry domain's
 * route history fold, which re-reads only scopes whose files moved; gate artifacts are stat-checked here the same way
 * (#434).
 *
 * A file's identity is its inode, size, mtime and ctime. Gate artifacts are written by tmp-and-rename, so every rewrite lands
 * on a new inode even inside one mtime tick. An unchanged run or artifact keeps returning the same object, which is
 * what lets the object-keyed gate verdicts in `route-quality.ts` stay warm across dispatches. A changed one yields a
 * fresh object and is verified again.
 */

import type { Stats } from "node:fs";
import { join } from "node:path";
import { listStateDirectorySync, readStateFileSync, statStatePathSync } from "../../core/state-boundary.js";
import type { RouteHistoryEntry, RouteHistoryFold, SettledRunFacts } from "../telemetry/index.js";
import { createRouteHistoryFold } from "../telemetry/index.js";
import { type GateDecisionArtifact, gateDecisionsDirectory, verifyGateDecisionArtifact } from "./gate-decisions.js";
import type { RouteQualityRun } from "./route-quality.js";

/** A run sealed under a verified seal, as route quality reads it. */
export interface DurableRunSource extends RouteQualityRun {
	settled: SettledRunFacts["facts"];
}

export interface DurableQualitySources {
	/** This host's route history, verified or not; an unverified entry is an integrity failure. */
	history: ReadonlyArray<RouteHistoryEntry>;
	/** Verified runs only, by digest. */
	runs: ReadonlyArray<DurableRunSource>;
	gates: ReadonlyArray<GateDecisionArtifact>;
	/** Changes whenever any source was added, rewritten or removed since the last read. */
	version: number;
}

export interface DurableQualitySourceCache {
	read(): DurableQualitySources;
	/** The verified source for a settled run, the same object across reads while the run is unchanged. */
	sourceOf(run: SettledRunFacts): DurableRunSource | null;
}

export interface CreateDurableQualitySourceCacheOptions {
	stateDir: string;
	/** The route history fold to read; one over `stateDir` when absent. */
	history?: RouteHistoryFold;
}

interface FileIdentity {
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

function identityOf(stats: Stats): FileIdentity {
	return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs, ctimeMs: stats.ctimeMs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
	);
}

function durableRun(run: SettledRunFacts): DurableRunSource {
	const settled = run.facts;
	return {
		runId: run.runId,
		digest: run.digest,
		agentId: settled.agentId,
		route: {
			targetId: settled.route.targetId,
			wireModelId: settled.route.wireModelId,
			runtimeId: settled.route.runtimeId,
		},
		node: settled.node ? { id: settled.node.id } : null,
		quality: settled.quality,
		settled,
	};
}

interface GateEntry {
	identity: FileIdentity;
	artifact: GateDecisionArtifact | null;
}

export function createDurableQualitySourceCache(
	options: CreateDurableQualitySourceCacheOptions,
): DurableQualitySourceCache {
	const fold = options.history ?? createRouteHistoryFold({ stateDir: options.stateDir });
	const gatesDir = gateDecisionsDirectory(options.stateDir);
	const sources = new WeakMap<SettledRunFacts, DurableRunSource>();
	const gates = new Map<string, GateEntry>();
	let historyVersion = -1;
	let version = 0;
	let last: DurableQualitySources | null = null;

	const sourceOf = (run: SettledRunFacts): DurableRunSource | null => {
		if (!run.sealVerified) return null;
		let source = sources.get(run);
		if (source === undefined) {
			source = durableRun(run);
			sources.set(run, source);
		}
		return source;
	};

	const readGates = (): { artifacts: GateDecisionArtifact[]; changed: boolean } => {
		let changed = false;
		let names: string[] = [];
		try {
			// Gate artifacts are read through the state boundary: a symlinked or escaping store judges no route (#434).
			names = listStateDirectorySync(options.stateDir, gatesDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort();
		} catch {
			// A missing or unreadable store holds no decision.
		}
		const seen = new Set<string>();
		const artifacts: GateDecisionArtifact[] = [];
		for (const name of names) {
			const path = join(gatesDir, name);
			const stats = statStatePathSync(options.stateDir, path);
			if (stats === null || !stats.isFile()) continue;
			seen.add(path);
			const identity = identityOf(stats);
			const cached = gates.get(path);
			if (cached !== undefined && sameIdentity(cached.identity, identity)) {
				if (cached.artifact !== null) artifacts.push(cached.artifact);
				continue;
			}
			changed = true;
			let artifact: GateDecisionArtifact | null = null;
			try {
				const parsed = JSON.parse(readStateFileSync(options.stateDir, path).toString("utf8")) as GateDecisionArtifact;
				// Read APIs ignore malformed or unverifiable artifacts, exactly as
				// `readGateDecisionArtifacts` does.
				if (verifyGateDecisionArtifact(parsed).ok) artifact = parsed;
			} catch {
				artifact = null;
			}
			gates.set(path, { identity, artifact });
			if (artifact !== null) artifacts.push(artifact);
		}
		for (const path of [...gates.keys()]) {
			if (seen.has(path)) continue;
			gates.delete(path);
			changed = true;
		}
		return { artifacts, changed };
	};

	return {
		sourceOf,
		read() {
			const history = fold.read();
			const gateRead = readGates();
			if (last !== null && history.version === historyVersion && !gateRead.changed) return last;
			historyVersion = history.version;
			version += 1;
			const runs: DurableRunSource[] = [];
			for (const run of history.runs) {
				const source = sourceOf(run);
				if (source !== null) runs.push(source);
			}
			last = { history: history.entries, runs, gates: gateRead.artifacts, version };
			return last;
		},
	};
}
