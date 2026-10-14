import { existsSync, lstatSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import type { SessionObservation } from "./contract.js";
import { isSessionObservation, OBSERVATION_MAX_BATCHES, OBSERVATION_MAX_BYTES } from "./observations.js";

function observationDirectory(stateDir: string, sessionId: string): string {
	if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) throw new Error("invalid observation session identity");
	return join(stateDir, "memory", "observations", sessionId);
}

/** Readers never create directories. Immutable files make the index rebuildable across processes. */
export function loadObservations(stateDir: string, sessionId: string): SessionObservation[] {
	const directory = observationDirectory(stateDir, sessionId);
	const batches: SessionObservation[] = [];
	let bytes = 0;
	try {
		if (lstatSync(directory).isSymbolicLink()) return [];
		const files = readdirSync(directory)
			.filter((name) => /^[a-zA-Z0-9_-]{1,128}\.json$/u.test(name))
			.sort();
		for (const file of files.slice(0, OBSERVATION_MAX_BATCHES)) {
			try {
				const path = join(directory, file);
				const stat = lstatSync(path);
				if (!stat.isFile() || stat.size > OBSERVATION_MAX_BYTES || bytes + stat.size > 2 * 1024 * 1024) continue;
				bytes += stat.size;
				const batch: unknown = JSON.parse(readFileSync(path, "utf8"));
				if (isSessionObservation(batch) && batch.id === file.slice(0, -5) && batch.scope.sessionId === sessionId)
					batches.push(batch);
			} catch {
				/* A missing/corrupt optimization artifact leaves its source raw. */
			}
		}
	} catch {
		/* Absent state is ordinary fallback, including after sidecars were removed. */
	}
	return batches;
}

export function persistObservation(stateDir: string, batch: SessionObservation): boolean {
	if (!isSessionObservation(batch) || !existsSync(stateDir)) return false;
	const directory = observationDirectory(stateDir, batch.scope.sessionId);
	try {
		return withStateFileLockSync(
			join(directory, "artifacts"),
			() => {
				if (!existsSync(stateDir) || (existsSync(directory) && lstatSync(directory).isSymbolicLink())) return false;
				if (existsSync(directory) && !makeRoom(stateDir, directory, batch)) return false;
				const path = join(directory, `${batch.id}.json`);
				if (existsSync(path)) return false;
				safeResourceWrite(path, JSON.stringify(batch), { mode: 0o600 });
				return true;
			},
			{ timeoutMs: 100 },
		);
	} catch {
		return false; /* A sidecar failure cannot affect the canonical ledger. */
	}
}

/**
 * At the artifact cap, drop the oldest batches prepared against another
 * checkpoint: compaction replaced the history they describe, so no offer can
 * use them on this lineage. Unconsumed optimization artifacts are the only
 * thing discarded; nothing here touches the ledger or a committed checkpoint.
 */
function makeRoom(stateDir: string, directory: string, batch: SessionObservation): boolean {
	const count = () => readdirSync(directory).filter((name) => name.endsWith(".json")).length;
	if (count() < OBSERVATION_MAX_BATCHES) return true;
	const current = JSON.stringify(batch.checkpoint);
	const stale = loadObservations(stateDir, batch.scope.sessionId)
		.filter((candidate) => JSON.stringify(candidate.checkpoint) !== current)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	for (const candidate of stale) {
		if (count() < OBSERVATION_MAX_BATCHES) break;
		unlinkSync(join(directory, `${candidate.id}.json`));
	}
	return count() < OBSERVATION_MAX_BATCHES;
}

/** Only a durable ledger receipt authorizes retiring these optional files; raw history stays authoritative. */
export function pruneConsumedObservations(
	stateDir: string,
	sessionId: string,
	consumed: ReadonlyMap<string, string>,
): void {
	const directory = observationDirectory(stateDir, sessionId);
	if (!existsSync(directory) || !consumed.size) return;
	try {
		if (lstatSync(directory).isSymbolicLink()) return;
		withStateFileLockSync(
			join(directory, "artifacts"),
			() => {
				for (const batch of loadObservations(stateDir, sessionId))
					if (consumed.get(batch.id) === batch.digest) unlinkSync(join(directory, `${batch.id}.json`));
			},
			{ timeoutMs: 100 },
		);
	} catch {
		/* Optional sidecar cleanup cannot change a durable checkpoint. */
	}
}
