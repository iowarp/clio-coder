/**
 * Bounded newest-first listing of the eval reports this installation stored.
 *
 * The store has always been addressed by id: `eval report <evalId>` and
 * `eval compare <a> <b>` both require the operator to already know which report
 * they want. Nothing enumerated the directory, so a surface that wants to offer
 * the choice had to invent the enumeration. This is that enumeration, and it is
 * a store concern rather than a wire concern: it decides which files are in the
 * window and hands back parsed artifacts, and says nothing about which of their
 * fields may leave the host.
 */

import { readdir } from "node:fs/promises";
import { loadEvalArtifactV4 } from "./artifacts/store.js";
import type { EvalArtifactV4 } from "./schema/artifact.js";
import { evalRoot } from "./store.js";

/**
 * The exact shape `createEvalId` mints: an ISO stamp with its separators
 * stripped, the first eight characters of the suite hash, and a random suffix.
 */
const EVAL_ID_PATTERN = /^eval-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-([0-9a-f]{8})-([0-9a-f]{12})$/u;

export interface EvalStoredReport {
	readonly evalId: string;
	/**
	 * The instant the run started, read back out of the id.
	 *
	 * Null unless the id is one this harness minted and its embedded suite-hash
	 * prefix agrees with the suite the artifact names. An artifact has no
	 * timestamp field of its own, so the id is the only record of when it ran,
	 * and a stamp read off an id that does not otherwise match its contents is
	 * not a fact worth reporting.
	 */
	readonly startedAt: string | null;
	readonly artifact: EvalArtifactV4;
}

export interface EvalStoreListing {
	/** False when the installation has no eval store at all, which reads differently from an empty one. */
	readonly available: boolean;
	/** Reports on disk before the window bound. */
	readonly stored: number;
	readonly reports: readonly EvalStoredReport[];
	/**
	 * Files inside the window the current parser refused.
	 *
	 * Counted rather than dropped silently. Routing accepts artifact v4 only, so
	 * a retired shape still on disk is a real thing in this store, and a listing
	 * that quietly skipped it would report a smaller store than the operator has.
	 */
	readonly unreadable: number;
}

/** The stamp an id carries, without checking it against anything. */
function idStamp(evalId: string): { startedAt: string; suiteHashPrefix: string } | null {
	const match = EVAL_ID_PATTERN.exec(evalId);
	if (match === null) return null;
	const [, year, month, day, hour, minute, second, millisecond, suiteHashPrefix] = match;
	const startedAt = `${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`;
	const parsed = new Date(startedAt);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== startedAt) return null;
	return { startedAt, suiteHashPrefix: suiteHashPrefix as string };
}

/** Newest first. An id this harness did not mint sorts oldest rather than throwing. */
function byNewest(left: string, right: string): number {
	const leftStamp = idStamp(left)?.startedAt ?? "";
	const rightStamp = idStamp(right)?.startedAt ?? "";
	if (leftStamp !== rightStamp) return leftStamp < rightStamp ? 1 : -1;
	return left < right ? 1 : -1;
}

export async function listEvalReports(dataDir: string, limit: number): Promise<EvalStoreListing> {
	let entries: string[];
	try {
		entries = await readdir(evalRoot(dataDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { available: false, stored: 0, reports: [], unreadable: 0 };
		}
		throw error;
	}
	const ids = entries
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => entry.slice(0, -".json".length))
		.sort(byNewest);
	const reports: EvalStoredReport[] = [];
	let unreadable = 0;
	for (const evalId of ids.slice(0, limit)) {
		let artifact: EvalArtifactV4;
		try {
			artifact = await loadEvalArtifactV4(dataDir, evalId);
		} catch {
			unreadable += 1;
			continue;
		}
		// The id inside the file is authoritative. A file whose stem disagrees with
		// it was renamed or copied in, and the two names it now answers to are not
		// the same report.
		if (artifact.evalId !== evalId) {
			unreadable += 1;
			continue;
		}
		const stamp = idStamp(evalId);
		reports.push({
			evalId,
			startedAt: stamp !== null && artifact.suite.hash.startsWith(stamp.suiteHashPrefix) ? stamp.startedAt : null,
			artifact,
		});
	}
	return { available: true, stored: ids.length, reports, unreadable };
}
