/**
 * The local measurement artifact: what `clio-coder systemone calibrate` proved
 * about one answering build, and the only way an LLM engine's reading acts.
 *
 * A file is keyed by what was asked (runtime, endpoint, requested model, prompt)
 * and names the build that answered: the model name and fingerprint the server
 * reported. The runner compares every response's build against it, so any change
 * voids the measurement at once. It cannot detect a checkpoint swapped behind the
 * same name and fingerprint. A site's cuts apply only under the site version they
 * were measured on, and a reworded site goes silent until it is measured again.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { clioDataDir } from "../../core/xdg.js";
import type { LocalCuts } from "./calibration.js";
import { TOOL_CALL_CARD_SITE } from "./sites/tool-call.js";
import { TURN_SITE, WORKER_PREPARE_SITE } from "./sites/turn.js";
import type { SiteId } from "./types.js";

/** The label rule's version; a change to it voids every measurement. */
export const LABEL_POLICY_VERSION = "labels-v1";

/** The site version each measured site must still carry for its cuts to apply. */
export const MEASURED_SITE_VERSIONS: Readonly<Partial<Record<SiteId, string>>> = {
	turn: TURN_SITE.version,
	workerPrepare: WORKER_PREPARE_SITE.version,
	toolCall: TOOL_CALL_CARD_SITE.version,
};

export interface LabelTally {
	/** Cases where the action should fire, and those of them where it did. */
	readonly positives: number;
	readonly hits: number;
	/** Cases where firing is wrong, and those of them where it did. */
	readonly negatives: number;
	readonly falseFires: number;
}

export interface KeyMeasurement {
	readonly pass: boolean;
	/** What a false fire costs: 2 spends real work, 1 is read-only or advisory. */
	readonly k: 1 | 2;
	readonly fit: LabelTally;
	/** Absent when the key failed on fit and its holdout was not scored. */
	readonly holdout?: LabelTally;
	/** Why the key did not pass. */
	readonly reason?: string;
}

export interface SiteMeasurement {
	readonly version: string;
	/** SHA-256 of the labeled case file this site was scored on. */
	readonly caseSet: string;
	readonly requests: number;
	readonly failed: number;
	readonly tokens: { readonly input: number; readonly output: number };
	readonly latencyMs: { readonly p50: number; readonly p95: number; readonly max: number };
	/** How long a call may run on this route, from `latencyMs`. */
	readonly deadlineMs: number;
}

export interface Measurement {
	readonly v: 1;
	readonly requestKey: string;
	readonly build: string;
	readonly measuredAt: string;
	readonly policy: string;
	readonly sites: Readonly<Record<string, SiteMeasurement>>;
	/** `<site>.<key>` to what the labels showed. */
	readonly keys: Readonly<Record<string, KeyMeasurement>>;
}

/** What production reads: every current measurement, indexed. */
export interface MeasurementIndex {
	readonly cuts: LocalCuts;
	buildsFor(requestKey: string): ReadonlyArray<string>;
	/** The measured deadline for `site` under one of these builds, or null. */
	deadlineMs(site: SiteId, builds: ReadonlyArray<string>): number | null;
}

function measurementDir(dataDir: string = clioDataDir()): string {
	return join(dataDir, "system-one", "measurements");
}

function fileStem(requestKey: string): string {
	return createHash("sha256").update(requestKey).digest("hex").slice(0, 16);
}

export function readMeasurement(requestKey: string, dir: string = measurementDir()): Measurement | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, `${fileStem(requestKey)}.json`), "utf8"));
		return isMeasurement(parsed) && parsed.requestKey === requestKey ? parsed : null;
	} catch {
		// No readable file is no measurement, and an unmeasured route sends nothing.
		return null;
	}
}

/** One measurement per request key: a new run replaces the last, whatever build it names. */
export function writeMeasurement(
	measurement: Measurement,
	raw: ReadonlyArray<unknown>,
	dir: string = measurementDir(),
): string {
	const stem = fileStem(measurement.requestKey);
	safeResourceWrite(join(dir, `${stem}.raw.jsonl`), raw.map((row) => JSON.stringify(row)).join("\n"));
	const path = join(dir, `${stem}.json`);
	safeResourceWrite(path, `${JSON.stringify(measurement, null, "\t")}\n`);
	return path;
}

function isMeasurement(value: unknown): value is Measurement {
	if (typeof value !== "object" || value === null) return false;
	const row = value as Partial<Measurement>;
	return (
		row.v === 1 &&
		typeof row.requestKey === "string" &&
		typeof row.build === "string" &&
		typeof row.sites === "object" &&
		row.sites !== null &&
		typeof row.keys === "object" &&
		row.keys !== null
	);
}

/** Only what still describes this code: the policy, the site version and a passing key. */
export function indexMeasurements(measurements: ReadonlyArray<Measurement>): MeasurementIndex {
	const cuts: Record<string, Record<string, number>> = {};
	const builds = new Map<string, string[]>();
	const current = measurements.filter((measurement) => measurement.policy === LABEL_POLICY_VERSION);
	const siteCurrent = (measurement: Measurement, site: string): boolean =>
		measurement.sites[site]?.version === MEASURED_SITE_VERSIONS[site as SiteId];
	for (const measurement of current) {
		builds.set(measurement.requestKey, [...(builds.get(measurement.requestKey) ?? []), measurement.build]);
		for (const [key, result] of Object.entries(measurement.keys)) {
			if (!result.pass || !siteCurrent(measurement, key.split(".")[0] ?? "")) continue;
			// A label's mass is 0 or 1, so a cut of 1 fires on the label the measurement validated and on nothing else.
			cuts[measurement.build] = { ...cuts[measurement.build], [key]: 1 };
		}
	}
	return {
		cuts,
		buildsFor: (requestKey) => builds.get(requestKey) ?? [],
		deadlineMs(site, wanted) {
			for (const measurement of current) {
				if (!wanted.includes(measurement.build) || !siteCurrent(measurement, site)) continue;
				const deadline = measurement.sites[site]?.deadlineMs;
				if (deadline !== undefined) return deadline;
			}
			return null;
		},
	};
}

const EMPTY = indexMeasurements([]);

/** A reader cached on the directory's own change time, because the runner reads it on every call. */
export function createMeasurementReader(dir: () => string = measurementDir): () => MeasurementIndex {
	let seen: { path: string; mtimeMs: number; index: MeasurementIndex } | null = null;
	return () => {
		const path = dir();
		let mtimeMs: number;
		try {
			mtimeMs = statSync(path).mtimeMs;
		} catch {
			// No directory has no measurement.
			return EMPTY;
		}
		if (seen !== null && seen.path === path && seen.mtimeMs === mtimeMs) return seen.index;
		const rows: Measurement[] = [];
		for (const name of readdirSync(path)) {
			if (!name.endsWith(".json")) continue;
			try {
				const parsed: unknown = JSON.parse(readFileSync(join(path, name), "utf8"));
				if (isMeasurement(parsed)) rows.push(parsed);
			} catch {
				// One unreadable file costs its own route's measurement and nothing else.
			}
		}
		seen = { path, mtimeMs, index: indexMeasurements(rows) };
		return seen.index;
	};
}
