import { constants, existsSync, readdirSync, readFileSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { resolvePackageRoot } from "../../core/package-root.js";
import { processBirthToken } from "../../core/process-identity.js";
import { safeResourceWrite, safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import { withStateFileLock } from "../../core/state-file-lock.js";
import type { TelemetryCapture } from "../../core/telemetry/capture.js";
import { captureAdmits, STANDARD_CAPTURE, sameTelemetryCapture } from "../../core/telemetry/capture.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { telemetryOwner } from "../../core/telemetry/context.js";
import type { ClockOrigin, SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord, readTelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload, JournalEventName, PreimageEventName } from "../../core/telemetry/events.js";
import { PREIMAGE_SUBJECTS } from "../../core/telemetry/events.js";
import { newRecordId } from "../../core/telemetry/ids.js";
import type { PendingTelemetry, TelemetrySink } from "../../core/telemetry/producer.js";
import { registerRunTelemetrySink, registerTelemetrySink } from "../../core/telemetry/producer.js";
import type { SegmentScan } from "../../core/telemetry/segment.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../../core/telemetry/segment.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";
import { canonicalJson } from "../prompts/hash.js";
import { storeTelemetryObject } from "./objects.js";

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
	admits(kind: JournalEventName): boolean;
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

/**
 * What one owner's writer made durable, published after fsync so a live fold reads exactly the bytes a cold reader
 * would (#434 §11). `rewritten` means the writer replaced bytes an earlier read may hold (a torn-tail repair), so a
 * live reader re-reads instead of appending; `failed` means the writer stopped and its health changed.
 */
export type PersistedTelemetry =
	| { kind: "appended"; bytes: Buffer; origin: ClockOrigin }
	| { kind: "rewritten" }
	| { kind: "failed" };
type PersistedListener = (owner: string, event: PersistedTelemetry) => void;
const persistedListeners = new Map<string, Set<PersistedListener>>();
const anyOwnerListeners = new Set<PersistedListener>();
const openJournalHealth = new Map<string, () => JournalHealth>();

function subscribed(owner: string): boolean {
	return anyOwnerListeners.size > 0 || persistedListeners.has(owner);
}

function addListener(set: Set<PersistedListener>, listener: PersistedListener): PersistedListener {
	// Each subscription is its own entry, so subscribing one callback twice needs two unsubscribes.
	const entry: PersistedListener = (owner, event) => listener(owner, event);
	set.add(entry);
	return entry;
}

/** Owner keys are `telemetryOwner()` values; the listener runs inside the writer's flush and must stay cheap. */
export function subscribePersistedTelemetry(owner: string, listener: PersistedListener): () => void {
	let set = persistedListeners.get(owner);
	if (!set) {
		set = new Set();
		persistedListeners.set(owner, set);
	}
	const entry = addListener(set, listener);
	return () => {
		set.delete(entry);
		if (set.size === 0 && persistedListeners.get(owner) === set) persistedListeners.delete(owner);
	};
}

/** Every owner's batches, for a reader that learns which owners it needs only after a cold read (#434). */
export function subscribeAllPersistedTelemetry(listener: PersistedListener): () => void {
	const entry = addListener(anyOwnerListeners, listener);
	return () => anyOwnerListeners.delete(entry);
}

function publishPersisted(owner: string, event: PersistedTelemetry): void {
	for (const listener of [...(persistedListeners.get(owner) ?? []), ...anyOwnerListeners]) {
		try {
			listener(owner, event);
		} catch {
			// A reader's failure never reaches the writer; durability already happened (#434).
		}
	}
}

/** Health of every journal this process holds open, keyed by owner. */
export function openCallJournalHealth(): Array<{ owner: string; health: JournalHealth }> {
	return [...openJournalHealth].map(([owner, health]) => ({ owner, health: health() }));
}

function rotatedName(fileName: JournalFileName, id: string): string {
	return fileName === "calls.jsonl" ? `calls.${id}.jsonl` : `events.${id}.ndjson`;
}

export function journalFiles(names: string[], fileName: JournalFileName): string[] {
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

/** Only the newly created child's cold fork path calls this, before any writer can acquire it (#434). */
export function seedForkCallJournal(
	directory: string,
	sessionId: string,
	lineage: EventPayload<"session.forked">,
): void {
	const path = join(directory, "calls.jsonl");
	if (existsSync(path)) throw new Error("fork journal already exists");
	const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		version: string;
		dependencies: Record<string, string>;
	};
	const header = callJournalHeader({
		clioCoderVersion: pkg.version,
		piVersion: pkg.dependencies["@earendil-works/pi-ai"] ?? "unknown",
	});
	const row = makeTelemetryRecord(
		"session.forked",
		lineage,
		{ sessionId, label: "main" },
		{
			t: new Date().toISOString(),
			mono: performance.now(),
		},
	);
	safeResourceWrite(path, Buffer.concat([encodeTelemetryLine(header), encodeTelemetryLine(row)]), { mode: 0o600 });
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
	const hubOwner = telemetryOwner(options.context);
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
				makeTelemetryRecord("journal.gap", { sink: fileName, reason, count }, options.context, {
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
			if (subscribed(hubOwner))
				publishPersisted(
					hubOwner,
					scan.tornTailBytes > 0 ? { kind: "rewritten" } : { kind: "appended", bytes: opening, origin: header.clockOrigin },
				);
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
				// Behind a batch in flight, check again once it lands: another waiter may have started the next batch with
				// the records queued meanwhile, and this flush must not return before that batch is written either (#434).
				if (flushing) return flushing.then(flush);
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
						let unstoredBatch = 0;
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
							let data = pending.data;
							if (pending.preimage !== undefined) {
								// Content is reserved against the cap and durable in objects/ before a record cites it (#434).
								const subject = Object.hasOwn(PREIMAGE_SUBJECTS, pending.kind)
									? PREIMAGE_SUBJECTS[pending.kind as PreimageEventName]
									: undefined;
								let bytes: number;
								try {
									if (subject === undefined) throw new Error("kind carries no preimage");
									bytes = Buffer.byteLength(canonicalJson(pending.preimage));
								} catch {
									invalidBatch += 1;
									continue;
								}
								if (researchBytes + bytes > researchCap) {
									capped += 1;
									continue;
								}
								researchBytes += bytes;
								try {
									const content = await storeTelemetryObject(options.sessionDirectory, subject, pending.preimage);
									data = { ...pending.data, content, bytes } as typeof data;
								} catch {
									researchBytes -= bytes;
									unstoredBatch += 1;
									continue;
								}
							}
							const record = redactSecretsDeep(
								{
									...makeTelemetryRecord(pending.kind, data, pending.ctx, {
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
						// A preimage that could not be stored drops its record; nothing may cite content that is not on disk.
						dropped += unstoredBatch;
						if (dropped > reportedDrops) {
							lines.push(encodeTelemetryLine(gap("writer-drop", dropped - reportedDrops)));
							reportedDrops = dropped;
						}
						if (capped > reportedCapped) {
							lines.push(encodeTelemetryLine(gap("research-cap", capped - reportedCapped)));
							reportedCapped = capped;
						}
						if (!handle) throw new Error("call journal closed before flush");
						let rotation: Buffer[] = [];
						if (size >= (options.segmentBytes ?? 32 * 1024 * 1024)) {
							const closing = encodeTelemetryLine(
								makeTelemetryRecord("journal.segment_closed", { reason: "rotation" }, options.context, {
									t: new Date().toISOString(),
									mono: performance.now(),
								}),
							);
							await appendAll(handle, closing);
							await handle.sync();
							await handle.close();
							handle = undefined;
							await rename(path, join(options.sessionDirectory, rotatedName(fileName, newRecordId())));
							const opened = encodeTelemetryLine(header);
							await safeResourceWriteAsync(path, opened, { mode: 0o600 });
							handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
							size = opened.length;
							rotation = [closing, opened];
						} else if (modeChanged) {
							// A mode change closes the segment in place and opens one whose header admits what follows.
							lines.unshift(
								encodeTelemetryLine(
									makeTelemetryRecord("journal.segment_closed", { reason: "mode-change" }, options.context, {
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
						// Nothing is decoded or copied for a headless run or worker that nobody reads live (#434).
						if (subscribed(hubOwner))
							publishPersisted(hubOwner, {
								kind: "appended",
								bytes: rotation.length > 0 ? Buffer.concat([...rotation, batch]) : batch,
								origin: header.clockOrigin,
							});
					} catch {
						// A partial write is repaired by the next owner. Do not append behind an uncertain tail (#434).
						writeErrors += 1;
						failed = true;
						dropped += dequeued + count;
						ring.fill(undefined);
						count = 0;
						if (subscribed(hubOwner)) publishPersisted(hubOwner, { kind: "failed" });
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
			openJournalHealth.set(hubOwner, health);
			ready(journal);
			await lifetime;
		},
		{ timeoutMs: 0 },
	).finally(async () => {
		unregister?.();
		openJournalHealth.delete(hubOwner);
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
	/** The clock origin of the last segment read: the process that last owned the journal (#434 §6.1). */
	writer?: ClockOrigin;
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

/** Fold one published batch into a read exactly as a cold read of the same bytes would (#434 §11). */
export function appendPersistedTelemetry(result: CallJournalRead, batch: { bytes: Buffer; origin: ClockOrigin }): void {
	appendReadSegment(result, batch.bytes, batch.origin);
}

function appendReadSegment(result: CallJournalRead, bytes: Buffer, continuing?: ClockOrigin): void {
	const scan = scanTelemetrySegment(bytes);
	if (scan.corruptOffset !== null || scan.tornTailBytes > 0) result.damaged += 1;
	let origin: ClockOrigin | undefined = continuing;
	if (continuing) result.writer = continuing;
	for (const row of scan.rows) {
		if (row.kind === "header") {
			origin = row.header.clockOrigin;
			result.writer = origin;
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
