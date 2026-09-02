/**
 * Append-only trial records and resume.
 *
 * A prompt A/B against a local 27B model runs for hours. It will be
 * interrupted, so the store is built for that: one JSON object per line,
 * flushed on write, never rewritten. Resume recomputes the plan from the
 * configuration and skips the trial ids already present, so an interrupted run
 * continues where it stopped without re-running anything and without trusting a
 * separately maintained index.
 *
 * A truncated final line is expected — it is what a kill during a write looks
 * like — and is dropped on read rather than failing the load. A *malformed*
 * line anywhere else is a corrupted store and fails closed, because silently
 * skipping it would quietly change the sample.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../src/domains/prompts/hash.js";
import type { PromptAbManifestV1, PromptAbTrialRecordV1 } from "./contract.js";
import { PROMPT_AB_MANIFEST_SCHEMA_V1, PROMPT_AB_TRIAL_SCHEMA_V1 } from "./contract.js";

export class PromptAbStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptAbStoreError";
	}
}

export const PROMPT_AB_TRIALS_FILE = "trials.jsonl";
export const PROMPT_AB_MANIFEST_FILE = "manifest.json";

export interface PromptAbStore {
	dir: string;
	manifest: PromptAbManifestV1;
	/** Trial ids already recorded, in the order they were written. */
	completed: readonly string[];
	append: (record: PromptAbTrialRecordV1) => void;
}

/**
 * Open a run directory, creating it on a first run and validating it on a
 * resume.
 *
 * A resume into a directory whose manifest describes a different experiment is
 * refused. Mixing two experiments' trials into one append-only file would
 * produce a comparison that silently spans two sets of arms, which is exactly
 * the uncontrolled-drift failure this harness exists to prevent.
 */
export function openPromptAbStore(manifest: PromptAbManifestV1, dir: string): PromptAbStore {
	mkdirSync(dir, { recursive: true });
	const manifestPath = join(dir, PROMPT_AB_MANIFEST_FILE);
	const existing = readJsonIfPresent(manifestPath);
	if (existing === null) {
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
	} else {
		assertSameExperiment(existing, manifest);
	}
	const trialsPath = join(dir, PROMPT_AB_TRIALS_FILE);
	const completed = readPromptAbTrialRecords(dir).map((record) => record.trialId);
	return {
		dir,
		manifest,
		completed,
		append(record) {
			if (record.schema !== PROMPT_AB_TRIAL_SCHEMA_V1) {
				throw new PromptAbStoreError(`trial record schema must be ${PROMPT_AB_TRIAL_SCHEMA_V1}`);
			}
			if (record.experimentHash !== manifest.experimentHash) {
				throw new PromptAbStoreError(`trial ${record.trialId} belongs to a different experiment`);
			}
			appendFileSync(trialsPath, `${JSON.stringify(record)}\n`, "utf8");
		},
	};
}

/**
 * Read every complete record. A trailing partial line is dropped; any other
 * unparseable line is an error.
 */
export function readPromptAbTrialRecords(dir: string): PromptAbTrialRecordV1[] {
	let raw: string;
	try {
		raw = readFileSync(join(dir, PROMPT_AB_TRIALS_FILE), "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n");
	// A file that ends in a newline yields a trailing "" that is not a partial
	// record. Anything else in the last slot is a write that did not finish.
	const trailing = lines.pop();
	const records: PromptAbTrialRecordV1[] = [];
	for (const [index, line] of lines.entries()) {
		if (line.trim().length === 0) continue;
		records.push(parseRecord(line, index + 1));
	}
	if (trailing !== undefined && trailing.trim().length > 0) {
		try {
			records.push(parseRecord(trailing, lines.length + 1));
		} catch {
			// The interrupted write. Dropping it is the whole point of an
			// append-only log: the trial simply re-runs on resume.
		}
	}
	return records;
}

export function readPromptAbManifest(dir: string): PromptAbManifestV1 | null {
	const value = readJsonIfPresent(join(dir, PROMPT_AB_MANIFEST_FILE));
	return value === null ? null : value;
}

function parseRecord(line: string, lineNumber: number): PromptAbTrialRecordV1 {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new PromptAbStoreError(`${PROMPT_AB_TRIALS_FILE}:${lineNumber} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new PromptAbStoreError(`${PROMPT_AB_TRIALS_FILE}:${lineNumber} is not an object`);
	}
	const record = value as PromptAbTrialRecordV1;
	if (record.schema !== PROMPT_AB_TRIAL_SCHEMA_V1) {
		throw new PromptAbStoreError(`${PROMPT_AB_TRIALS_FILE}:${lineNumber} has schema ${String(record.schema)}`);
	}
	if (typeof record.trialId !== "string" || record.trialId.length === 0) {
		throw new PromptAbStoreError(`${PROMPT_AB_TRIALS_FILE}:${lineNumber} has no trialId`);
	}
	return record;
}

function assertSameExperiment(existing: PromptAbManifestV1, incoming: PromptAbManifestV1): void {
	if (existing.schema !== PROMPT_AB_MANIFEST_SCHEMA_V1) {
		throw new PromptAbStoreError(`run directory manifest has schema ${String(existing.schema)}`);
	}
	if (existing.experimentHash === incoming.experimentHash) return;
	throw new PromptAbStoreError(
		`run directory holds experiment ${existing.experimentId} (${existing.experimentHash.slice(0, 12)}), ` +
			`this run is ${incoming.experimentId} (${incoming.experimentHash.slice(0, 12)}); ` +
			"use a fresh output directory rather than mixing two experiments in one log",
	);
}

function readJsonIfPresent(path: string): PromptAbManifestV1 | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		return JSON.parse(raw) as PromptAbManifestV1;
	} catch {
		throw new PromptAbStoreError(`${path} is not valid JSON`);
	}
}

/** Stable identity of a record's meaning, used by the reproducibility test. */
export function promptAbRecordFingerprint(record: PromptAbTrialRecordV1): string {
	return canonicalJson({
		trialId: record.trialId,
		scenarioHash: record.scenarioHash,
		armId: record.armId,
		stratum: record.stratum,
		pairIndex: record.pairIndex,
		hardGate: record.hardGate,
	});
}
