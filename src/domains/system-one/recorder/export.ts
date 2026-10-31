/**
 * Turn the journaled dataset into a training set: one JSON line per decision, with the full question specs it asked
 * and every outcome sample that names its `ref` (#434).
 *
 * Two passes over the session journals. The first resolves the outcomes, which are small and may land in a later
 * session than the decision they belong to. The second resolves the decisions and emits a line each, so the
 * decisions themselves are never all held at once.
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fsyncDirectory } from "../../../core/safe-resource-write.js";
import { createRedactionTally } from "../../evidence/redact.js";
import { readJournaledContent } from "../../telemetry/index.js";
import type { SiteId } from "../types.js";
import type { DatasetDecisionRow, DatasetOutcomeRow } from "./dataset.js";
import { scrub, scrubbed } from "./scrub.js";

export interface ExportOptions {
	readonly stateDir: string;
	/** `YYYY-MM-DD`: skip samples recorded before this UTC day. */
	readonly since?: string;
	readonly site?: SiteId;
}

export interface ExportSummary {
	/** Sessions that contributed a decision. */
	readonly sessions: number;
	readonly decisions: number;
	readonly outcomes: number;
	/** Question ids whose spec the decision's sample does not carry. */
	readonly missingSpecs: number;
	/** Samples whose content retention or damage left unreadable. */
	readonly unreadableRows: number;
}

export interface ExportResult extends ExportSummary {
	/** One newline-terminated JSON line per decision. */
	readonly lines: string[];
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar day in `YYYY-MM-DD` form. */
export function isDay(text: string): boolean {
	if (!DAY_PATTERN.test(text)) return false;
	const parsed = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
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
		...(row.routes !== undefined ? { routes: plain(row.routes) } : {}),
		outcomes: Array.isArray(row.outcomes)
			? row.outcomes.map((outcome: { facts?: unknown }) => ({ ...outcome, facts: keyed(outcome.facts) }))
			: row.outcomes,
	};
}

/**
 * Walk the journals and hand `emit` one newline-terminated JSON line per decision as it is produced, so an export
 * holds only the outcomes, never the decisions.
 */
export async function streamExport(options: ExportOptions, emit: (line: string) => void): Promise<ExportSummary> {
	const since = options.since;
	const inWindow = (at: string) => since === undefined || at.slice(0, 10) >= since;
	const outcomes = new Map<string, Array<{ source: string; at: string; facts: unknown }>>();
	let unreadableRows = 0;
	let outcomeCount = 0;
	for await (const sample of readJournaledContent(
		options.stateDir,
		"system_one.sample_captured",
		(data, at) => data.sample === "outcome" && inWindow(at),
	)) {
		const outcome = isRecord(sample.content) ? (sample.content.outcome as Partial<DatasetOutcomeRow>) : undefined;
		if (!isRecord(outcome) || typeof outcome.ref !== "string") {
			unreadableRows += 1;
			continue;
		}
		const list = outcomes.get(outcome.ref) ?? [];
		list.push({ source: String(outcome.source), at: String(outcome.at), facts: outcome.facts ?? {} });
		outcomes.set(outcome.ref, list);
		outcomeCount += 1;
	}
	for (const list of outcomes.values()) list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

	let decisions = 0;
	let missingSpecs = 0;
	const sessions = new Set<string>();
	for await (const sample of readJournaledContent(
		options.stateDir,
		"system_one.sample_captured",
		(data, at) =>
			data.sample === "decision" && inWindow(at) && (options.site === undefined || data.site === options.site),
	)) {
		const content = isRecord(sample.content) ? sample.content : undefined;
		const row = content?.decision as Partial<DatasetDecisionRow> | undefined;
		if (!isRecord(row) || typeof row.callId !== "string") {
			unreadableRows += 1;
			continue;
		}
		const specs = isRecord(content?.specs) ? content.specs : {};
		const questions: Record<string, unknown> = {};
		for (const [id, hash] of Object.entries(row.questions ?? {})) {
			if (Object.hasOwn(specs, hash)) questions[id] = specs[hash];
			else {
				missingSpecs += 1;
				questions[id] = { specHash: hash, missing: true };
			}
		}
		decisions += 1;
		sessions.add(sample.sessionId);
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
					...(row.note !== undefined ? { note: row.note } : {}),
					policy: row.policy ?? null,
					// Per-engine provenance with the rendered questions a bounded renderer sent,
					// so a replay or a training row reads what the model actually read.
					...(row.routes !== undefined ? { routes: row.routes } : {}),
					latencyMs: row.latencyMs,
					deadlineMs: row.deadlineMs,
					outcomes: row.ref === undefined ? [] : (outcomes.get(row.ref) ?? []),
				}),
			)}\n`,
		);
	}
	return { sessions: sessions.size, decisions, outcomes: outcomeCount, missingSpecs, unreadableRows };
}

/** The whole export held in memory, for callers that want the lines rather than a file. */
export async function buildExport(options: ExportOptions): Promise<ExportResult> {
	const lines: string[] = [];
	const summary = await streamExport(options, (line) => lines.push(line));
	return { lines, ...summary };
}

/** What the journaled dataset holds: sample counts and the UTC days they span. */
export interface DatasetSummary {
	readonly sessions: number;
	readonly decisions: number;
	readonly outcomes: number;
	readonly oldest: string | null;
	readonly newest: string | null;
}

/** Counts read from the records alone; no sample's content is resolved. */
export async function summarizeDataset(stateDir: string): Promise<DatasetSummary> {
	const sessions = new Set<string>();
	let decisions = 0;
	let outcomes = 0;
	let oldest: string | null = null;
	let newest: string | null = null;
	for await (const sample of readJournaledContent(stateDir, "system_one.sample_captured", (data, at) => {
		if (data.sample === "decision") decisions += 1;
		else outcomes += 1;
		const day = at.slice(0, 10);
		if (oldest === null || day < oldest) oldest = day;
		if (newest === null || day > newest) newest = day;
		return false;
	}))
		sessions.add(sample.sessionId);
	return { sessions: sessions.size, decisions, outcomes, oldest, newest };
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
export async function exportToFile(destination: string, options: ExportOptions): Promise<ExportSummary> {
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
			summary = await streamExport(options, (line) => {
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
