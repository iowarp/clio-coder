/**
 * The live, durable record of one fleet run, for anything outside Clio that
 * follows a fleet while it runs: a provenance store, a dashboard, a sealer.
 *
 * Layout: `fleet-runs/<fleetRootId>.events.ndjson` under `clioStateDir()`,
 * beside the root record `fleet-runs/<fleetRootId>.json`. Append-only, one
 * JSON object per line, written synchronously as each fact happens, so a
 * reader tailing the file sees a step the moment it settles.
 *
 * Every line carries `v` (1), `seq` (from 1), `at` (ISO), `rootId`, `type`,
 * `prev` (the previous line's digest, null on the first) and `digest`
 * (sha256 over the line's sorted-key JSON without `digest`, the serializer
 * receipts use). The chain lets a reader that imported lines 1..n detect a
 * line n+1 that does not extend exactly those. Lines are hash-chained, not
 * signed: anyone who can write the file can rewrite it and recompute every
 * digest, so the chain catches corruption and accidental edits, not a forger.
 *
 *   fleet_started    fleet, planHash, vars, resumedFrom, replayedStepIds,
 *                    workspaceRoot, stepIds
 *   step_dispatched  stepId, kind, waveIndex, assignmentId, agentId | commandId
 *   step_settled     stepId, kind, succeeded, integrityValid, terminalRunId,
 *                    runDigest, recordPath, failureReason?, stepEntryDigest,
 *                    manifestStepCount, manifestDigest
 *   fleet_sealed     outcome ("succeeded" | "failed" | "aborted"), endedAt, stepCount,
 *                    manifestDigest
 *
 * `manifestDigest` is the sha256 of the exact bytes of the root record
 * written right after that fact. The record is rewritten in place as the
 * fleet goes on, so those bytes are gone by the next settle; what stays
 * checkable is `stepEntryDigest`, the sorted-key sha256 of the step's entry in
 * the record's `steps`, and `manifestStepCount`, that entry's 1-based position,
 * which every later version of the record still carries. `fleet_sealed` is the
 * last line: nothing is appended after it, and its `manifestDigest` names the
 * final record's bytes. An external sealer follows the journal instead of
 * waiting for the fleet (`clio-coder fleet events --follow --json`).
 *
 * A write failure turns the journal off for the rest of the run after one
 * notice. It never fails the fleet it describes.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { canonicalJson } from "../prompts/hash.js";

export const FLEET_EVENT_JOURNAL_VERSION = 1;

export type FleetEventBody =
	| {
			type: "fleet_started";
			fleet: string;
			planHash: string;
			vars: Readonly<Record<string, string>>;
			resumedFrom: string | null;
			/** The resumed prefix; its sealed results are already in the manifest. */
			replayedStepIds: ReadonlyArray<string>;
			workspaceRoot: string;
			stepIds: ReadonlyArray<string>;
	  }
	| {
			type: "step_dispatched";
			stepId: string;
			kind: "agent" | "code";
			waveIndex: number;
			assignmentId: string;
			agentId?: string;
			commandId?: string;
	  }
	| {
			type: "step_settled";
			stepId: string;
			kind: "agent" | "code";
			succeeded: boolean;
			integrityValid: boolean;
			terminalRunId: string;
			runDigest: string | null;
			/** The sealed receipt, or the code step's command record, as an absolute path. */
			recordPath: string;
			failureReason?: string;
			/** Sorted-key sha256 of `{ stepId, result }` as the record stores it. */
			stepEntryDigest: string;
			/** The record's step count when this entry was written; the entry sits at that 1-based position. */
			manifestStepCount: number;
			manifestDigest: string;
	  }
	| {
			type: "fleet_sealed";
			/** The run's own verdict: succeeded only when every required step succeeded and every loop converged. */
			outcome: "succeeded" | "failed" | "aborted";
			forced?: boolean;
			endedAt: string;
			stepCount: number;
			manifestDigest: string;
	  };

export type FleetEventLine = FleetEventBody & {
	v: typeof FLEET_EVENT_JOURNAL_VERSION;
	seq: number;
	at: string;
	rootId: string;
	prev: string | null;
	digest: string;
};

export function fleetEventJournalPath(rootId: string): string {
	return join(clioStateDir(), "fleet-runs", `${rootId}.events.ndjson`);
}

/** The digest a manifest checkpoint names: sha256 of the exact text `writeFleetRun` wrote. */
export function fleetManifestDigest(writtenText: string): string {
	return sha256(writtenText);
}

/**
 * Digest of one `steps` entry as a reader of the record file parses it. The
 * JSON round trip applies what the file write applied (dropped undefined
 * fields, non-finite numbers as null), so a verifier digesting the parsed
 * entry gets the same value and the canonical serializer never sees a value
 * it refuses.
 */
export function fleetStepEntryDigest(entry: { stepId: string; result: unknown }): string {
	return sha256(canonicalJson(JSON.parse(JSON.stringify(entry))));
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function lineDigest(line: Omit<FleetEventLine, "digest">): string {
	return sha256(canonicalJson(line));
}

export interface FleetEventJournal {
	append(body: FleetEventBody): void;
}

export function createFleetEventJournal(
	rootId: string,
	options: { now?: () => string; warn?: (message: string) => void } = {},
): FleetEventJournal {
	const path = fleetEventJournalPath(rootId);
	const now = options.now ?? (() => new Date().toISOString());
	const warn = options.warn ?? ((message: string) => process.stderr.write(`[clio-coder:fleet] ${message}\n`));
	let seq = 0;
	let prev: string | null = null;
	let off = false;
	let sealed = false;
	return {
		append(body) {
			if (off || sealed) return;
			let line: FleetEventLine;
			// Building the line sits inside the try too: append runs in the fleet's
			// finally blocks, where a throw would replace the run's own error.
			try {
				const unsigned = {
					v: FLEET_EVENT_JOURNAL_VERSION,
					seq: seq + 1,
					at: now(),
					rootId,
					prev,
					...body,
				} as Omit<FleetEventLine, "digest">;
				line = { ...unsigned, digest: lineDigest(unsigned) } as FleetEventLine;
				mkdirSync(dirname(path), { recursive: true });
				appendFileSync(path, `${JSON.stringify(line)}\n`, "utf8");
			} catch (error) {
				off = true;
				warn(`fleet event journal ${path} is off for this run: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}
			seq = line.seq;
			prev = line.digest;
			if (body.type === "fleet_sealed") sealed = true;
		},
	};
}

export interface FleetEventJournalRead {
	lines: FleetEventLine[];
	/** Byte offset after the last complete line read; pass it back to read only what follows. */
	offset: number;
	/** The first line whose sequence or chain does not extend the previous one, if any. */
	broken: string | null;
	/** How many of `lines` precede the first break: all of them when `broken` is null. */
	verified: number;
	sealed: boolean;
}

/**
 * Complete lines from `offset` on. A trailing partial line (a write in
 * progress) is left for the next read, so a follower never parses half a fact.
 * Null means no journal file exists; any other read failure, EACCES
 * included, throws so it is never mistaken for an absent journal.
 */
export function readFleetEventJournal(
	rootId: string,
	from: { offset: number; seq: number; prev: string | null } = { offset: 0, seq: 0, prev: null },
): FleetEventJournalRead | null {
	let text: Buffer;
	try {
		text = readFileSync(fleetEventJournalPath(rootId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
		throw error;
	}
	const lines: FleetEventLine[] = [];
	let offset = from.offset;
	let seq = from.seq;
	let prev = from.prev;
	let broken: string | null = null;
	let verified = 0;
	let sealed = false;
	while (offset < text.length) {
		const end = text.indexOf(0x0a, offset);
		if (end < 0) break;
		const raw = text.subarray(offset, end).toString("utf8");
		offset = end + 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			broken ??= `line ${seq + 1} is not JSON`;
			continue;
		}
		// Valid JSON that is not an object (`null`, a number, an array) is a
		// broken line, not a reader crash.
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			broken ??= `line ${seq + 1} is not a journal object`;
			continue;
		}
		const line = parsed as FleetEventLine;
		const { digest, ...unsigned } = line;
		if (line.seq !== seq + 1 || line.prev !== prev || digest !== lineDigest(unsigned)) {
			broken ??= `line ${seq + 1} does not extend the chain`;
		}
		if (broken === null) verified++;
		seq = line.seq;
		prev = digest;
		lines.push(line);
		if (line.type === "fleet_sealed") sealed = true;
	}
	return { lines, offset, broken, verified, sealed };
}
