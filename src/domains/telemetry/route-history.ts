/**
 * Route history as a fold over this host's run journals (#434).
 *
 * Every run that settled under a route decision carries, on its run.settled, the executed route's whole identity,
 * its outcome, priced spend, cache reads, attempt and phase timing. Route policy and readiness read that history from
 * here; nothing else persists it. A run's entry is re-read whenever its bundle, journal segments or objects change
 * identity, so a dispatch reads only changed runs. Once a sealed run is folded, its key is the stat of its directory,
 * its bundle and every segment and object the seal covers, at paths listed when it was folded, so a cache hit lists no
 * directory and a file rewritten in place is folded again (r5-3). The fold covers the newest runs only, by directory
 * time, as adaptive routing reads no older history. No index file exists.
 */

import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { listStateDirectorySync, withinStateRoot } from "../../core/state-boundary.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact } from "../../core/telemetry/fact.js";
import type { RecordedRunSettled, RunSettled } from "../../core/telemetry/schemas.js";
import {
	telemetryBundlePath,
	telemetryJournalFiles,
	telemetryObjectsDirectory,
	telemetryRunDirectory,
	telemetryRunsDirectory,
} from "./paths.js";
import { readRunRecordWithSealedRecords, type SettledRunRecord } from "./run-record.js";

/**
 * The run's settled outcome as its record states it: `success`, or the most specific failure class it carries (an
 * outcome code such as `worker_tool_call_cap_exhausted`, `permission_required`, a non-generic outcome such as
 * `timed_out`), else `failure`. Quality labels stay reserved for independent evidence; this label is what every
 * settled route carries. Adaptive routing does not read it yet; routing on it needs a recorded decision first.
 */
export function routeSettledLabel(
	settled: Pick<RunSettled, "outcome"> & {
		outcomeCode?: RunSettled["outcomeCode"] | undefined;
		outcomeDetail?: RunSettled["outcomeDetail"] | undefined;
	},
): string {
	if (settled.outcome === "succeeded") return "success";
	if (settled.outcomeCode !== undefined && settled.outcomeCode !== null) return settled.outcomeCode;
	if (/^permission_required(?:;|$)/u.test(settled.outcomeDetail ?? "")) return "permission_required";
	return settled.outcome === "failed" ? "failure" : settled.outcome;
}

export type RouteReliabilityOutcome = "success" | "failure" | "neutral";

/**
 * The executed route identity a history entry is keyed and drift-checked by, its role as the run recorded it: a run
 * settled before fleet M12 names a retired role, which matches no current route.
 */
export type RouteHistoryIdentity = NonNullable<RecordedRunSettled["routeDecision"]>["executed"];

/** One settled run on this host, as the route quality reduction reads it. */
export interface SettledRunFacts {
	runId: string;
	/** The run's identity, the digest of its run.settled. */
	digest: string;
	/** Only a run whose seal verifies may contribute quality, cost or timing; any other is an integrity failure. */
	sealVerified: boolean;
	facts: SettledRunRecord["settled"];
}

/** One settled run that executed under a route decision, as route policy and readiness read it. */
export interface RouteHistoryEntry extends SettledRunFacts {
	settledAt: string;
	route: RouteHistoryIdentity;
	decision: { decisionHash: string; mode: "fixed" | "shadow" | "active"; durationMs: number; constraintsValid: boolean };
	settled: string;
	/** A canceled, policy-denied or permission-stopped run is neutral: it says nothing about the route. */
	reliability: RouteReliabilityOutcome;
	/** Succeeded on the assignment's first attempt; retries are never independent first-pass work. */
	firstPass: boolean;
	/** The run's spend when every part of it was priced; unknown when any part went unpriced, never read as free. */
	pricedCostUsd: Fact<number>;
	/** Whether the run read cache tokens, as measured; null when not measured. */
	cacheRead: boolean | null;
	phaseTiming: RunSettled["phaseTiming"];
	/**
	 * The seat debit the run's runtime reported, summed over its sealed `call.settled` billing when every call reported
	 * a measured one; absent otherwise, so the economics fold falls back to its estimate and never mixes the two.
	 */
	reportedNanoAiu?: Fact<number>;
}

function reliabilityOf(settled: SettledRunRecord["settled"]): RouteReliabilityOutcome {
	const detail = settled.outcomeDetail?.toLowerCase() ?? "";
	if (
		settled.outcome === "canceled" ||
		settled.outcome === "denied_by_policy" ||
		(detail.includes("permission") && (detail.includes("denied") || detail.includes("required")))
	)
		return "neutral";
	return settled.outcome === "succeeded" ? "success" : "failure";
}

function pricedCostOf(settled: SettledRunRecord["settled"]): Fact<number> {
	const usd = settled.pricing.usd;
	return usd.kind === "measured" || usd.kind === "estimated" ? usd : { kind: "unknown", reason: "not-observed" };
}

/** The history entry a settled run contributes; null for a run settled under no route decision. */
export function routeHistoryEntry(record: SettledRunRecord): RouteHistoryEntry | null {
	return routeEntryOf(settledRunFacts(record));
}

function settledRunFacts(record: SettledRunRecord): SettledRunFacts {
	return {
		runId: record.row.runId,
		digest: record.settled.digest,
		sealVerified: record.seal?.status === "verified",
		facts: record.settled,
	};
}

/** The run's reported seat debit, read only from the records its verified seal vouches for. */
function reportedSeatDebit(run: SettledRunFacts, sealed: readonly TelemetryRecord[] | null): Fact<number> | undefined {
	if (!run.sealVerified || sealed === null || run.facts.routeDecision === null) return undefined;
	const calls = sealed.flatMap((record) => (record.k === "call.settled" ? [record.data] : []));
	let total = 0;
	for (const call of calls) {
		const debit = call.billing?.nanoAiu;
		if (debit?.kind !== "measured") return undefined;
		total += debit.value;
	}
	return calls.length > 0 && Number.isSafeInteger(total)
		? { kind: "measured", value: total, source: "provider" }
		: undefined;
}

function routeEntryOf(run: SettledRunFacts, reportedNanoAiu?: Fact<number>): RouteHistoryEntry | null {
	const settled = run.facts;
	const decision = settled.routeDecision;
	if (decision === null) return null;
	const cacheRead = settled.usage.cacheRead;
	return {
		...run,
		settledAt: settled.endedAt,
		route: decision.executed,
		decision: {
			decisionHash: decision.decisionHash,
			mode: decision.mode,
			durationMs: decision.durationMs,
			constraintsValid: decision.constraintsValid,
		},
		settled: routeSettledLabel(settled),
		reliability: reliabilityOf(settled),
		firstPass: settled.outcome === "succeeded" && settled.attempt === 0,
		pricedCostUsd: pricedCostOf(settled),
		cacheRead: cacheRead.kind === "measured" ? cacheRead.value > 0 : null,
		phaseTiming: settled.phaseTiming,
		...(reportedNanoAiu ? { reportedNanoAiu } : {}),
	};
}

export interface RouteHistoryRead {
	entries: ReadonlyArray<RouteHistoryEntry>;
	/** Every settled run, route entries included: a gate may cite a run that settled under no route decision. */
	runs: ReadonlyArray<SettledRunFacts>;
	/** Changes whenever any entry was added, re-read or removed since the last read. */
	version: number;
}

export interface RouteHistoryFold {
	read(): RouteHistoryRead;
	/**
	 * Fold unread run scopes one per macrotask until `stopped` answers true, so the
	 * synchronous `read` a dispatch makes finds them cached. A cold read parses every
	 * retained journal on the input thread, 8 to 14 ms a run, before the worker card can
	 * paint. Warming decides nothing: `read` still revalidates each scope's identity.
	 */
	warm?(stopped: () => boolean): Promise<void>;
}

const HISTORY_MAX_RUNS = 2_000;
const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function statOrNull(path: string): Stats | null {
	try {
		return lstatSync(path);
	} catch {
		return null;
	}
}

/** A seal covers every segment and object, so any changed or missing file invalidates the cached verdict (#434). */
function scopeIdentity(directory: string): string | null {
	try {
		const dir = lstatSync(directory);
		if (!dir.isDirectory()) return null;
		const paths = [
			directory,
			telemetryBundlePath(directory),
			...telemetryJournalFiles(readdirSync(directory)).map((name) => join(directory, name)),
		];
		const objects = telemetryObjectsDirectory(directory);
		paths.push(objects);
		try {
			paths.push(
				...readdirSync(objects)
					.sort()
					.map((name) => join(objects, name)),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		return JSON.stringify(
			paths.map((path) => {
				const stats = statOrNull(path);
				return [path, stats === null ? null : [stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]];
			}),
		);
	} catch {
		// An unreadable scope cannot contribute evidence (#434).
		return null;
	}
}

function sortEntries(left: RouteHistoryEntry, right: RouteHistoryEntry): number {
	return left.settledAt.localeCompare(right.settledAt) || left.digest.localeCompare(right.digest);
}

/** The incremental fold; an unchanged run hands back the same entry object, so callers can memoize by identity. */
export function createRouteHistoryFold(options: { stateDir: string }): RouteHistoryFold {
	const cache = new Map<
		string,
		{
			identity: string;
			sealed: { paths: string[]; key: string } | null;
			run: SettledRunFacts | null;
			entry: RouteHistoryEntry | null;
		}
	>();
	/** Sealed runs outside the bound; a sealed run only ages, so it is never stat'd again while it stays listed. */
	const retired = new Set<string>();
	const statKey = (stats: Stats): string => `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
	const isSealed = (directory: string): boolean => statOrNull(telemetryBundlePath(directory))?.isFile() === true;
	/**
	 * The stat of the directory, its bundle and each of `paths`; null while the run is unsealed. A write in place to a
	 * file that already exists moves only that file's stat, never its directory's, so each covered file is stat'd (r5-3).
	 */
	const sealedKeyOf = (directory: string, dir: Stats, paths: readonly string[]): string | null => {
		const bundle = statOrNull(telemetryBundlePath(directory));
		if (bundle?.isFile() !== true) return null;
		const parts = [statKey(dir), statKey(bundle)];
		for (const path of paths) {
			const stats = statOrNull(path);
			parts.push(stats === null ? "-" : statKey(stats));
		}
		return parts.join("|");
	};
	/**
	 * The files a sealed run's seal covers besides its bundle: its segments, its objects directory and each object. The
	 * directory stats in the key move with any entry added, removed or renamed, so the listing holds while they match.
	 */
	const sealedScopeOf = (directory: string, dir: Stats): { paths: string[]; key: string } | null => {
		if (!isSealed(directory)) return null;
		const objects = telemetryObjectsDirectory(directory);
		const objectsKey = (): string => {
			const stats = statOrNull(objects);
			return stats === null ? "-" : statKey(stats);
		};
		try {
			const paths = [...telemetryJournalFiles(readdirSync(directory)).map((name) => join(directory, name)), objects];
			const listed = objectsKey();
			if (listed !== "-")
				paths.push(
					...readdirSync(objects)
						.sort()
						.map((name) => join(objects, name)),
				);
			const key = sealedKeyOf(directory, dir, paths);
			// An object written while it was listed: the next read takes the full identity path instead.
			return key === null || objectsKey() !== listed ? null : { paths, key };
		} catch {
			return null;
		}
	};
	let version = 0;
	let last: RouteHistoryRead | null = null;
	// A scope warmed since the last read is a cache hit there, but `last` does not hold it.
	let warmedSinceRead = false;
	const listRuns = (): string[] => {
		try {
			return listStateDirectorySync(options.stateDir, telemetryRunsDirectory(options.stateDir));
		} catch {
			// No run has opened a journal on this host yet.
			return [];
		}
	};
	const foldRun = (runId: string, identity: string) => {
		const directory = telemetryRunDirectory(options.stateDir, runId);
		// Taken before the read: any later change to the scope's entries moves the directory's own stat.
		const dir = statOrNull(directory);
		const sealed = dir === null ? null : sealedScopeOf(directory, dir);
		let run: SettledRunFacts | null = null;
		let reported: Fact<number> | undefined;
		try {
			const read = readRunRecordWithSealedRecords(options.stateDir, runId);
			run = read?.run.settled ? settledRunFacts(read.run as SettledRunRecord) : null;
			reported = run && read ? reportedSeatDebit(run, read.sealed) : undefined;
		} catch {
			// An unreadable run scope contributes no history.
			run = null;
		}
		const folded = { identity, sealed, run, entry: run === null ? null : routeEntryOf(run, reported) };
		cache.set(runId, folded);
		return folded;
	};
	/**
	 * The runs the fold covers, newest first: one lstat per listed run not yet retired, then the newest
	 * `HISTORY_MAX_RUNS` from the last `HISTORY_MAX_AGE_MS` by directory time. A sealed run outside the bound is retired.
	 * A symlink is not a directory, so it never enters (#434).
	 */
	const boundedScopes = (): Array<{ runId: string; directory: string; stats: Stats }> => {
		const names = listRuns();
		const listed = new Set(names);
		for (const runId of retired) if (!listed.has(runId)) retired.delete(runId);
		const scopes: Array<{ runId: string; directory: string; stats: Stats }> = [];
		for (const runId of names) {
			if (retired.has(runId)) continue;
			let directory: string;
			try {
				directory = telemetryRunDirectory(options.stateDir, runId);
			} catch {
				// A name that is not a safe run id is not a run scope.
				continue;
			}
			const stats = statOrNull(directory);
			if (stats?.isDirectory()) scopes.push({ runId, directory, stats });
		}
		const oldest = Date.now() - HISTORY_MAX_AGE_MS;
		scopes.sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs);
		const bounded = scopes.filter((scope) => scope.stats.mtimeMs >= oldest).slice(0, HISTORY_MAX_RUNS);
		const kept = new Set(bounded);
		for (const scope of scopes) if (!kept.has(scope) && isSealed(scope.directory)) retired.add(scope.runId);
		return bounded;
	};
	return {
		async warm(stopped) {
			for (const { runId, directory } of boundedScopes()) {
				if (stopped()) return;
				const identity = withinStateRoot(options.stateDir, directory) ? scopeIdentity(directory) : null;
				if (identity === null || cache.get(runId)?.identity === identity) continue;
				foldRun(runId, identity);
				warmedSinceRead = true;
				await new Promise<void>((resolve) => setImmediate(resolve).unref());
			}
		},
		read() {
			let changed = warmedSinceRead;
			warmedSinceRead = false;
			const seen = new Set<string>();
			const entries: RouteHistoryEntry[] = [];
			const runs: SettledRunFacts[] = [];
			for (const { runId, directory, stats } of boundedScopes()) {
				const cached = cache.get(runId);
				// A sealed run whose directory, bundle, segments and objects are unchanged is the run already folded.
				if (
					cached !== undefined &&
					cached.sealed !== null &&
					cached.sealed.key === sealedKeyOf(directory, stats, cached.sealed.paths)
				) {
					seen.add(runId);
					if (cached.run !== null) runs.push(cached.run);
					if (cached.entry !== null) entries.push(cached.entry);
					continue;
				}
				// A run scope that is symlinked or leaves the state root is not this host's route history (#434).
				const identity = withinStateRoot(options.stateDir, directory) ? scopeIdentity(directory) : null;
				if (identity === null) continue;
				seen.add(runId);
				if (cached !== undefined && cached.identity === identity) {
					if (cached.run !== null) runs.push(cached.run);
					if (cached.entry !== null) entries.push(cached.entry);
					continue;
				}
				changed = true;
				const { run, entry } = foldRun(runId, identity);
				if (run !== null) runs.push(run);
				if (entry !== null) entries.push(entry);
			}
			for (const runId of [...cache.keys()]) {
				if (seen.has(runId)) continue;
				cache.delete(runId);
				changed = true;
			}
			if (last !== null && !changed) return last;
			version += 1;
			last = { entries: entries.sort(sortEntries), runs, version };
			return last;
		},
	};
}
