/**
 * The dataset directory as the read side sees it: `<state>/systemone/YYYY-MM-DD.jsonl`,
 * one append-only file per UTC day. Doctor, `clio-coder systemone` and the
 * writer's retention pass share these helpers so they agree on what a dataset
 * file is. Nothing here creates a directory or a file except `pruneDataset`
 * deleting one.
 */

import { closeSync, openSync, readdirSync, readSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { clioStatePath } from "../../../core/xdg.js";

export const DATASET_DIR_NAME = "systemone";
const DAY_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;

export type DatasetRowKind = "decision" | "spec" | "outcome";
const ROW_PREFIXES: ReadonlyArray<readonly [DatasetRowKind, string]> = [
	["decision", '{"kind":"decision"'],
	["spec", '{"kind":"spec"'],
	["outcome", '{"kind":"outcome"'],
];

/** The dataset directory, resolved without creating it. */
export function datasetDir(): string {
	return join(clioStatePath(), DATASET_DIR_NAME);
}

export interface DatasetFile {
	/** `YYYY-MM-DD`, UTC. */
	readonly day: string;
	readonly path: string;
	readonly bytes: number;
}

/** True for a real calendar day in `YYYY-MM-DD` form. */
export function isDay(text: string): boolean {
	if (!DAY_PATTERN.test(text)) return false;
	const parsed = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

/** The UTC day of an ISO time, or of `fallbackMs` when the time does not parse. */
export function dayOf(iso: string, fallbackMs: number): string {
	const parsed = Date.parse(iso);
	return new Date(Number.isNaN(parsed) ? fallbackMs : parsed).toISOString().slice(0, 10);
}

export function dayFileName(day: string): string {
	return `${day}.jsonl`;
}

/** Dataset files oldest first. A directory that does not exist yet is an empty dataset. */
export function listDatasetFiles(dir: string = datasetDir()): DatasetFile[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
	const files: DatasetFile[] = [];
	for (const name of names) {
		const match = DAY_FILE_PATTERN.exec(name);
		if (match?.[1] === undefined) continue;
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (stat.isFile()) files.push({ day: match[1], path, bytes: stat.size });
		} catch {
			// Deleted between the listing and the stat by another process's retention pass.
		}
	}
	return files.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

const READ_CHUNK_BYTES = 1024 * 1024;

/**
 * Non-empty lines of one file, read a chunk at a time. A day file may grow to
 * `maxMiB`, and reading it whole as one string fails past the engine's maximum
 * string length. Lines are split on the newline byte before decoding, so a
 * multi-byte character straddling two chunks decodes intact. A torn trailing
 * line from a crash is yielded for the caller's parse to reject.
 */
export function* iterateDatasetLines(file: DatasetFile): Generator<string> {
	const fd = openSync(file.path, "r");
	try {
		const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
		let rest: Buffer = Buffer.alloc(0);
		for (;;) {
			const read = readSync(fd, chunk, 0, chunk.length, null);
			if (read === 0) break;
			// `chunk` is reused, so what carries over must be a copy.
			const data =
				rest.length === 0 ? Buffer.from(chunk.subarray(0, read)) : Buffer.concat([rest, chunk.subarray(0, read)]);
			let start = 0;
			for (let end = data.indexOf(0x0a, start); end !== -1; end = data.indexOf(0x0a, start)) {
				if (end > start) yield data.toString("utf8", start, end);
				start = end + 1;
			}
			rest = data.subarray(start);
		}
		if (rest.length > 0) yield rest.toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export function rowKindOf(line: string): DatasetRowKind | null {
	for (const [kind, prefix] of ROW_PREFIXES) if (line.startsWith(prefix)) return kind;
	return null;
}

export interface DatasetSummary {
	readonly dir: string;
	readonly files: number;
	readonly bytes: number;
	readonly oldest: string | null;
	readonly newest: string | null;
}

/** Sizes as the dataset's small numbers need them: KiB under a MiB, MiB above. */
export function formatDatasetBytes(bytes: number): string {
	return bytes < MIB ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / MIB).toFixed(1)} MiB`;
}

export function summarizeDataset(dir: string = datasetDir()): DatasetSummary {
	const files = listDatasetFiles(dir);
	return {
		dir,
		files: files.length,
		bytes: files.reduce((sum, file) => sum + file.bytes, 0),
		oldest: files[0]?.day ?? null,
		newest: files.at(-1)?.day ?? null,
	};
}

export function countDatasetRows(files: ReadonlyArray<DatasetFile>): Record<DatasetRowKind | "unrecognized", number> {
	const counts = { decision: 0, spec: 0, outcome: 0, unrecognized: 0 };
	for (const file of files) {
		for (const line of iterateDatasetLines(file)) counts[rowKindOf(line) ?? "unrecognized"] += 1;
	}
	return counts;
}

export interface RetentionLimits {
	readonly retentionDays: number;
	readonly maxMiB: number;
}

/**
 * Delete day files older than `retentionDays`, then the oldest remaining files
 * until the directory is under `maxMiB`. The newest file is never deleted for
 * size: it is the one being written, and a day that alone exceeds the cap is
 * something doctor reports rather than data this pass discards. Returns the
 * days it deleted.
 */
export function pruneDataset(dir: string, limits: RetentionLimits, nowMs: number): string[] {
	const files = listDatasetFiles(dir);
	const cutoff = new Date(nowMs - limits.retentionDays * DAY_MS).toISOString().slice(0, 10);
	const deleted: string[] = [];
	const remove = (file: DatasetFile): void => {
		try {
			unlinkSync(file.path);
			deleted.push(file.day);
		} catch (err) {
			// Another process's pass got there first; anything else is a real failure.
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	};
	const kept: DatasetFile[] = [];
	for (const file of files) {
		if (file.day < cutoff) remove(file);
		else kept.push(file);
	}
	let total = kept.reduce((sum, file) => sum + file.bytes, 0);
	while (total > limits.maxMiB * MIB && kept.length > 1) {
		const oldest = kept.shift();
		if (oldest === undefined) break;
		remove(oldest);
		total -= oldest.bytes;
	}
	return deleted;
}
