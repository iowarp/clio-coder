import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { SegmentHeader } from "../../core/telemetry/envelope.js";
import type { ScopeSealed } from "../../core/telemetry/schemas.js";
import { ScopeSealedSchema } from "../../core/telemetry/schemas.js";
import type { TelemetryChain } from "../../core/telemetry/segment.js";
import {
	chainTelemetryLine,
	EMPTY_TELEMETRY_CHAIN,
	scanTelemetrySegment,
	telemetryChainHead,
} from "../../core/telemetry/segment.js";
import {
	TELEMETRY_BUNDLE_FILE,
	TELEMETRY_JOURNAL_FILE,
	telemetryJournalFiles,
	telemetryObjectsDirectory,
} from "./paths.js";

/**
 * Seals and sealed scope bundles (#434). Closing a scope appends a `<kind>.sealed` record over the journal's hash
 * chain and writes `bundle.json` beside it, so a sealed scope directory is self-describing and verifies on any machine
 * from its own files. A writer that appends to a sealed scope removes `bundle.json` first: a live scope has none.
 */

export const SCOPE_BUNDLE_FORMAT = "clio-coder.telemetry.bundle";
export type TelemetryScopeKind = "session" | "run" | "process";
export const SEAL_EVENTS = {
	session: "session.sealed",
	run: "run.sealed",
	process: "process.sealed",
} as const satisfies Record<TelemetryScopeKind, string>;

const sha256Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });
const closed = { additionalProperties: false };
export const ScopeBundleManifestSchema = Type.Object(
	{
		format: Type.Literal(SCOPE_BUNDLE_FORMAT),
		version: Type.Literal(1),
		scope: Type.Object(
			{ kind: Type.Union([Type.Literal("session"), Type.Literal("run"), Type.Literal("process")]), id: Type.String() },
			closed,
		),
		sealedAt: Type.String(),
		clioCoderVersion: Type.String(),
		host: Type.String(),
		segments: ScopeSealedSchema.properties.segments,
		objects: ScopeSealedSchema.properties.objects,
		/** `head` is the chain head after the seal line, so it commits to the seal itself. */
		seal: Type.Object({ recordId: Type.String(), head: sha256Hex }, closed),
	},
	closed,
);
export type ScopeBundleManifest = Static<typeof ScopeBundleManifestSchema>;
export type ScopeFileEntry = ScopeSealed["segments"][number];
export type ScopeObjectEntry = ScopeSealed["objects"][number];

const OBJECT_FILE = /^(obj_[0-9a-f]{64})\.json$/u;

export function telemetryScopeOf(context: TelemetryContext): { kind: TelemetryScopeKind; id: string } {
	if ("processId" in context) return { kind: "process", id: context.processId };
	if (context.runId !== undefined) return { kind: "run", id: context.runId };
	if (context.sessionId === null) throw new Error("telemetry scope requires a session, run or process owner");
	return { kind: "session", id: context.sessionId };
}

export function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		if (!(await handle.stat()).isFile()) throw new Error(`${path} is not a regular file`);
		return await handle.readFile();
	} finally {
		await handle.close();
	}
}

async function objectFileNames(scopeDirectory: string): Promise<string[]> {
	try {
		return (await readdir(telemetryObjectsDirectory(scopeDirectory))).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** Every object the scope holds, as a seal lists them; a file that is not an object is not listed. */
export async function listScopeObjects(scopeDirectory: string): Promise<ScopeObjectEntry[]> {
	const entries: ScopeObjectEntry[] = [];
	for (const name of await objectFileNames(scopeDirectory)) {
		const id = OBJECT_FILE.exec(name)?.[1];
		if (id === undefined) continue;
		const bytes = await readRegularFile(join(telemetryObjectsDirectory(scopeDirectory), name));
		entries.push({ id, sha256: sha256Of(bytes), bytes: bytes.length });
	}
	return entries;
}

export function scopeBundleManifest(input: {
	scope: { kind: TelemetryScopeKind; id: string };
	sealedAt: string;
	writer: SegmentHeader["writer"];
	host: string;
	segments: ScopeFileEntry[];
	objects: ScopeObjectEntry[];
	seal: { recordId: string; head: string };
}): ScopeBundleManifest {
	return {
		format: SCOPE_BUNDLE_FORMAT,
		version: 1,
		scope: input.scope,
		sealedAt: input.sealedAt,
		clioCoderVersion: input.writer.clioCoderVersion,
		host: input.host,
		segments: input.segments,
		objects: input.objects,
		seal: input.seal,
	};
}

/** A scope directory's files as verification reads them; every name is relative to the scope directory. */
export interface TelemetryScopeFiles {
	/** `bundle.json`, or null when the scope has none. */
	manifest: Buffer | null;
	/** Journal segments, oldest first, the live segment last. */
	segments: Array<{ name: string; bytes: Buffer }>;
	/** Every file under `objects/`, by file name. */
	objects: Array<{ name: string; bytes: Buffer }>;
}

/** Read a scope directory for verification; it never writes or repairs. Throws when the path is not a directory. */
export async function readTelemetryScopeFiles(scopeDirectory: string): Promise<TelemetryScopeFiles> {
	const stat = await lstat(scopeDirectory);
	if (!stat.isDirectory()) throw new Error(`${scopeDirectory} is not a directory`);
	const names = await readdir(scopeDirectory);
	let manifest: Buffer | null = null;
	if (names.includes(TELEMETRY_BUNDLE_FILE))
		manifest = await readRegularFile(join(scopeDirectory, TELEMETRY_BUNDLE_FILE));
	const segments = [];
	for (const name of telemetryJournalFiles(names))
		segments.push({ name, bytes: await readRegularFile(join(scopeDirectory, name)) });
	const objects = [];
	for (const name of await objectFileNames(scopeDirectory))
		objects.push({ name, bytes: await readRegularFile(join(telemetryObjectsDirectory(scopeDirectory), name)) });
	return { manifest, segments, objects };
}

export type SealMismatch =
	| { kind: "manifest"; detail: string }
	| { kind: "segment"; name: string; detail: string }
	| { kind: "object"; name: string; detail: string }
	| { kind: "chain"; name: string; line: number; detail: string }
	| { kind: "seal"; detail: string };

export type SealVerdict =
	| {
			status: "verified";
			scope: { kind: TelemetryScopeKind; id: string };
			sealedAt: string;
			seal: { recordId: string; head: string };
			records: number;
			segments: number;
			objects: number;
	  }
	| { status: "unsealed"; reason: "no-bundle" | "no-journal" }
	| { status: "failed"; mismatch: SealMismatch };

function failed(mismatch: SealMismatch): SealVerdict {
	return { status: "failed", mismatch };
}

function fileMismatch(
	listed: ReadonlyArray<{ name: string; sha256: string; bytes: number }>,
	present: ReadonlyArray<{ name: string; bytes: Buffer }>,
): { name: string; detail: string } | null {
	const byName = new Map(present.map((file) => [file.name, file.bytes]));
	const seen = new Set<string>();
	for (const entry of listed) {
		if (seen.has(entry.name)) return { name: entry.name, detail: "listed twice" };
		seen.add(entry.name);
		const bytes = byName.get(entry.name);
		if (bytes === undefined) return { name: entry.name, detail: "missing" };
		if (bytes.length !== entry.bytes) return { name: entry.name, detail: `size ${bytes.length}, sealed ${entry.bytes}` };
		if (sha256Of(bytes) !== entry.sha256) return { name: entry.name, detail: "sha256 differs from the seal" };
	}
	for (const file of present) if (!seen.has(file.name)) return { name: file.name, detail: "not listed in the bundle" };
	return null;
}

function sameEntries<T>(left: readonly T[], right: readonly T[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The seal verdict for a scope's files (#434). Pure: it checks every listed segment and object against its size and
 * sha256, recomputes the chain from the first segment header, and compares the seal record's head, line count and
 * file lists. The first mismatch fails the scope; a scope without `bundle.json` is unsealed.
 */
export function verifyTelemetryScope(files: TelemetryScopeFiles): SealVerdict {
	if (files.manifest === null)
		return { status: "unsealed", reason: files.segments.length === 0 ? "no-journal" : "no-bundle" };
	let manifest: ScopeBundleManifest;
	try {
		const parsed: unknown = JSON.parse(files.manifest.toString("utf8"));
		if (!Value.Check(ScopeBundleManifestSchema, parsed))
			return failed({ kind: "manifest", detail: "bundle.json is not a version 1 scope bundle" });
		manifest = parsed;
	} catch {
		return failed({ kind: "manifest", detail: "bundle.json is not JSON" });
	}
	const segmentFiles = fileMismatch(manifest.segments, files.segments);
	if (segmentFiles) return failed({ kind: "segment", ...segmentFiles });
	const objectFiles = fileMismatch(
		manifest.objects.map(({ id, sha256, bytes }) => ({ name: `${id}.json`, sha256, bytes })),
		files.objects,
	);
	if (objectFiles) return failed({ kind: "object", ...objectFiles });
	const order = files.segments.map(({ name }) => name);
	if (
		!sameEntries(
			order,
			manifest.segments.map(({ name }) => name),
		)
	)
		return failed({ kind: "manifest", detail: "segments are not listed oldest first" });

	const sealKind = SEAL_EVENTS[manifest.scope.kind];
	let chain: TelemetryChain = EMPTY_TELEMETRY_CHAIN;
	let sealed: { segment: number } | null = null;
	for (const [index, segment] of files.segments.entries()) {
		const scan = scanTelemetrySegment(segment.bytes);
		if (scan.corruptOffset !== null || scan.tornTailBytes > 0 || scan.validBytes !== segment.bytes.length)
			return failed({
				kind: "chain",
				name: segment.name,
				line: scan.rows.length + 1,
				detail: "segment has a damaged line",
			});
		let offset = 0;
		for (const [line, row] of scan.rows.entries()) {
			const end = segment.bytes.indexOf(0x0a, offset);
			const bytes = segment.bytes.subarray(offset, end);
			const at = { name: segment.name, line: line + 1 };
			if (sealed !== null) return failed({ kind: "chain", ...at, detail: "lines follow the seal" });
			if (line === 0) {
				if (row.kind !== "header") return failed({ kind: "chain", ...at, detail: "segment does not open with a header" });
				const expected = index === 0 ? undefined : telemetryChainHead(chain);
				if (row.header.chainHead !== expected)
					return failed({
						kind: "chain",
						...at,
						detail: index === 0 ? "first segment claims a prior chain" : "segment does not continue the chain",
					});
			} else if (
				row.kind === "header" &&
				row.header.chainHead !== undefined &&
				row.header.chainHead !== telemetryChainHead(chain)
			)
				return failed({ kind: "chain", ...at, detail: "header chain head differs from the chain" });
			if (row.kind === "record" && row.record.id === manifest.seal.recordId) {
				const record = row.record;
				if (record.k !== sealKind) return failed({ kind: "seal", detail: `seal record is ${record.k}, not ${sealKind}` });
				const ctx = record.ctx;
				const owner =
					"processId" in ctx ? ctx.processId : manifest.scope.kind === "run" ? ctx.runId : (ctx.sessionId ?? undefined);
				if (owner !== manifest.scope.id) return failed({ kind: "seal", detail: "seal record names another scope" });
				const data = record.data as ScopeSealed;
				if (data.head !== telemetryChainHead(chain))
					return failed({ kind: "seal", detail: "seal head differs from the recomputed chain" });
				if (data.records !== chain.lines)
					return failed({ kind: "seal", detail: `seal covers ${data.records} lines, chain has ${chain.lines}` });
				const expectedSegments = [
					...manifest.segments.slice(0, index),
					{ name: segment.name, sha256: sha256Of(segment.bytes.subarray(0, offset)), bytes: offset },
				];
				if (!sameEntries(data.segments, expectedSegments))
					return failed({ kind: "seal", detail: "seal segment list differs from the files" });
				if (!sameEntries(data.objects, manifest.objects))
					return failed({ kind: "seal", detail: "seal object list differs from the bundle" });
				sealed = { segment: index };
			}
			chain = chainTelemetryLine(chain, bytes);
			offset = end + 1;
		}
	}
	if (sealed === null) return failed({ kind: "seal", detail: `seal record ${manifest.seal.recordId} not found` });
	if (sealed.segment !== files.segments.length - 1 || files.segments.at(-1)?.name !== TELEMETRY_JOURNAL_FILE)
		return failed({ kind: "seal", detail: "seal is not in the live segment" });
	if (telemetryChainHead(chain) !== manifest.seal.head)
		return failed({ kind: "seal", detail: "bundle head differs from the chain after the seal" });
	return {
		status: "verified",
		scope: manifest.scope,
		sealedAt: manifest.sealedAt,
		seal: manifest.seal,
		records: chain.lines,
		segments: files.segments.length,
		objects: files.objects.length,
	};
}
