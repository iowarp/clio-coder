/**
 * Route history as a fold over this host's run journals (#434).
 *
 * Every run that settled under a route decision carries, on its run.settled, the executed route's whole identity,
 * its outcome, priced spend, cache reads, attempt and phase timing. Route policy and readiness read that history from
 * here; nothing else persists it. A run's entry is re-read whenever its bundle, journal segments or objects change
 * identity, so a dispatch stats each scope file and reads only changed runs. No index file exists.
 */

import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Fact } from "../../core/telemetry/fact.js";
import type { RunSettled } from "../../core/telemetry/schemas.js";
import {
	telemetryBundlePath,
	telemetryJournalFiles,
	telemetryObjectsDirectory,
	telemetryRunDirectory,
	telemetryRunsDirectory,
} from "./paths.js";
import { readRunRecord, type SettledRunRecord } from "./run-record.js";

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

/** The executed route identity a history entry is keyed and drift-checked by. */
export type RouteHistoryIdentity = NonNullable<RunSettled["routeDecision"]>["executed"];

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

function routeEntryOf(run: SettledRunFacts): RouteHistoryEntry | null {
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
}

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
	const cache = new Map<string, { identity: string; run: SettledRunFacts | null; entry: RouteHistoryEntry | null }>();
	let version = 0;
	let last: RouteHistoryRead | null = null;
	return {
		read() {
			let names: string[] = [];
			try {
				names = readdirSync(telemetryRunsDirectory(options.stateDir));
			} catch {
				// No run has opened a journal on this host yet.
				names = [];
			}
			let changed = false;
			const seen = new Set<string>();
			const entries: RouteHistoryEntry[] = [];
			const runs: SettledRunFacts[] = [];
			for (const runId of names) {
				let directory: string;
				try {
					directory = telemetryRunDirectory(options.stateDir, runId);
				} catch {
					// A name that is not a safe run id is not a run scope.
					continue;
				}
				const identity = scopeIdentity(directory);
				if (identity === null) continue;
				seen.add(runId);
				const cached = cache.get(runId);
				if (cached !== undefined && cached.identity === identity) {
					if (cached.run !== null) runs.push(cached.run);
					if (cached.entry !== null) entries.push(cached.entry);
					continue;
				}
				changed = true;
				let run: SettledRunFacts | null = null;
				try {
					const record = readRunRecord(options.stateDir, runId);
					run = record?.settled ? settledRunFacts(record as SettledRunRecord) : null;
				} catch {
					// An unreadable run scope contributes no history.
					run = null;
				}
				const entry = run === null ? null : routeEntryOf(run);
				cache.set(runId, { identity, run, entry });
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
