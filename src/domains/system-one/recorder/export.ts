/**
 * Turn the day files into a training set: one JSON line per decision, with the
 * full question specs it asked and every outcome row that names its `ref`.
 *
 * Two passes over the selected files. The first collects specs and outcomes,
 * which are small and may live in a later file than the decision they belong
 * to (a permission answered after midnight). The second walks the decisions and
 * emits a line each, so the decisions themselves are never all held at once.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fsyncDirectory } from "../../../core/safe-resource-write.js";
import { createRedactionTally } from "../../evidence/redact.js";
import type { SiteId } from "../types.js";
import type { DatasetDecisionRow, DatasetOutcomeRow, DatasetSpecRow } from "./dataset.js";
import { scrub, scrubbed } from "./scrub.js";
import type { DatasetFile } from "./store.js";
import { datasetDir, iterateDatasetLines, listDatasetFiles, rowKindOf } from "./store.js";

export interface ExportOptions {
	readonly dir?: string;
	/** `YYYY-MM-DD`: skip day files before this UTC day. */
	readonly since?: string;
	readonly site?: SiteId;
}

export interface ExportSummary {
	readonly files: number;
	readonly decisions: number;
	readonly outcomes: number;
	/** Question ids whose spec row is not in the selected files. */
	readonly missingSpecs: number;
	/** Rows that looked like ours but did not parse. */
	readonly unreadableRows: number;
}

export interface ExportResult extends ExportSummary {
	/** One newline-terminated JSON line per decision. */
	readonly lines: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRow(line: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Run the recorder's scrub over a row again on the way out. A day file written
 * before a scrub fix keeps its old text on disk (stored files are never
 * rewritten), and an export is the copy that leaves the machine, so it is the
 * place the home-to-`~` rewrite and secret redaction have to hold. Both are
 * idempotent: a row that was scrubbed when recorded comes out unchanged.
 * Keys are scrubbed only where the recorder scrubbed them; answers and question
 * specs are the harness's own vocabulary.
 */
function scrubExportRow<T extends Record<string, unknown>>(row: T): T {
	const tally = createRedactionTally();
	const keyed = (value: unknown): unknown => (value === undefined ? undefined : scrubbed(value).value);
	const plain = (value: unknown): unknown => (value === undefined ? undefined : scrub(value, tally, false));
	return {
		...row,
		session: plain(row.session),
		target: plain(row.target),
		model: plain(row.model),
		build: plain(row.build),
		state: keyed(row.state),
		...(row.error !== undefined ? { error: keyed(row.error) } : {}),
		policy: keyed(row.policy),
		answers: plain(row.answers),
		questions: plain(row.questions),
		outcomes: Array.isArray(row.outcomes)
			? row.outcomes.map((outcome: { facts?: unknown }) => ({ ...outcome, facts: keyed(outcome.facts) }))
			: row.outcomes,
	};
}

function selectFiles(options: ExportOptions): DatasetFile[] {
	const since = options.since;
	return listDatasetFiles(options.dir ?? datasetDir()).filter((file) => since === undefined || file.day >= since);
}

/**
 * Walk the dataset and hand `emit` one newline-terminated JSON line per
 * decision as it is produced, so an export holds only the specs and outcomes,
 * never the decisions.
 */
export function streamExport(options: ExportOptions, emit: (line: string) => void): ExportSummary {
	const files = selectFiles(options);
	const specs = new Map<string, unknown>();
	const outcomes = new Map<string, Array<{ source: string; at: string; facts: unknown }>>();
	let unreadableRows = 0;
	let outcomeCount = 0;
	for (const file of files) {
		for (const line of iterateDatasetLines(file)) {
			const kind = rowKindOf(line);
			if (kind !== "spec" && kind !== "outcome") continue;
			const row = parseRow(line);
			if (row === null) {
				unreadableRows += 1;
				continue;
			}
			if (kind === "spec") {
				const spec = row as unknown as Partial<DatasetSpecRow>;
				if (typeof spec.hash === "string") specs.set(spec.hash, spec.spec);
				continue;
			}
			const outcome = row as unknown as Partial<DatasetOutcomeRow>;
			if (typeof outcome.ref !== "string") continue;
			const list = outcomes.get(outcome.ref) ?? [];
			list.push({ source: String(outcome.source), at: String(outcome.at), facts: outcome.facts ?? {} });
			outcomes.set(outcome.ref, list);
			outcomeCount += 1;
		}
	}
	for (const list of outcomes.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

	let decisions = 0;
	let missingSpecs = 0;
	for (const file of files) {
		for (const line of iterateDatasetLines(file)) {
			if (rowKindOf(line) !== "decision") continue;
			const row = parseRow(line) as Partial<DatasetDecisionRow> | null;
			if (row === null || typeof row.callId !== "string") {
				unreadableRows += 1;
				continue;
			}
			if (options.site !== undefined && row.site !== options.site) continue;
			const questions: Record<string, unknown> = {};
			for (const [id, hash] of Object.entries(row.questions ?? {})) {
				if (specs.has(hash)) questions[id] = specs.get(hash);
				else {
					missingSpecs += 1;
					questions[id] = { specHash: hash, missing: true };
				}
			}
			decisions += 1;
			emit(
				`${JSON.stringify(
					scrubExportRow({
						callId: row.callId,
						at: row.at,
						session: row.session ?? null,
						...(row.ref !== undefined ? { ref: row.ref } : {}),
						site: row.site,
						siteVersion: row.siteVersion,
						engine: row.engine,
						kind: row.engineKind,
						target: row.target,
						model: row.model ?? null,
						build: row.build ?? null,
						outcome: row.outcome,
						...(row.error !== undefined ? { error: row.error } : {}),
						fitted: row.fitted ?? null,
						state: row.state ?? {},
						...(row.stateTruncated === true ? { stateTruncated: true } : {}),
						stateDigest: row.stateDigest,
						questions,
						answers: row.answers ?? {},
						...(row.usage !== undefined ? { usage: row.usage } : {}),
						policy: row.policy ?? null,
						latencyMs: row.latencyMs,
						deadlineMs: row.deadlineMs,
						outcomes: row.ref === undefined ? [] : (outcomes.get(row.ref) ?? []),
					}),
				)}\n`,
			);
		}
	}
	return { files: files.length, decisions, outcomes: outcomeCount, missingSpecs, unreadableRows };
}

/** The whole export held in memory, for callers that want the lines rather than a file. */
export function buildExport(options: ExportOptions = {}): ExportResult {
	const lines: string[] = [];
	const summary = streamExport(options, (line) => lines.push(line));
	return { lines, ...summary };
}

const FLUSH_BYTES = 1024 * 1024;

function writeAll(fd: number, buffer: Buffer): void {
	let offset = 0;
	while (offset < buffer.byteLength) offset += writeSync(fd, buffer, offset, buffer.byteLength - offset);
}

/**
 * Stream the export to `destination` with the guarantees `safeResourceWrite`
 * gives a whole string: a 0600 temp file beside the target, fsynced, then
 * renamed over it, so a reader never sees a torn file and a failed export
 * leaves any earlier one intact.
 */
export function exportToFile(destination: string, options: ExportOptions = {}): ExportSummary {
	const dir = dirname(destination);
	mkdirSync(dir, { recursive: true });
	const temp = join(dir, `.${basename(destination)}.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`);
	let tempExists = false;
	try {
		const fd = openSync(temp, "wx", 0o600);
		tempExists = true;
		let summary: ExportSummary;
		try {
			let pending: string[] = [];
			let pendingBytes = 0;
			const flush = (): void => {
				if (pending.length === 0) return;
				writeAll(fd, Buffer.from(pending.join(""), "utf8"));
				pending = [];
				pendingBytes = 0;
			};
			summary = streamExport(options, (line) => {
				pending.push(line);
				pendingBytes += line.length;
				if (pendingBytes >= FLUSH_BYTES) flush();
			});
			flush();
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, destination);
		tempExists = false;
		fsyncDirectory(dir);
		return summary;
	} catch (err) {
		if (tempExists) rmSync(temp, { force: true });
		throw err;
	}
}
