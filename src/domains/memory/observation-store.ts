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
				const retireAfterWrite = existsSync(directory) ? makeRoom(stateDir, directory, batch) : [];
				if (retireAfterWrite === null) return false;
				const path = join(directory, `${batch.id}.json`);
				if (existsSync(path)) return false;
				safeResourceWrite(path, JSON.stringify(batch), { mode: 0o600 });
				// Only a reflection now on disk may retire its own inputs; a write
				// that threw above left them in place as the fallback.
				for (const name of retireAfterWrite) {
					try {
						unlinkSync(join(directory, name));
					} catch {
						// Already removed by another process holding a newer view.
					}
				}
				return true;
			},
			{ timeoutMs: 100 },
		);
	} catch {
		return false; /* A sidecar failure cannot affect the canonical ledger. */
	}
}

/**
 * At the artifact cap, drop files no reader loads (corrupt, or written in a
 * format this build rejects), then the oldest batches prepared against
 * another checkpoint or branch anchor (compaction replaced the history they
 * describe, or a resume or navigation re-anchored the scope, so no offer can
 * use them on this lineage), then batches a stored reflection already
 * replaces. A reflection being written also frees its own inputs, so
 * consolidation still fits when the journal is full, but only once it is
 * written: those names come back to the caller instead of being removed here,
 * so a failed write keeps them, and the directory holds one file over the cap
 * until they go. Null means no room. Unconsumed optimization artifacts are the
 * only thing discarded; nothing here touches the ledger or a committed
 * checkpoint.
 */
function makeRoom(stateDir: string, directory: string, batch: SessionObservation): string[] | null {
	const names = () => readdirSync(directory).filter((name) => name.endsWith(".json"));
	if (names().length < OBSERVATION_MAX_BATCHES) return [];
	const current = JSON.stringify(batch.checkpoint);
	const stored = loadObservations(stateDir, batch.scope.sessionId);
	const own = new Set(
		stored
			.filter((candidate) => batch.inputs.some((input) => input.id === candidate.id && input.digest === candidate.digest))
			.map((candidate) => `${candidate.id}.json`),
	);
	const loaded = new Set(stored.map((candidate) => `${candidate.id}.json`));
	const unreadable = names().filter((name) => !loaded.has(name));
	const stale = stored
		.filter(
			(candidate) =>
				JSON.stringify(candidate.checkpoint) !== current ||
				candidate.scope.branchAnchorTurnId !== batch.scope.branchAnchorTurnId,
		)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	const replaced = stored.flatMap((reflection) => reflection.inputs);
	const superseded = stored.filter((candidate) =>
		replaced.some((input) => input.id === candidate.id && input.digest === candidate.digest),
	);
	for (const name of [...unreadable, ...[...stale, ...superseded].map((candidate) => `${candidate.id}.json`)]) {
		if (names().length < OBSERVATION_MAX_BATCHES) break;
		if (own.has(name)) continue;
		try {
			unlinkSync(join(directory, name));
		} catch {
			// Already removed by another process holding a newer view.
		}
	}
	const remaining = names();
	if (remaining.length < OBSERVATION_MAX_BATCHES) return [];
	// Just enough of them to end back at the cap once the reflection is added.
	const retire = remaining.filter((name) => own.has(name)).slice(0, remaining.length + 1 - OBSERVATION_MAX_BATCHES);
	return remaining.length + 1 - retire.length <= OBSERVATION_MAX_BATCHES ? retire : null;
}

/** Remove named optimization artifacts whose identity and digest still match; raw history is untouched. */
export function retireObservations(stateDir: string, sessionId: string, retired: ReadonlyMap<string, string>): void {
	if (retired.size === 0) return;
	try {
		const directory = observationDirectory(stateDir, sessionId);
		if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()) return;
		withStateFileLockSync(
			join(directory, "artifacts"),
			() => {
				for (const batch of loadObservations(stateDir, sessionId))
					if (retired.get(batch.id) === batch.digest) unlinkSync(join(directory, `${batch.id}.json`));
			},
			{ timeoutMs: 100 },
		);
	} catch {
		/* Optional sidecar cleanup cannot change canonical history; the next cap check retries. */
	}
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
