/**
 * The memory store rewritten once into the only shape this build reads, by the
 * `2026-11-21-memory-store-v2` upgrade migration. The store used to be read in
 * whatever shape an earlier release left it: a version-1 envelope, no stored
 * claim (derived from the refs on every use), deliveries as `delivered`
 * observations, verdicts with no claim revision, `command:` refs naming a
 * command by its text hash and `source:` refs carrying a 16-character span
 * hash. Each is rewritten here and nothing reads it afterwards.
 *
 * - A command ref whose text hash names a quoted span of one segment becomes
 *   that segment's evidence identity; one that names nothing stays as it is,
 *   the shape a command with no identity is still written in.
 * - A short source hash becomes the full digest when the lesson's own words or
 *   the quoted file recover exactly one span with that prefix. One that cannot
 *   be recovered is removed and its record named in the report.
 * - A record with no stored claim stores the claim its refs make.
 * - `delivered` observations join the delivery counter; verdicts that name no
 *   claim revision judged no revision any reader counts, and are removed.
 *
 * A record the current validator still refuses, such as one left with no
 * evidence ref, moves to `records.invalid.json` as the store does on any write.
 * The previous file is kept beside the store.
 */

import { readFileSync } from "node:fs";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import {
	COMMAND_CLAIM_REF_PREFIX,
	COMMAND_EVIDENCE_REF_PREFIX,
	commandSegment,
	commandTextHash,
	segmentKeyRef,
} from "./command-evidence.js";
import { readInsideRoot, repositoryRelativePath } from "./lesson-evidence.js";
import { recoverSpanDigest } from "./lesson-projection.js";
import { claimFromEvidence } from "./promotion.js";
import { memoryStorePath, quarantineInvalidRecordsUnlocked, sortMemoryRecords } from "./store.js";
import { MEMORY_VERSION, type MemoryRecord } from "./types.js";
import { validateMemoryRecord } from "./validate.js";

export interface MemoryStoreUpgradeReport {
	changed: string[];
	attention: string[];
}

const SHORT_SOURCE_REF = /^source:(.+)#([0-9a-f]{16})$/u;

interface Tally {
	commandRefs: number;
	sourceRefs: number;
	droppedSourceRefs: Set<string>;
	claims: number;
	deliveries: number;
	unscopedVerdicts: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function backtickedSpans(text: string): string[] {
	return [...text.matchAll(/`([^`\n]+)`/gu)].map((match) => (match[1] ?? "").trim()).filter(Boolean);
}

/** A `command:` or `command-claimed:` ref by text hash, as the evidence identity of the one-segment span it names. */
function upgradedCommandRef(ref: string, spans: readonly string[]): string {
	const prefix = [COMMAND_EVIDENCE_REF_PREFIX, COMMAND_CLAIM_REF_PREFIX].find((candidate) => ref.startsWith(candidate));
	if (prefix === undefined) return ref;
	const hash = ref.slice(prefix.length);
	if (segmentKeyRef(hash)) return ref;
	for (const span of spans) {
		if (commandTextHash(span) !== hash) continue;
		const key = commandSegment(span)?.key;
		if (key !== undefined) return `${prefix}${key}`;
	}
	return ref;
}

/** The quoted file as the delivery check reads it, from the record's repository, or null. */
function quotedFile(record: Record<string, unknown>, path: string): string | null {
	const repository = isRecord(record.repository) ? record.repository : undefined;
	const root = typeof repository?.key === "string" ? repository.key : undefined;
	if (root === undefined) return null;
	const relative = repositoryRelativePath(path, [root]);
	return relative === null ? null : readInsideRoot(root, relative);
}

/** One raw record in the current shape; it is validated afterwards, so anything it cannot read passes through. */
function upgradeRecord(raw: Record<string, unknown>, tally: Tally): Record<string, unknown> {
	const record = { ...raw };
	const lesson = typeof record.lesson === "string" ? record.lesson : "";
	const id = typeof record.id === "string" ? record.id : "(no id)";
	if (Array.isArray(record.evidenceRefs)) {
		const spans = backtickedSpans(lesson);
		const refs: unknown[] = [];
		for (const ref of record.evidenceRefs) {
			if (typeof ref !== "string") {
				refs.push(ref);
				continue;
			}
			const command = upgradedCommandRef(ref, spans);
			if (command !== ref) tally.commandRefs += 1;
			const short = SHORT_SOURCE_REF.exec(command);
			if (short === null) {
				refs.push(command);
				continue;
			}
			const path = short[1] ?? "";
			const digest = recoverSpanDigest(lesson, short[2] ?? "", quotedFile(record, path));
			if (digest !== null) {
				tally.sourceRefs += 1;
				refs.push(`source:${path}#${digest}`);
			} else tally.droppedSourceRefs.add(id);
		}
		record.evidenceRefs = [...new Set(refs)];
	}

	if (Array.isArray(record.observations)) {
		const kept: unknown[] = [];
		let deliveredCount = typeof record.deliveredCount === "number" ? record.deliveredCount : 0;
		let lastDeliveredAt = typeof record.lastDeliveredAt === "string" ? record.lastDeliveredAt : undefined;
		for (const item of record.observations) {
			if (isRecord(item) && item.kind === "delivered") {
				tally.deliveries += 1;
				deliveredCount += 1;
				if (typeof item.at === "string" && (lastDeliveredAt === undefined || item.at > lastDeliveredAt))
					lastDeliveredAt = item.at;
			} else if (isRecord(item) && item.revision === undefined) tally.unscopedVerdicts += 1;
			else kept.push(item);
		}
		if (deliveredCount > 0) record.deliveredCount = deliveredCount;
		if (lastDeliveredAt !== undefined) record.lastDeliveredAt = lastDeliveredAt;
		if (kept.length > 0) record.observations = kept;
		else Reflect.deleteProperty(record, "observations");
	}

	if (record.claim === undefined && Array.isArray(record.evidenceRefs)) {
		const refs = record.evidenceRefs.filter((ref): ref is string => typeof ref === "string");
		const repository = isRecord(record.repository) ? record.repository : undefined;
		const claim = claimFromEvidence(lesson, refs, typeof repository?.key === "string" ? repository.key : undefined);
		if (claim !== null) {
			record.claim = claim;
			tally.claims += 1;
		}
	}
	return record;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Rewrite `<dataDir>/memory/records.json` into the current shape once, under the store's own lock. */
export async function upgradeMemoryStore(dataDir: string): Promise<MemoryStoreUpgradeReport> {
	const path = memoryStorePath(dataDir);
	return withStateFileLock(path, () => {
		const report: MemoryStoreUpgradeReport = { changed: [], attention: [] };
		let text: string;
		try {
			text = readFileSync(path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
			throw error;
		}
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.records))
			throw new Error(`${path} is not a memory store; it was left as it is`);
		if (typeof parsed.version === "number" && parsed.version > MEMORY_VERSION)
			throw new Error(`${path} was written by a newer Clio Coder (version ${parsed.version}); it was left as it is`);

		const tally: Tally = {
			commandRefs: 0,
			sourceRefs: 0,
			droppedSourceRefs: new Set(),
			claims: 0,
			deliveries: 0,
			unscopedVerdicts: 0,
		};
		const records: MemoryRecord[] = [];
		const invalid: Array<{ record: unknown; issues: string[] }> = [];
		parsed.records.forEach((value: unknown, index) => {
			const upgraded = isRecord(value) ? upgradeRecord(value, tally) : value;
			const result = validateMemoryRecord(upgraded, `$.records[${index}]`);
			if (result.valid) records.push(result.record);
			else invalid.push({ record: value, issues: result.issues.map((issue) => `${issue.path}: ${issue.message}`) });
		});

		const lines: string[] = [];
		if (parsed.version !== MEMORY_VERSION)
			lines.push(`Rewrote the store from version ${String(parsed.version)} to ${MEMORY_VERSION}.`);
		if (tally.commandRefs > 0)
			lines.push(`Rewrote ${plural(tally.commandRefs, "command evidence ref")} from a text hash to evidence identity.`);
		if (tally.sourceRefs > 0)
			lines.push(`Rewrote ${plural(tally.sourceRefs, "source ref")} from a 16-character span hash to the full digest.`);
		if (tally.droppedSourceRefs.size > 0)
			lines.push(
				`Removed source refs whose quoted span could no longer be recovered (the file changed or is gone, and the lesson does not quote it) from ${plural(tally.droppedSourceRefs.size, "record")}: ${[...tally.droppedSourceRefs].sort().join(", ")}.`,
			);
		if (tally.claims > 0)
			lines.push(`Stored the claim ${plural(tally.claims, "record")} made through its evidence refs.`);
		if (tally.deliveries > 0)
			lines.push(`Moved ${plural(tally.deliveries, "delivered observation")} into the delivery counters.`);
		if (tally.unscopedVerdicts > 0)
			lines.push(
				`Removed ${plural(tally.unscopedVerdicts, "verdict")} that named no claim revision; no gate counted them.`,
			);
		if (lines.length === 0 && invalid.length === 0) return report;

		const backupPath = `${path}.memory-v2.bak`;
		if (invalid.length > 0) {
			quarantineInvalidRecordsUnlocked(dataDir, invalid);
			report.attention.push(
				`${plural(invalid.length, "memory record")} the current shape refuses moved to records.invalid.json beside the store; review them with the previous file, ${backupPath}.`,
			);
		}
		safeResourceWrite(
			path,
			`${JSON.stringify({ version: MEMORY_VERSION, records: sortMemoryRecords(records) }, null, 2)}\n`,
			{
				encoding: "utf8",
				mode: 0o600,
				backup: { path: backupPath },
			},
		);
		report.changed.push(`What changed for you in the memory store (the previous file is ${backupPath}):`, ...lines);
		return report;
	});
}
