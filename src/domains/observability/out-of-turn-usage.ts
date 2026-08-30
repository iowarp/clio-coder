/**
 * Durable record of the model calls that were billed beside a session rather
 * than inside it: `/btw` side questions, `/handoff` extraction rounds, and the
 * session pre-warm.
 *
 * These rounds deliberately append nothing to the session JSONL. A fleet run
 * briefs its workers from the transcript, so a question the operator asked to
 * orient themselves must not become context those workers inherit, and
 * `src/interactive/side-question.ts` states that promise as a contract. The
 * money was still spent, though, and until this store existed the only record
 * of it was the in-process cost tracker: `/cost` showed it for as long as the
 * process lived, and `clio-coder usage report`, which reads the archive on
 * disk, could not see it at all.
 *
 * So the spend gets its own file. One JSON line per priced out-of-turn call
 * under `<stateDir>/usage/out-of-turn.jsonl`, carrying the label, the session
 * it sat beside, the repo identity the session ledger is filed under (so
 * `usage report --repo` filters these rows the same way it filters ledgers),
 * the target and attributed model, and the provider-reported usage.
 *
 * Writes follow the audit-row conventions: one append-mode `writeSync` per
 * row, so a line lands whole even with concurrent writers, and a failure is
 * logged to stderr rather than thrown back into the interactive path. The file
 * is a bounded ring: once it grows past {@link MAX_OUT_OF_TURN_USAGE_ROWS} the
 * newest rows are rewritten atomically under the shared state-file lock and
 * the oldest are dropped. Reads are tolerant; a malformed line is reported and
 * skipped, never fatal.
 */

import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import type { CostProvenance } from "../providers/index.js";
import type { CostEntryLabel } from "./cost.js";

/** Directory under the state dir that holds cross-session usage side-cars. */
export const OUT_OF_TURN_USAGE_DIR = "usage";

/** Filename of the out-of-turn usage ledger inside {@link OUT_OF_TURN_USAGE_DIR}. */
export const OUT_OF_TURN_USAGE_FILE = "out-of-turn.jsonl";

/** Cap on retained rows. Matches the dispatch runs ledger and evidence index default. */
export const MAX_OUT_OF_TURN_USAGE_ROWS = 1000;

/**
 * How many appends this process makes between bound checks. Counting rows means
 * reading the file, and an out-of-turn round is rare enough that paying that on
 * the first append of a process and periodically after it keeps the ring bounded
 * without reading a megabyte per side question.
 */
const BOUND_CHECK_INTERVAL = 64;

/** Provider-reported usage for one out-of-turn call. */
export interface OutOfTurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	costUsd: number;
	costProvenance: CostProvenance;
}

/** One priced model call that was billed beside a session rather than inside it. */
export interface OutOfTurnUsageRow {
	label: CostEntryLabel;
	/** Session the round sat beside, or null when no session was current. */
	sessionId: string | null;
	/** The cwd hash the session ledger is filed under, so `--repo` can filter these rows. */
	repoIdentity: string | null;
	/** ISO-8601 timestamp of the call. */
	timestamp: string;
	/** Target id the round ran against. */
	target: string;
	attributedModelId: string;
	usage: OutOfTurnUsage;
}

export interface OutOfTurnUsageReadResult {
	rows: OutOfTurnUsageRow[];
	errors: string[];
}

export function outOfTurnUsagePath(stateDir: string): string {
	return join(stateDir, OUT_OF_TURN_USAGE_DIR, OUT_OF_TURN_USAGE_FILE);
}

let appendsSinceBoundCheck = BOUND_CHECK_INTERVAL;

/**
 * Append one priced out-of-turn call. Never throws: this runs on the same path
 * that answers an operator's side question, and a failed bookkeeping write must
 * not take the answer down with it.
 */
export function appendOutOfTurnUsageRow(stateDir: string, row: OutOfTurnUsageRow): void {
	const path = outOfTurnUsagePath(stateDir);
	try {
		mkdirSync(dirname(path), { recursive: true });
		const fd = openSync(path, "a");
		try {
			writeSync(fd, `${JSON.stringify(row)}\n`);
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		process.stderr.write(`[clio:usage] out-of-turn usage row not written: ${messageOf(error)}\n`);
		return;
	}
	appendsSinceBoundCheck += 1;
	if (appendsSinceBoundCheck < BOUND_CHECK_INTERVAL) return;
	appendsSinceBoundCheck = 0;
	try {
		boundOutOfTurnUsageFile(path);
	} catch (error) {
		process.stderr.write(`[clio:usage] out-of-turn usage ring not bounded: ${messageOf(error)}\n`);
	}
}

/**
 * Rewrite the file down to the newest {@link MAX_OUT_OF_TURN_USAGE_ROWS} lines
 * when it has grown past the cap. Held under the state-file lock so a concurrent
 * appender cannot lose a row into the rename, and written through
 * `safeResourceWrite` so a crash mid-rewrite leaves the previous file intact.
 */
function boundOutOfTurnUsageFile(path: string): void {
	withStateFileLockSync(path, () => {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			return;
		}
		const lines = raw.split("\n").filter((line) => line.trim().length > 0);
		if (lines.length <= MAX_OUT_OF_TURN_USAGE_ROWS) return;
		const kept = lines.slice(-MAX_OUT_OF_TURN_USAGE_ROWS);
		safeResourceWrite(path, `${kept.join("\n")}\n`, { encoding: "utf8" });
	});
}

/**
 * Read every recorded out-of-turn call. A missing file is an empty read rather
 * than an error: a machine where nobody has ever run `/btw` has nothing to
 * report, and that is a different thing from a store that failed to open.
 */
export function readOutOfTurnUsageRows(stateDir: string): OutOfTurnUsageReadResult {
	const path = outOfTurnUsagePath(stateDir);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		if (err.code === "ENOENT" || err.code === "ENOTDIR") return { rows: [], errors: [] };
		return { rows: [], errors: [`out-of-turn usage store unreadable: ${messageOf(error)}`] };
	}
	const rows: OutOfTurnUsageRow[] = [];
	const errors: string[] = [];
	const lines = raw.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line === undefined || line.trim().length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch (error) {
			errors.push(`${path}:${index + 1}: invalid JSON: ${messageOf(error)}`);
			continue;
		}
		const row = asOutOfTurnUsageRow(parsed);
		if (row === null) {
			errors.push(`${path}:${index + 1}: not an out-of-turn usage row`);
			continue;
		}
		rows.push(row);
	}
	return { rows, errors };
}

function asOutOfTurnUsageRow(value: unknown): OutOfTurnUsageRow | null {
	if (!isRecord(value)) return null;
	const label = value.label;
	if (label !== "side-question" && label !== "handoff" && label !== "prewarm") return null;
	if (typeof value.timestamp !== "string" || value.timestamp.length === 0) return null;
	if (!isRecord(value.usage)) return null;
	const usage = value.usage;
	return {
		label,
		sessionId: typeof value.sessionId === "string" ? value.sessionId : null,
		repoIdentity: typeof value.repoIdentity === "string" ? value.repoIdentity : null,
		timestamp: value.timestamp,
		target: typeof value.target === "string" && value.target.length > 0 ? value.target : "unknown",
		attributedModelId:
			typeof value.attributedModelId === "string" && value.attributedModelId.length > 0
				? value.attributedModelId
				: "unknown",
		usage: {
			input: numberOr0(usage.input),
			output: numberOr0(usage.output),
			cacheRead: numberOr0(usage.cacheRead),
			cacheWrite: numberOr0(usage.cacheWrite),
			reasoning: numberOr0(usage.reasoning),
			totalTokens: numberOr0(usage.totalTokens),
			costUsd: numberOr0(usage.costUsd),
			costProvenance: asCostProvenance(usage.costProvenance),
		},
	};
}

function asCostProvenance(value: unknown): CostProvenance {
	return value === "known" || value === "known_free" || value === "estimated" ? value : "unknown";
}

function numberOr0(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
