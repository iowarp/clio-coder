import { constants, readdirSync, readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { processBirthToken } from "../../core/process-identity.js";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { TelemetryCapture } from "../../core/telemetry/capture.js";
import { captureAdmits, STANDARD_CAPTURE, sameTelemetryCapture } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { telemetryOwner } from "../../core/telemetry/context.js";
import type { ClockOrigin, SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "../../core/telemetry/envelope.js";
import { newRecordId } from "../../core/telemetry/ids.js";
import type { PendingTelemetry, TelemetrySink } from "../../core/telemetry/producer.js";
import { registerRunTelemetrySink, registerTelemetrySink } from "../../core/telemetry/producer.js";
import type { Kind } from "../../core/telemetry/schemas.js";
import type { SegmentScan } from "../../core/telemetry/segment.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../core/telemetry/segment.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";

export interface JournalHealth {
	queueDepth: number;
	persisted: number;
	dropped: number;
	invalid: number;
	/** Records queued under a mode their segment no longer admitted at write time (#434). */
	filtered: number;
	/** Research records and preimages refused at the session's research byte cap (#434). */
	capped: number;
	writeErrors: number;
	skipped: number;
}
export interface CallJournal extends TelemetrySink {
	admits(kind: Kind): boolean;
	flush(): Promise<void>;
	close(): Promise<void>;
	health(): JournalHealth;
	/**
	 * Reserve research-capture bytes for a preimage before storing it. False at the cap: the caller stores
	 * nothing, and the next batch records a research-cap gap (#434).
	 */
	reserveResearchBytes(bytes: number): boolean;
}
export interface CallJournalOptions {
	sessionDirectory: string;
	fileName?: JournalFileName;
	context: TelemetryContext;
	writer: SegmentHeader["writer"];
	queueCapacity?: number;
	segmentBytes?: number;
	/** Read when a segment opens and before every batch; a change opens a new segment. Defaults to standard (#434). */
	capture?: () => TelemetryCapture;
	/** Research capture budget across the journal's segments and the preimages its records declare. */
	researchBytes?: number;
}

/** Research mode is capped per session apart from standard retention (#434, §14). */
export const RESEARCH_SESSION_BYTES = 256 * 1024 * 1024;

/** Preimage bytes a research record declares it stored in `objects/`. */
function declaredBytes(record: TelemetryRecord): number {
	const declared = (record.data as { bytes?: unknown }).bytes;
	return typeof declared === "number" ? declared : 0;
}

/** Every segment of the journal counts toward the cap; a segment that cannot be read leaves capture at the cap. */
async function researchBytesOnDisk(directory: string, fileName: JournalFileName, active: SegmentScan): Promise<number> {
	let total = 0;
	const count = (scan: SegmentScan) => {
		for (const row of scan.rows)
			if (row.kind === "record" && row.record.tier === "research")
				total += encodeTelemetryLine(row.record).length + declaredBytes(row.record);
	};
	count(active);
	for (const file of journalFiles(await readdir(directory), fileName)) {
		if (file !== fileName) count(scanTelemetrySegment(await readFile(join(directory, file))));
	}
	return total;
}

export type JournalFileName = "calls.jsonl" | "events.ndjson";

function rotatedName(fileName: JournalFileName, id: string): string {
	return fileName === "calls.jsonl" ? `calls.${id}.jsonl` : `events.${id}.ndjson`;
}

function journalFiles(names: string[], fileName: JournalFileName): string[] {
	const pattern = fileName === "calls.jsonl" ? /^calls\.rec_[0-9a-f-]+\.jsonl$/ : /^events\.rec_[0-9a-f-]+\.ndjson$/;
	const files = names.filter((name) => pattern.test(name)).sort();
	if (names.includes(fileName)) files.push(fileName);
	return files;
}

/** Fork initialization and live owners use the same segment and clock contract (#434). */
export function callJournalHeader(
	writer: SegmentHeader["writer"],
	capture: TelemetryCapture = STANDARD_CAPTURE,
): SegmentHeader {
	return {
		v: 1,
		k: "segment.open",
		schemaSet: "clio-telemetry/1",
		mode: capture.mode,
		capture: { ...capture.capture },
		clockOrigin: {
			host: hostname(),
			pid: process.pid,
			birthToken: processBirthToken(),
			monoEpochWallMs: performance.timeOrigin,
		},
		writer: writer,
	};
}

/** One lease for the writer's lifetime, adjudicated by host, pid and birth token (#434). */
export async function openCallJournal(options: CallJournalOptions): Promise<CallJournal> {
	const fileName = options.fileName ?? "calls.jsonl";
	const path = join(options.sessionDirectory, fileName);
	await mkdir(dirname(path), { recursive: true });
	let ready!: (journal: CallJournal) => void;
	let reject!: (error: unknown) => void;
	const opened = new Promise<CallJournal>((resolve, fail) => {
		ready = resolve;
		reject = fail;
	});
	let release!: () => void;
	const lifetime = new Promise<void>((resolve) => {
		release = resolve;
	});
	let unregister: (() => void) | undefined;
	let handle: FileHandle | undefined;
	// A mode lookup that throws captures standard only; the segment header must still say what it admits (#434).
	const captureNow = (): TelemetryCapture => {
		try {
			return options.capture?.() ?? STANDARD_CAPTURE;
		} catch {
			return STANDARD_CAPTURE;
		}
	};
	const owner = withStateFileLock(
		path,
		async () => {
			let capture = captureNow();
			let header = callJournalHeader(options.writer, capture);
			let bytes: Buffer;
			try {
				const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
				try {
					bytes = await existing.readFile();
				} finally {
					await existing.close();
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				bytes = Buffer.alloc(0);
			}
			const scan = scanTelemetrySegment(bytes);
			if (scan.corruptOffset !== null)
				throw new Error(`call journal has interior corruption at byte ${scan.corruptOffset}`);
			if (bytes.length > 0 && scan.rows[0]?.kind !== "header") {
				// Another installation may own a newer segment format. Never truncate or retire it (#434).
				throw new Error("call journal segment header is unsupported");
			}
			const gap = (
				reason: "torn-tail" | "writer-drop" | "invalid-record" | "mode-filtered" | "research-cap",
				count: number,
			) =>
				makeTelemetryRecord("gap", { sink: fileName, reason, count }, options.context, {
					t: new Date().toISOString(),
					mono: performance.now(),
				});
			// Initial creation and tail repair use the durable replacement primitive. Normal batches
			// append with a checked async write and fsync under this exclusive lease (#434).
			const prefix = bytes.subarray(0, scan.validBytes);
			const opening = Buffer.concat([
				encodeTelemetryLine(header),
				...(scan.tornTailBytes ? [encodeTelemetryLine(gap("torn-tail", 1))] : []),
			]);
			if (bytes.length === 0 || scan.tornTailBytes > 0) {
				await safeResourceWriteAsync(path, Buffer.concat([prefix, opening]), { mode: 0o600 });
				handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
			} else {
				handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
				await appendAll(handle, opening);
				await handle.sync();
			}
			let size = prefix.length + opening.length;
			const researchCap = options.researchBytes ?? RESEARCH_SESSION_BYTES;
			let researchBytes = await researchBytesOnDisk(options.sessionDirectory, fileName, scan).catch(() => researchCap);
			let capped = 0;
			let reportedCapped = 0;
			const capacity = options.queueCapacity ?? 4096;
			if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)
				throw new Error("invalid call journal queue capacity");
			const ring: Array<PendingTelemetry | undefined> = new Array(capacity);
			let head = 0;
			let count = 0;
			let dropped = 0;
			let reportedDrops = 0;
			let invalid = 0;
			let filtered = 0;
			let persisted = 0;
			let writeErrors = 0;
			let closed = false;
			let failed = false;
			let scheduled: NodeJS.Immediate | undefined;
			let flushing: Promise<void> | undefined;
			let closing: Promise<void> | undefined;
			const skipped = scan.rows.filter((row) => row.kind === "skipped").length;
			const health = (): JournalHealth => ({
				queueDepth: count,
				persisted,
				dropped,
				invalid,
				filtered,
				capped,
				writeErrors,
				skipped,
			});
			const schedule = () => {
				if (scheduled || flushing || closed || failed) return;
				scheduled = setImmediate(() => {
					scheduled = undefined;
					void flush();
				});
			};
			const flush = (): Promise<void> => {
				if (failed) return Promise.resolve();
				if (flushing)
					return flushing.then(() =>
						count > 0 || dropped > reportedDrops || capped > reportedCapped ? flush() : undefined,
					);
				if (count === 0 && dropped === reportedDrops && capped === reportedCapped) return Promise.resolve();
				if (scheduled) {
					clearImmediate(scheduled);
					scheduled = undefined;
				}
				flushing = (async () => {
					let batchCount = 0;
					let dequeued = 0;
					try {
						const lines: Buffer[] = [];
						// Records already queued are written under the new mode, so a change record enqueued after
						// the settings changed is the first record of the new segment (#434).
						const next = captureNow();
						const modeChanged = !sameTelemetryCapture(next, capture);
						if (modeChanged) {
							capture = next;
							header = callJournalHeader(options.writer, capture);
						}
						if (dropped > reportedDrops) {
							lines.push(encodeTelemetryLine(gap("writer-drop", dropped - reportedDrops)));
							reportedDrops = dropped;
						}
						let invalidBatch = 0;
						let filteredBatch = 0;
						while (count > 0) {
							const pending = ring[head];
							ring[head] = undefined;
							head = (head + 1) % capacity;
							count -= 1;
							if (!pending) continue;
							dequeued += 1;
							if (!captureAdmits(capture, pending.kind)) {
								filteredBatch += 1;
								continue;
							}
							const record = redactSecretsDeep(
								{
									...makeTelemetryRecord(pending.kind, pending.data, pending.ctx, {
										t: new Date(pending.wallMs).toISOString(),
										mono: pending.mono,
									}),
									...(pending.recordId ? { id: pending.recordId } : {}),
									...(pending.origin ? { origin: pending.origin } : {}),
								},
								createRedactionTally(),
							);
							if (readTelemetryRecord(record).kind !== "record") {
								invalidBatch += 1;
								continue;
							}
							const line = encodeTelemetryLine(record);
							if (record.tier === "research") {
								// The preimage was reserved before it was stored; only the record itself is new here.
								const cost = line.length;
								if (researchBytes + cost > researchCap) {
									capped += 1;
									continue;
								}
								researchBytes += cost;
							}
							lines.push(line);
							batchCount += 1;
						}
						invalid += invalidBatch;
						if (invalidBatch) lines.push(encodeTelemetryLine(gap("invalid-record", invalidBatch)));
						filtered += filteredBatch;
						if (filteredBatch) lines.push(encodeTelemetryLine(gap("mode-filtered", filteredBatch)));
						if (capped > reportedCapped) {
							lines.push(encodeTelemetryLine(gap("research-cap", capped - reportedCapped)));
							reportedCapped = capped;
						}
						if (!handle) throw new Error("call journal closed before flush");
						if (size >= (options.segmentBytes ?? 32 * 1024 * 1024)) {
							await appendAll(
								handle,
								encodeTelemetryLine(
									makeTelemetryRecord("segment.closed", { reason: "rotation" }, options.context, {
										t: new Date().toISOString(),
										mono: performance.now(),
									}),
								),
							);
							await handle.sync();
							await handle.close();
							handle = undefined;
							await rename(path, join(options.sessionDirectory, rotatedName(fileName, newRecordId())));
							await safeResourceWriteAsync(path, encodeTelemetryLine(header), { mode: 0o600 });
							handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
							size = encodeTelemetryLine(header).length;
						} else if (modeChanged) {
							// A mode change closes the segment in place and opens one whose header admits what follows.
							lines.unshift(
								encodeTelemetryLine(
									makeTelemetryRecord("segment.closed", { reason: "mode-change" }, options.context, {
										t: new Date().toISOString(),
										mono: performance.now(),
									}),
								),
								encodeTelemetryLine(header),
							);
						}
						const batch = Buffer.concat(lines);
						await appendAll(handle, batch);
						await handle.sync();
						size += batch.length;
						persisted += batchCount;
					} catch {
						// A partial write is repaired by the next owner. Do not append behind an uncertain tail (#434).
						writeErrors += 1;
						failed = true;
						dropped += dequeued + count;
						ring.fill(undefined);
						count = 0;
					}
				})().finally(() => {
					flushing = undefined;
					if (count > 0 || dropped > reportedDrops || capped > reportedCapped) schedule();
				});
				return flushing;
			};
			const journal: CallJournal = {
				admits(kind) {
					return captureAdmits(captureNow(), kind);
				},
				reserveResearchBytes(bytes) {
					if (closed || failed) return false;
					if (!Number.isSafeInteger(bytes) || bytes < 0 || researchBytes + bytes > researchCap) {
						capped += 1;
						schedule();
						return false;
					}
					researchBytes += bytes;
					return true;
				},
				enqueue(record) {
					if (closed || failed || telemetryOwner(record.ctx) !== telemetryOwner(options.context) || count === capacity) {
						dropped += 1;
						schedule();
						return false;
					}
					ring[(head + count) % capacity] = record;
					count += 1;
					schedule();
					return true;
				},
				flush,
				health,
				close() {
					if (closing) return closing;
					closed = true;
					unregister?.();
					closing = (async () => {
						await flush();
						if (scheduled) clearImmediate(scheduled);
						release();
						await owner;
					})();
					return closing;
				},
			};
			if (options.context.runId !== undefined) unregister = registerRunTelemetrySink(options.context.runId, journal);
			else if (options.context.sessionId !== null) unregister = registerTelemetrySink(options.context.sessionId, journal);
			else throw new Error("telemetry journal requires a session or run owner");
			ready(journal);
			await lifetime;
		},
		{ timeoutMs: 0 },
	).finally(async () => {
		unregister?.();
		await handle?.close();
	});
	void owner.catch(reject);
	return opened;
}

async function appendAll(handle: FileHandle, bytes: Buffer): Promise<void> {
	let offset = 0;
	while (offset < bytes.length) {
		const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
		if (bytesWritten === 0) throw new Error("call journal append made no progress");
		offset += bytesWritten;
	}
}

export interface CallJournalRead {
	records: Array<{ record: TelemetryRecord; origin: ClockOrigin }>;
	skipped: number;
	damaged: number;
	/** Each readable segment's capture mode, in read order (#434 §9). */
	modes?: Array<SegmentHeader["mode"]>;
}

/** Read-only readers preserve future records and never repair a writer's file (#434). */
export async function readCallJournal(
	sessionDirectory: string,
	fileName: JournalFileName = "calls.jsonl",
): Promise<CallJournalRead> {
	return readCallJournalSnapshot(sessionDirectory, fileName, 3);
}

async function readCallJournalSnapshot(
	sessionDirectory: string,
	fileName: JournalFileName,
	retries: number,
): Promise<CallJournalRead> {
	const result: CallJournalRead = { records: [], skipped: 0, damaged: 0 };
	let names: string[];
	try {
		names = await readdir(sessionDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	const files = journalFiles(names, fileName);
	for (const file of files) {
		let bytes: Buffer;
		try {
			bytes = await readFile(join(sessionDirectory, file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && retries > 0)
				return readCallJournalSnapshot(sessionDirectory, fileName, retries - 1);
			throw error;
		}
		appendReadSegment(result, bytes);
	}
	const after = journalFiles(await readdir(sessionDirectory), fileName).sort();
	if (after.join("\n") !== [...files].sort().join("\n")) {
		if (retries > 0) return readCallJournalSnapshot(sessionDirectory, fileName, retries - 1);
		throw new Error("call journal rotated repeatedly during read");
	}
	return result;
}

function appendReadSegment(result: CallJournalRead, bytes: Buffer): void {
	const scan = scanTelemetrySegment(bytes);
	if (scan.corruptOffset !== null || scan.tornTailBytes > 0) result.damaged += 1;
	let origin: ClockOrigin | undefined;
	for (const row of scan.rows) {
		if (row.kind === "header") {
			origin = row.header.clockOrigin;
			result.modes = [...(result.modes ?? []), row.header.mode];
		} else if (row.kind === "record" && origin)
			result.records.push({ record: row.record, origin: row.record.origin ?? origin });
		else {
			if (row.kind === "skipped" && row.segment) origin = undefined;
			result.skipped += 1;
		}
	}
}

/** Session switches already read their ledger synchronously; take the journal snapshot in that same cold path (#434). */
export function readCallJournalSync(
	sessionDirectory: string,
	fileName: JournalFileName = "calls.jsonl",
): CallJournalRead {
	const names = () => journalFiles(readdirSync(sessionDirectory), fileName);
	for (let retry = 0; retry < 3; retry += 1) {
		const result: CallJournalRead = { records: [], skipped: 0, damaged: 0 };
		let files: string[];
		try {
			files = names();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
			throw error;
		}
		try {
			for (const file of files) appendReadSegment(result, readFileSync(join(sessionDirectory, file)));
			if (files.join("\n") === names().join("\n")) return result;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	throw new Error("call journal rotated repeatedly during read");
}
