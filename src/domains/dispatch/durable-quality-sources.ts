/**
 * Durable route-quality sources, read incrementally.
 *
 * Dispatch admission asks the route observer for a readiness window on every
 * dispatch, and the window needs every settled run plus every gate decision
 * artifact. This cache stats every file in each run's sealed scope and each gate
 * artifact and re-reads only the ones whose identity changed, so a dispatch pays
 * for the scopes changed since the previous one (#434).
 *
 * A file's identity is its inode, size, mtime and ctime. A run scope's `bundle.json`,
 * `runs.json` and gate artifacts are all written by tmp-and-rename, so every
 * rewrite lands on a new inode even inside one mtime tick. An unchanged file
 * keeps returning the same object, which is what lets the object-keyed gate
 * verdicts in `route-quality.ts` stay warm across dispatches. A changed file
 * yields a fresh object and is verified again.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import type { SettledRunRecord } from "../telemetry/index.js";
import {
	readVerifiedRun,
	telemetryBundlePath,
	telemetryJournalFiles,
	telemetryObjectsDirectory,
	telemetryRunDirectory,
} from "../telemetry/index.js";
import { type GateDecisionArtifact, gateDecisionsDirectory, verifyGateDecisionArtifact } from "./gate-decisions.js";
import type { RouteQualityRun } from "./route-quality.js";
import type { RunEnvelope } from "./types.js";

/** A run sealed under a verified seal, as route quality and route readiness read it. */
export interface DurableRunSource extends RouteQualityRun {
	settled: SettledRunRecord["settled"];
	envelope: RunEnvelope;
}

export interface DurableQualitySources {
	runs: ReadonlyArray<DurableRunSource>;
	gates: ReadonlyArray<GateDecisionArtifact>;
	/** Changes whenever any source file was added, rewritten or removed since the last read. */
	version: number;
}

export interface DurableQualitySourceCache {
	read(): DurableQualitySources;
}

export interface CreateDurableQualitySourceCacheOptions {
	stateDir: string;
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

/** A seal covers every segment and object, so any changed or missing file invalidates the cached verdict (#434). */
function runIdentity(directory: string): string | null {
	try {
		const paths = [
			telemetryBundlePath(directory),
			...telemetryJournalFiles(readdirSync(directory)).map((name) => join(directory, name)),
		];
		const objects = telemetryObjectsDirectory(directory);
		try {
			paths.push(
				objects,
				...readdirSync(objects)
					.sort()
					.map((name) => join(objects, name)),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return JSON.stringify(paths.map((path) => [path, identityOf(lstatSync(path))]));
	} catch {
		// An incomplete or unreadable scope cannot contribute trusted evidence (#434).
		return null;
	}
}

function statOrNull(path: string): Stats | null {
	try {
		return statSync(path);
	} catch {
		return null;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface RunEntry {
	identity: string;
	/** The envelope the cached source was paired with, serialized for comparison. */
	envelopeJson: string;
	source: DurableRunSource | null;
}

function durableRun(settled: SettledRunRecord["settled"], envelope: RunEnvelope): DurableRunSource {
	return {
		runId: envelope.id,
		digest: settled.digest,
		agentId: settled.agentId,
		route: {
			targetId: settled.route.targetId,
			wireModelId: settled.route.wireModelId,
			runtimeId: settled.route.runtimeId,
		},
		node: settled.node ? { id: settled.node.id } : null,
		quality: settled.quality,
		settled,
		envelope,
	};
}

interface GateEntry {
	identity: FileIdentity;
	artifact: GateDecisionArtifact | null;
}

export function createDurableQualitySourceCache(
	options: CreateDurableQualitySourceCacheOptions,
): DurableQualitySourceCache {
	const readFile = (path: string): string => readFileSync(path, "utf8");
	const runsPath = join(options.stateDir, "runs.json");
	const gatesDir = gateDecisionsDirectory(options.stateDir);
	let ledger: { identity: FileIdentity; envelopes: RunEnvelope[] } | null = null;
	const runs = new Map<string, RunEntry>();
	const gates = new Map<string, GateEntry>();
	let version = 0;
	let last: DurableQualitySources | null = null;

	const readEnvelopes = (): { envelopes: RunEnvelope[]; changed: boolean } => {
		const stats = statOrNull(runsPath);
		if (stats === null) {
			const changed = ledger !== null;
			ledger = null;
			return { envelopes: [], changed };
		}
		const identity = identityOf(stats);
		if (ledger !== null && sameIdentity(ledger.identity, identity))
			return { envelopes: ledger.envelopes, changed: false };
		let envelopes: RunEnvelope[] = [];
		try {
			const parsed = JSON.parse(readFile(runsPath)) as unknown;
			if (Array.isArray(parsed)) envelopes = parsed.filter(isObject) as unknown as RunEnvelope[];
		} catch {
			envelopes = [];
		}
		ledger = { identity, envelopes };
		return { envelopes, changed: true };
	};

	const readRuns = (
		envelopes: ReadonlyArray<RunEnvelope>,
		envelopesChanged: boolean,
	): { sources: DurableRunSource[]; changed: boolean } => {
		let changed = false;
		const seen = new Set<string>();
		const sources: DurableRunSource[] = [];
		for (const envelope of envelopes) {
			const path = telemetryRunDirectory(options.stateDir, envelope.id);
			seen.add(path);
			const identity = runIdentity(path);
			if (identity === null) {
				if (runs.delete(path)) changed = true;
				continue;
			}
			const cached = runs.get(path);
			// An unchanged runs.json hands back the same envelope objects, so the
			// pairing can only have moved when the ledger itself was re-read.
			const envelopeJson = envelopesChanged || cached === undefined ? JSON.stringify(envelope) : cached.envelopeJson;
			if (cached !== undefined && cached.identity === identity && cached.envelopeJson === envelopeJson) {
				if (cached.source !== null) sources.push(cached.source);
				continue;
			}
			changed = true;
			let source: DurableRunSource | null = null;
			try {
				const record = readVerifiedRun(options.stateDir, envelope.id);
				source = record === null ? null : durableRun(record.settled, envelope);
			} catch {
				// An unreadable run scope contributes no evidence.
				source = null;
			}
			runs.set(path, { identity, envelopeJson, source });
			if (source !== null) sources.push(source);
		}
		for (const path of [...runs.keys()]) {
			if (seen.has(path)) continue;
			runs.delete(path);
			changed = true;
		}
		return { sources, changed };
	};

	const readGates = (): { artifacts: GateDecisionArtifact[]; changed: boolean } => {
		let changed = false;
		const names = existsSync(gatesDir)
			? readdirSync(gatesDir)
					.filter((entry) => entry.endsWith(".json"))
					.sort()
			: [];
		const seen = new Set<string>();
		const artifacts: GateDecisionArtifact[] = [];
		for (const name of names) {
			const path = join(gatesDir, name);
			const stats = statOrNull(path);
			if (stats === null) continue;
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
				const parsed = JSON.parse(readFile(path)) as GateDecisionArtifact;
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
		read() {
			const current = readEnvelopes();
			const runRead = readRuns(current.envelopes, current.changed);
			const gateRead = readGates();
			if (last !== null && !runRead.changed && !gateRead.changed) return last;
			version += 1;
			last = { runs: runRead.sources, gates: gateRead.artifacts, version };
			return last;
		},
	};
}
