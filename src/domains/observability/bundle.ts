import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CaptureFlags, TelemetryCapture } from "../../core/telemetry/capture.js";
import { STANDARD_CAPTURE } from "../../core/telemetry/capture.js";
import type { SegmentHeader } from "../../core/telemetry/envelope.js";
import { readTelemetryRecord } from "../../core/telemetry/envelope.js";
import { crc32, scanTelemetrySegment } from "../../core/telemetry/segment.js";
import type { JournalFileName } from "./call-journal.js";
import { journalFiles } from "./call-journal.js";

/**
 * A telemetry bundle is the exchange and golden-fixture format for one session's
 * journal (#434, P4): `bundle.json`, `calls.jsonl` with every segment's lines
 * verbatim, `runs/<runId>/events.ndjson` for each run the session references,
 * only the `objects/` its records reference, and `current.jsonl` only when
 * content was exported under research mode and consent.
 */
export const BUNDLE_FORMAT = "clio-telemetry-bundle/1";
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const OBJECT_ID = /^obj_[0-9a-f]{64}$/;
const CONTENT_SUBJECTS = new Set(["prompt-text", "request"]);

export interface BundleFile {
	path: string;
	sha256: string;
	bytes: number;
	/** Journal records (headers excluded), ledger lines, or 1 for an object. */
	records: number;
}

export interface BundleManifest {
	format: typeof BUNDLE_FORMAT;
	createdAt: string;
	writer: SegmentHeader["writer"];
	source: {
		sessionId: string;
		cwdHash: string;
		/** Ancestor facts are not copied; a fork's bundle folds its own calls only. */
		forkedFrom: { parentSessionId: string; parentTurnId: string } | null;
		runs: string[];
	};
	/** The most any line or file in the bundle captured; content is true only when content was exported. */
	ceiling: TelemetryCapture;
	excluded: {
		contentBearing: number;
		/** Lines whose content class this version cannot read; a content-free export never guesses. */
		unclassified: number;
		/** A live writer's unfinished last line in any copied file. */
		tornTailBytes: number;
		missingRuns: string[];
		missingObjects: string[];
	};
	files: BundleFile[];
}

interface FilteredJournal {
	bytes: Buffer;
	records: number;
	headers: SegmentHeader[];
	parsed: Array<Record<string, unknown>>;
	contentBearing: number;
	unclassified: number;
	tornTailBytes: number;
}

/** Complete, checksummed lines; interior corruption stops the export rather than dropping later facts. */
function* journalLines(bytes: Buffer): Generator<{ line: Buffer; value: unknown } | { torn: number }> {
	let offset = 0;
	while (offset < bytes.length) {
		const newline = bytes.indexOf(0x0a, offset);
		const end = newline < 0 ? bytes.length : newline;
		const line = bytes.subarray(offset, end);
		const json = line.subarray(0, -10);
		const valid =
			/^\t#[0-9a-f]{8}$/.test(line.subarray(-10).toString("ascii")) && crc32(json) === line.subarray(-8).toString("ascii");
		if (newline < 0 || !valid) {
			if (newline < 0 || newline === bytes.length - 1) {
				yield { torn: bytes.length - offset };
				return;
			}
			throw new Error(`journal has interior corruption at byte ${offset}`);
		}
		let value: unknown;
		try {
			value = JSON.parse(json.toString("utf8"));
		} catch {
			value = null;
		}
		yield { line: bytes.subarray(offset, newline + 1), value };
		offset = newline + 1;
	}
}

function filterJournal(
	segments: Buffer[],
	content: boolean,
	keep: (value: Record<string, unknown>) => boolean,
): FilteredJournal {
	const out: FilteredJournal = {
		bytes: Buffer.alloc(0),
		records: 0,
		headers: [],
		parsed: [],
		contentBearing: 0,
		unclassified: 0,
		tornTailBytes: 0,
	};
	const kept: Buffer[] = [];
	for (const segment of segments) {
		for (const item of journalLines(segment)) {
			if ("torn" in item) {
				out.tornTailBytes += item.torn;
				continue;
			}
			const value = item.value as Record<string, unknown> | null;
			if (value && value.k === "segment.open") {
				const read = readTelemetryRecord(value);
				if (read.kind === "header") out.headers.push(read.header);
				kept.push(item.line);
				continue;
			}
			const cc = value?.cc;
			if (cc !== "content-free" && cc !== "structural" && cc !== "content-bearing") {
				out.unclassified += 1;
				continue;
			}
			if (cc === "content-bearing" && !content) {
				out.contentBearing += 1;
				continue;
			}
			if (!value || !keep(value)) continue;
			kept.push(item.line);
			out.parsed.push(value);
			out.records += 1;
		}
	}
	out.bytes = Buffer.concat(kept);
	return out;
}

async function readRegular(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error(`${path} is not a regular file under 1 GiB`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

/** Every segment of one journal, oldest first, read as one snapshot across a concurrent rotation. */
async function readSegments(directory: string, fileName: JournalFileName): Promise<Buffer[] | null> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		let names: string[];
		try {
			names = await readdir(directory);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const files = journalFiles(names, fileName);
		try {
			const segments = await Promise.all(files.map((file) => readRegular(join(directory, file))));
			if (journalFiles(await readdir(directory), fileName).join("\n") === files.join("\n")) return segments;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	throw new Error(`${directory} rotated repeatedly during export`);
}

/** Resolvable references anywhere in a record's payload, by object id. */
function collectRefs(value: unknown, refs: Map<string, string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectRefs(item, refs);
		return;
	}
	if (!value || typeof value !== "object") return;
	const record = value as Record<string, unknown>;
	if (record.label === "resolvable" && typeof record.id === "string" && OBJECT_ID.test(record.id))
		refs.set(record.id, typeof record.subject === "string" ? record.subject : "unknown");
	for (const child of Object.values(record)) collectRefs(child, refs);
}

function ceilingOf(headers: ReadonlyArray<SegmentHeader>, content: boolean): TelemetryCapture {
	const capture: CaptureFlags = { ...STANDARD_CAPTURE.capture };
	let research = false;
	for (const header of headers) {
		research ||= header.mode === "research";
		for (const flag of Object.keys(capture) as Array<keyof CaptureFlags>) capture[flag] ||= header.capture[flag];
	}
	return { mode: research ? "research" : "standard", capture: { ...capture, content } };
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

async function publish(out: string, files: Map<string, Buffer>, manifest: BundleManifest): Promise<void> {
	await mkdir(dirname(out), { recursive: true });
	const staging = `${out}.partial-${randomBytes(6).toString("hex")}`;
	try {
		for (const [path, bytes] of files) {
			await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o700 });
			await writeFile(join(staging, path), bytes, { mode: 0o600, flag: "wx" });
		}
		await writeFile(join(staging, "bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
		// A complete directory appears at once; a reader never sees a bundle without its manifest.
		await rename(staging, out);
	} catch (error) {
		await rm(staging, { recursive: true, force: true });
		throw error;
	}
}

async function refuseExisting(out: string): Promise<void> {
	try {
		await stat(out);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`refusing to overwrite ${out}`);
}

export interface ExportBundleInput {
	stateDir: string;
	cwdHash: string;
	sessionId: string;
	out: string;
	/** Content-bearing records, content objects and the ledger; the caller has checked research mode and consent. */
	content: boolean;
	writer: SegmentHeader["writer"];
}

/** Read-only over the session: a live writer keeps appending, and its unfinished last line is left out (#434). */
export async function exportTelemetryBundle(input: ExportBundleInput): Promise<BundleManifest> {
	if (!SAFE_ID.test(input.sessionId) || !SAFE_ID.test(input.cwdHash)) throw new Error("invalid session identity");
	await refuseExisting(input.out);
	const directory = join(input.stateDir, "sessions", input.cwdHash, input.sessionId);
	const segments = await readSegments(directory, "calls.jsonl");
	if (segments === null || segments.length === 0) throw new Error(`session ${input.sessionId} has no call journal`);
	const session = filterJournal(segments, input.content, () => true);
	const files = new Map<string, Buffer>([["calls.jsonl", session.bytes]]);
	const listed: BundleFile[] = [];
	const headers = [...session.headers];
	const refs = new Map<string, string>();
	const runs = new Set<string>();
	let forkedFrom: BundleManifest["source"]["forkedFrom"] = null;
	const excluded: BundleManifest["excluded"] = {
		contentBearing: session.contentBearing,
		unclassified: session.unclassified,
		tornTailBytes: session.tornTailBytes,
		missingRuns: [],
		missingObjects: [],
	};
	for (const record of session.parsed) {
		collectRefs(record.data, refs);
		const data = record.data as Record<string, unknown> | undefined;
		if ((record.k === "call.ref" || record.k === "run.ref") && typeof data?.runId === "string") runs.add(data.runId);
		if (record.k === "session.forked_from" && typeof data?.parentSessionId === "string")
			forkedFrom = { parentSessionId: data.parentSessionId, parentTurnId: String(data.parentTurnId) };
	}
	listed.push({
		path: "calls.jsonl",
		sha256: sha256(session.bytes),
		bytes: session.bytes.length,
		records: session.records,
	});
	for (const runId of [...runs].sort()) {
		const runSegments = SAFE_ID.test(runId)
			? await readSegments(join(input.stateDir, "runs", runId), "events.ndjson")
			: null;
		if (runSegments === null || runSegments.length === 0) {
			excluded.missingRuns.push(runId);
			continue;
		}
		// A run directory belongs to its run; only this session's view of that run is exported (#434).
		const run = filterJournal(runSegments, input.content, (record) => {
			const ctx = record.ctx as Record<string, unknown> | undefined;
			return ctx?.runId === runId && ctx.sessionId === input.sessionId;
		});
		excluded.contentBearing += run.contentBearing;
		excluded.unclassified += run.unclassified;
		excluded.tornTailBytes += run.tornTailBytes;
		headers.push(...run.headers);
		for (const record of run.parsed) collectRefs(record.data, refs);
		const path = `runs/${runId}/events.ndjson`;
		files.set(path, run.bytes);
		listed.push({ path, sha256: sha256(run.bytes), bytes: run.bytes.length, records: run.records });
	}
	for (const [id, subject] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
		if (CONTENT_SUBJECTS.has(subject) && !input.content) continue;
		let bytes: Buffer;
		try {
			bytes = await readRegular(join(directory, "objects", `${id}.json`));
		} catch {
			excluded.missingObjects.push(id);
			continue;
		}
		if (`obj_${sha256(bytes)}` !== id) throw new Error(`object ${id} does not match its digest`);
		const path = `objects/${id}.json`;
		files.set(path, bytes);
		listed.push({ path, sha256: sha256(bytes), bytes: bytes.length, records: 1 });
	}
	let ledgerIncluded = false;
	if (input.content) {
		try {
			const ledger = await readRegular(join(directory, "current.jsonl"));
			const complete = ledger.subarray(0, ledger.lastIndexOf(0x0a) + 1);
			excluded.tornTailBytes += ledger.length - complete.length;
			files.set("current.jsonl", complete);
			const lines = complete
				.toString("utf8")
				.split("\n")
				.filter((line) => line.length > 0).length;
			listed.push({ path: "current.jsonl", sha256: sha256(complete), bytes: complete.length, records: lines });
			ledgerIncluded = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	const contentIncluded = ledgerIncluded || headers.some((header) => header.capture.content);
	const manifest: BundleManifest = {
		format: BUNDLE_FORMAT,
		createdAt: new Date().toISOString(),
		writer: input.writer,
		source: { sessionId: input.sessionId, cwdHash: input.cwdHash, forkedFrom, runs: [...runs].sort() },
		ceiling: ceilingOf(headers, input.content && contentIncluded),
		excluded,
		files: listed,
	};
	await publish(input.out, files, manifest);
	return manifest;
}

export interface BundleImport {
	manifest: BundleManifest;
	records: number;
	calls: number;
	runs: number;
	objects: number;
	/** Records this version cannot read, kept verbatim and counted (R12). */
	unreadable: number;
}

function isPath(path: unknown): path is string {
	if (typeof path !== "string") return false;
	if (path === "calls.jsonl" || path === "current.jsonl") return true;
	const run = /^runs\/([a-zA-Z0-9_-]+)\/events\.ndjson$/.exec(path);
	return run !== null || /^objects\/obj_[0-9a-f]{64}\.json$/.test(path);
}

function readManifest(value: unknown): BundleManifest {
	const manifest = value as BundleManifest;
	if (!manifest || typeof manifest !== "object" || manifest.format !== BUNDLE_FORMAT)
		throw new Error(`bundle.json is not ${BUNDLE_FORMAT}`);
	if (!Array.isArray(manifest.files) || !manifest.files.some((file) => file.path === "calls.jsonl"))
		throw new Error("bundle.json lists no calls.jsonl");
	const seen = new Set<string>();
	for (const file of manifest.files) {
		if (!isPath(file?.path) || seen.has(file.path))
			throw new Error(`bundle.json lists an invalid path: ${String(file?.path)}`);
		if (!/^[0-9a-f]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || !Number.isSafeInteger(file.records))
			throw new Error(`bundle.json has an invalid entry for ${file.path}`);
		seen.add(file.path);
	}
	if (!manifest.ceiling || (manifest.ceiling.mode !== "standard" && manifest.ceiling.mode !== "research"))
		throw new Error("bundle.json has no capture ceiling");
	return manifest;
}

/**
 * Verify a bundle completely, then write the verified files under `out` (#434). Nothing is
 * repaired: a hash, count, checksum, schema or ceiling mismatch refuses the import.
 */
export async function importTelemetryBundle(source: string, out: string): Promise<BundleImport> {
	await refuseExisting(out);
	const manifest = readManifest(JSON.parse((await readRegular(join(source, "bundle.json"))).toString("utf8")));
	const content = manifest.ceiling.capture.content;
	const files = new Map<string, Buffer>();
	const refs = new Map<string, string>();
	const result: BundleImport = { manifest, records: 0, calls: 0, runs: 0, objects: 0, unreadable: 0 };
	for (const file of manifest.files) {
		const bytes = await readRegular(join(source, file.path));
		if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
			throw new Error(`${file.path} does not match its sha256 or size`);
		files.set(file.path, bytes);
		if (file.path === "current.jsonl") {
			if (!content) throw new Error("a bundle without content capture carries a ledger");
			continue;
		}
		if (file.path.startsWith("objects/")) {
			if (`obj_${sha256(bytes)}` !== file.path.slice("objects/".length, -".json".length))
				throw new Error(`${file.path} does not match its digest`);
			result.objects += 1;
			continue;
		}
		const scan = scanTelemetrySegment(bytes);
		if (scan.corruptOffset !== null || scan.tornTailBytes > 0) throw new Error(`${file.path} is damaged`);
		const rows = scan.rows.filter((row) => row.kind !== "header" && !(row.kind === "skipped" && row.segment));
		if (rows.length !== file.records) throw new Error(`${file.path} holds ${rows.length} records, not ${file.records}`);
		if (scan.rows[0]?.kind !== "header") throw new Error(`${file.path} does not open with a segment header`);
		for (const row of scan.rows) {
			if (row.kind === "header") {
				if (row.header.mode === "research" && manifest.ceiling.mode !== "research")
					throw new Error(`${file.path} has a research segment above the bundle's ceiling`);
				continue;
			}
			if (row.kind === "skipped") {
				result.unreadable += 1;
				continue;
			}
			if (row.record.cc === "content-bearing" && !content)
				throw new Error(`${file.path} carries content above the bundle's ceiling`);
			if (row.record.tier === "research" && manifest.ceiling.mode !== "research")
				throw new Error(`${file.path} carries research records above the bundle's ceiling`);
			if (row.record.k === "call.settled") result.calls += 1;
			collectRefs(row.record.data, refs);
			result.records += 1;
		}
		if (file.path.startsWith("runs/")) result.runs += 1;
	}
	for (const path of files.keys()) {
		if (!path.startsWith("objects/")) continue;
		const id = path.slice("objects/".length, -".json".length);
		const subject = refs.get(id);
		if (subject === undefined) throw new Error(`${path} is not referenced by any record`);
		if (CONTENT_SUBJECTS.has(subject) && !content) throw new Error(`${path} is content above the bundle's ceiling`);
	}
	for (const id of refs.keys())
		if (!files.has(`objects/${id}.json`) && !manifest.excluded?.missingObjects?.includes(id)) {
			const subject = refs.get(id) ?? "";
			if (content || !CONTENT_SUBJECTS.has(subject)) throw new Error(`object ${id} is referenced but missing`);
		}
	await publish(out, files, manifest);
	return result;
}
