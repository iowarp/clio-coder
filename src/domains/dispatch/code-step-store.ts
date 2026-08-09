/**
 * Durable journal for deterministic code steps.
 *
 * Code steps are recorded beside the run ledger, not inside it. The ledger
 * models model runs: agent id, runtime kind, token counts, cost, receipts, and
 * route identity. A subprocess has none of those, and writing zeros into them
 * would put fabricated route rows in front of every reader of dispatch status
 * and route history. A code step is not a route, so it gets its own record.
 *
 * Layout under `clioStateDir()`:
 *   code-steps/<rootId>/<runId>.json     the CodeStepRecord
 *   code-steps/<rootId>/<stepId>.log     the command's captured output
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { atomicWrite } from "../../engine/session.js";
import type { CodeStepRecord } from "./code-step.js";

export function codeStepDir(rootId: string): string {
	return join(clioStateDir(), "code-steps", rootId);
}

function codeStepRecordPath(rootId: string, runId: string): string {
	return join(codeStepDir(rootId), `${runId}.json`);
}

/** Persist one record atomically and return where it landed. */
export async function writeCodeStepRecord(rootId: string, record: CodeStepRecord): Promise<string> {
	const path = codeStepRecordPath(rootId, record.runId);
	await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`);
	return path;
}

/** Every record written under one fleet root, oldest first. */
export function readCodeStepRecords(rootId: string): CodeStepRecord[] {
	const dir = codeStepDir(rootId);
	if (!existsSync(dir)) return [];
	const records: CodeStepRecord[] = [];
	for (const file of readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as CodeStepRecord;
			if (parsed.version === 1) records.push(parsed);
		} catch {
			// A half-written or hand-edited record is skipped, never guessed at.
		}
	}
	return records.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}
