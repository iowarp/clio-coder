import { constants, readdirSync, readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { processBirthToken } from "../../core/process-identity.js";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { telemetryOwner } from "../../core/telemetry/context.js";
import type { ClockOrigin, SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "../../core/telemetry/envelope.js";
import { newRecordId } from "../../core/telemetry/ids.js";
import type { PendingTelemetry, TelemetrySink } from "../../core/telemetry/producer.js";
import { registerRunTelemetrySink, registerTelemetrySink } from "../../core/telemetry/producer.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../core/telemetry/segment.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";

export interface JournalHealth {
	queueDepth: number;
	persisted: number;
	dropped: number;
	invalid: number;
	writeErrors: number;
	skipped: number;
}
export interface CallJournal extends TelemetrySink {
	flush(): Promise<void>;
	close(): Promise<void>;
	health(): JournalHealth;
}
export interface CallJournalOptions {
	sessionDirectory: string;
	context: TelemetryContext;
	writer: SegmentHeader["writer"];
	queueCapacity?: number;
	segmentBytes?: number;
}

/** One lease for the writer's lifetime, adjudicated by host, pid and birth token (#434). */
export async function openCallJournal(options: CallJournalOptions): Promise<CallJournal> {
	const path = join(options.sessionDirectory, "calls.jsonl");
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
	const owner = withStateFileLock(
		path,
		async () => {
			const header: SegmentHeader = {
				v: 1,
				k: "segment.open",
				schemaSet: "clio-telemetry/1",
				mode: "standard",
				capture: { content: false, deltas: false, providerHeaders: false, systemOneDataset: false, busTrace: false },
				clockOrigin: {
					host: hostname(),
					pid: process.pid,
					birthToken: processBirthToken(),
					monoEpochWallMs: performance.timeOrigin,
				},
				writer: options.writer,
			};
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
			const gap = (reason: "torn-tail" | "writer-drop" | "invalid-record", count: number) =>
				makeTelemetryRecord("gap", { sink: "calls.jsonl", reason, count }, options.context, {
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
			const capacity = options.queueCapacity ?? 4096;
			if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000)
				throw new Error("invalid call journal queue capacity");
			const ring: Array<PendingTelemetry | undefined> = new Array(capacity);
			let head = 0;
			let count = 0;
			let dropped = 0;
			let reportedDrops = 0;
			let invalid = 0;
			let persisted = 0;
			let writeErrors = 0;
			let closed = false;
			let failed = false;
			let scheduled: NodeJS.Immediate | undefined;
			let flushing: Promise<void> | undefined;
			let closing: Promise<void> | undefined;
			const skipped = scan.rows.filter((row) => row.kind === "skipped").length;
			const health = (): JournalHealth => ({ queueDepth: count, persisted, dropped, invalid, writeErrors, skipped });
			const schedule = () => {
				if (scheduled || flushing || closed || failed) return;
				scheduled = setImmediate(() => {
					scheduled = undefined;
					void flush();
				});
			};
			const flush = (): Promise<void> => {
				if (failed) return Promise.resolve();
				if (flushing) return flushing.then(() => (count > 0 || dropped > reportedDrops ? flush() : undefined));
				if (count === 0 && dropped === reportedDrops) return Promise.resolve();
				if (scheduled) {
					clearImmediate(scheduled);
					scheduled = undefined;
				}
				flushing = (async () => {
					let batchCount = 0;
					let dequeued = 0;
					try {
						const lines: Buffer[] = [];
						if (dropped > reportedDrops) {
							lines.push(encodeTelemetryLine(gap("writer-drop", dropped - reportedDrops)));
							reportedDrops = dropped;
						}
						let invalidBatch = 0;
						while (count > 0) {
							const pending = ring[head];
							ring[head] = undefined;
							head = (head + 1) % capacity;
							count -= 1;
							if (!pending) continue;
							dequeued += 1;
							const record = redactSecretsDeep(
								makeTelemetryRecord(pending.kind, pending.data, pending.ctx, {
									t: new Date(pending.wallMs).toISOString(),
									mono: pending.mono,
								}),
								createRedactionTally(),
							);
							if (readTelemetryRecord(record).kind !== "record") {
								invalidBatch += 1;
								continue;
							}
							lines.push(encodeTelemetryLine(record));
							batchCount += 1;
						}
						invalid += invalidBatch;
						if (invalidBatch) lines.push(encodeTelemetryLine(gap("invalid-record", invalidBatch)));
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
							await rename(path, join(options.sessionDirectory, `calls.${newRecordId()}.jsonl`));
							await safeResourceWriteAsync(path, encodeTelemetryLine(header), { mode: 0o600 });
							handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
							size = encodeTelemetryLine(header).length;
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
					if (count > 0 || dropped > reportedDrops) schedule();
				});
				return flushing;
			};
			const journal: CallJournal = {
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
}

/** Read-only readers preserve future records and never repair a writer's file (#434). */
export async function readCallJournal(sessionDirectory: string): Promise<CallJournalRead> {
	return readCallJournalSnapshot(sessionDirectory, 3);
}

async function readCallJournalSnapshot(sessionDirectory: string, retries: number): Promise<CallJournalRead> {
	const result: CallJournalRead = { records: [], skipped: 0, damaged: 0 };
	let names: string[];
	try {
		names = await readdir(sessionDirectory);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
		throw error;
	}
	const files = names.filter((name) => /^calls\.rec_[0-9a-f-]+\.jsonl$/.test(name)).sort();
	if (names.includes("calls.jsonl")) files.push("calls.jsonl");
	for (const file of files) {
		let bytes: Buffer;
		try {
			bytes = await readFile(join(sessionDirectory, file));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT" && retries > 0)
				return readCallJournalSnapshot(sessionDirectory, retries - 1);
			throw error;
		}
		appendReadSegment(result, bytes);
	}
	const after = (await readdir(sessionDirectory))
		.filter((name) => name === "calls.jsonl" || /^calls\.rec_[0-9a-f-]+\.jsonl$/.test(name))
		.sort();
	if (after.join("\n") !== [...files].sort().join("\n")) {
		if (retries > 0) return readCallJournalSnapshot(sessionDirectory, retries - 1);
		throw new Error("call journal rotated repeatedly during read");
	}
	return result;
}

function appendReadSegment(result: CallJournalRead, bytes: Buffer): void {
	const scan = scanTelemetrySegment(bytes);
	if (scan.corruptOffset !== null || scan.tornTailBytes > 0) result.damaged += 1;
	let origin: ClockOrigin | undefined;
	for (const row of scan.rows) {
		if (row.kind === "header") origin = row.header.clockOrigin;
		else if (row.kind === "record" && origin) result.records.push({ record: row.record, origin });
		else {
			if (row.kind === "skipped" && row.segment) origin = undefined;
			result.skipped += 1;
		}
	}
}

/** Session switches already read their ledger synchronously; take the journal snapshot in that same cold path (#434). */
export function readCallJournalSync(sessionDirectory: string): CallJournalRead {
	const names = () =>
		readdirSync(sessionDirectory)
			.filter((name) => name === "calls.jsonl" || /^calls\.rec_[0-9a-f-]+\.jsonl$/.test(name))
			.sort((left, right) => (left === "calls.jsonl" ? 1 : right === "calls.jsonl" ? -1 : left.localeCompare(right)));
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
