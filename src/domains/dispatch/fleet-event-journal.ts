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
 * (sha256 over the line's canonical JSON without `digest`). The chain lets a
 * reader that imported lines 1..n prove line n+1 extends exactly those.
 *
 *   fleet_started    fleet, planHash, vars, resumedFrom, replayedStepIds,
 *                    workspaceRoot, stepIds
 *   step_dispatched  stepId, kind, waveIndex, assignmentId, agentId | commandId
 *   step_settled     stepId, kind, succeeded, integrityValid, terminalRunId,
 *                    receiptDigest, recordPath, failureReason?, manifestDigest
 *   fleet_sealed     outcome ("completed" | "failed"), endedAt, stepCount,
 *                    manifestDigest
 *
 * `manifestDigest` is the sha256 of the root record as it was written right
 * after that fact, so every settled step is a sealed checkpoint of the fleet
 * manifest, and `fleet_sealed` is the final seal: nothing is appended after
 * it. An external sealer no longer has to run after the fleet; it follows the
 * journal and seals incrementally (`clio-coder fleet events --follow --json`).
 *
 * A write failure turns the journal off for the rest of the run after one
 * notice. It never fails the fleet it describes.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";

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
			receiptDigest: string | null;
			/** The sealed receipt, or the code step's command record, as an absolute path. */
			recordPath: string;
			failureReason?: string;
			manifestDigest: string;
	  }
	| {
			type: "fleet_sealed";
			outcome: "completed" | "failed";
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

/** The digest a manifest checkpoint names: the root record's canonical bytes. */
export function fleetManifestDigest(record: unknown): string {
	return sha256(JSON.stringify(record));
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function lineDigest(line: Omit<FleetEventLine, "digest">): string {
	return sha256(JSON.stringify(line));
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
			const unsigned = {
				v: FLEET_EVENT_JOURNAL_VERSION,
				seq: seq + 1,
				at: now(),
				rootId,
				prev,
				...body,
			} as Omit<FleetEventLine, "digest">;
			const line = { ...unsigned, digest: lineDigest(unsigned) } as FleetEventLine;
			try {
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
	sealed: boolean;
}

/**
 * Complete lines from `offset` on. A trailing partial line (a write in
 * progress) is left for the next read, so a follower never parses half a fact.
 */
export function readFleetEventJournal(
	rootId: string,
	from: { offset: number; seq: number; prev: string | null } = { offset: 0, seq: 0, prev: null },
): FleetEventJournalRead | null {
	let text: Buffer;
	try {
		text = readFileSync(fleetEventJournalPath(rootId));
	} catch {
		return null;
	}
	const lines: FleetEventLine[] = [];
	let offset = from.offset;
	let seq = from.seq;
	let prev = from.prev;
	let broken: string | null = null;
	let sealed = false;
	while (offset < text.length) {
		const end = text.indexOf(0x0a, offset);
		if (end < 0) break;
		const raw = text.subarray(offset, end).toString("utf8");
		offset = end + 1;
		let line: FleetEventLine;
		try {
			line = JSON.parse(raw) as FleetEventLine;
		} catch {
			broken ??= `line ${seq + 1} is not JSON`;
			continue;
		}
		const { digest, ...unsigned } = line;
		if (line.seq !== seq + 1 || line.prev !== prev || digest !== lineDigest(unsigned)) {
			broken ??= `line ${seq + 1} does not extend the chain`;
		}
		seq = line.seq;
		prev = digest;
		lines.push(line);
		if (line.type === "fleet_sealed") sealed = true;
	}
	return { lines, offset, broken, sealed };
}
