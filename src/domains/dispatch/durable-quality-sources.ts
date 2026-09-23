/**
 * Durable route-quality sources, read incrementally.
 *
 * Dispatch admission asks the route observer for a readiness window on every
 * dispatch, and the window needs every terminal receipt plus every gate
 * decision artifact. Reading them all each time measured 201ms at 174 receipts
 * (6.4 MB), about 1.2ms per receipt, synchronously on the event loop. This
 * cache stats each file and re-reads only the ones whose identity changed, so
 * a dispatch pays for the receipts written since the previous one.
 *
 * A file's identity is its inode, size and mtime. Receipts, `runs.json` and
 * gate artifacts are all written by tmp-and-rename, so every rewrite lands on
 * a new inode even inside one mtime tick. An unchanged file keeps returning
 * the same parsed object, which is what lets the object-keyed integrity
 * verdicts in `route-quality.ts` stay warm across dispatches. A changed file
 * yields a fresh object and is verified again.
 */

import { existsSync, readdirSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { type GateDecisionArtifact, gateDecisionsDirectory, verifyGateDecisionArtifact } from "./gate-decisions.js";
import type { RunEnvelope, RunReceipt } from "./types.js";

export interface DurableReceiptSource {
	receipt: RunReceipt;
	envelope: RunEnvelope;
}

export interface DurableQualitySources {
	receipts: ReadonlyArray<DurableReceiptSource>;
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
}

function identityOf(stats: Stats): FileIdentity {
	return { ino: stats.ino, size: stats.size, mtimeMs: stats.mtimeMs };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
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

interface ReceiptEntry {
	identity: FileIdentity;
	/** The envelope the cached source was paired with, serialized for comparison. */
	envelopeJson: string;
	source: DurableReceiptSource | null;
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
	let runs: { identity: FileIdentity; envelopes: RunEnvelope[] } | null = null;
	const receipts = new Map<string, ReceiptEntry>();
	const gates = new Map<string, GateEntry>();
	let version = 0;
	let last: DurableQualitySources | null = null;

	const readEnvelopes = (): { envelopes: RunEnvelope[]; changed: boolean } => {
		const stats = statOrNull(runsPath);
		if (stats === null) {
			const changed = runs !== null;
			runs = null;
			return { envelopes: [], changed };
		}
		const identity = identityOf(stats);
		if (runs !== null && sameIdentity(runs.identity, identity)) return { envelopes: runs.envelopes, changed: false };
		let envelopes: RunEnvelope[] = [];
		try {
			const parsed = JSON.parse(readFile(runsPath)) as unknown;
			if (Array.isArray(parsed)) envelopes = parsed.filter(isObject) as unknown as RunEnvelope[];
		} catch {
			envelopes = [];
		}
		runs = { identity, envelopes };
		return { envelopes, changed: true };
	};

	const readReceipts = (
		envelopes: ReadonlyArray<RunEnvelope>,
		envelopesChanged: boolean,
	): { sources: DurableReceiptSource[]; changed: boolean } => {
		let changed = false;
		const seen = new Set<string>();
		const sources: DurableReceiptSource[] = [];
		for (const envelope of envelopes) {
			const path = envelope.receiptPath ?? join(options.stateDir, "receipts", `${envelope.id}.json`);
			seen.add(path);
			const stats = statOrNull(path);
			if (stats === null) {
				if (receipts.delete(path)) changed = true;
				continue;
			}
			const identity = identityOf(stats);
			const cached = receipts.get(path);
			// An unchanged runs.json hands back the same envelope objects, so the
			// pairing can only have moved when the ledger itself was re-read.
			const envelopeJson = envelopesChanged || cached === undefined ? JSON.stringify(envelope) : cached.envelopeJson;
			if (cached !== undefined && sameIdentity(cached.identity, identity) && cached.envelopeJson === envelopeJson) {
				if (cached.source !== null) sources.push(cached.source);
				continue;
			}
			changed = true;
			let source: DurableReceiptSource | null = null;
			try {
				const receipt = JSON.parse(readFile(path)) as unknown;
				if (isObject(receipt)) source = { receipt: receipt as unknown as RunReceipt, envelope };
			} catch {
				source = null;
			}
			receipts.set(path, { identity, envelopeJson, source });
			if (source !== null) sources.push(source);
		}
		for (const path of [...receipts.keys()]) {
			if (seen.has(path)) continue;
			receipts.delete(path);
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
			const ledger = readEnvelopes();
			const receiptRead = readReceipts(ledger.envelopes, ledger.changed);
			const gateRead = readGates();
			if (last !== null && !receiptRead.changed && !gateRead.changed) return last;
			version += 1;
			last = { receipts: receiptRead.sources, gates: gateRead.artifacts, version };
			return last;
		},
	};
}
