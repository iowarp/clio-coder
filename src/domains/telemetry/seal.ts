import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readRegularFile, readRegularFileSync } from "../../core/state-boundary.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import type {
	TelemetryScopeKind as ScopeKindSchema,
	SealMismatchSchema,
	SealVerdictSchema,
} from "../../core/telemetry/dto.js";
import type { SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { ScopeSealed } from "../../core/telemetry/schemas.js";
import { ScopeSealedSchema, ShareProfileSchema } from "../../core/telemetry/schemas.js";
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
export type TelemetryScopeKind = Static<typeof ScopeKindSchema>;
export const SEAL_EVENTS = {
	session: "session.sealed",
	run: "run.sealed",
	process: "process.sealed",
} as const satisfies Record<TelemetryScopeKind, string>;
/** The seal a share archive's filtered scope carries in place of its own (#434). */
export const SHARE_SEAL_EVENT = "share.sealed";

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
		/** Present on a scope `telemetry share` filtered: its seal is `share.sealed` under this profile (#434). */
		share: Type.Optional(Type.Object({ profile: ShareProfileSchema }, closed)),
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

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** A scope's objects directory is part of the scope; one that is a symlink is refused, never followed (#434). */
async function objectFileNames(scopeDirectory: string): Promise<string[]> {
	const directory = telemetryObjectsDirectory(scopeDirectory);
	try {
		if (!(await lstat(directory)).isDirectory()) throw new Error(`${directory} is not a directory`);
		return (await readdir(directory)).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function objectFileNamesSync(scopeDirectory: string): string[] {
	const directory = telemetryObjectsDirectory(scopeDirectory);
	try {
		if (!lstatSync(directory).isDirectory()) throw new Error(`${directory} is not a directory`);
		return readdirSync(directory).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

/** The temp file `safeResourceWriteAsync` writes an object through before its rename. */
const INTERRUPTED_OBJECT_WRITE = /^\.obj_[0-9a-f]{64}\.json\.tmp-/u;

/**
 * Remove object writes a stopped process left before their rename. Only a caller holding the scope's writer lock may
 * call this, since any other writer's temp files would be live (#434).
 */
export async function removeInterruptedObjectWrites(scopeDirectory: string): Promise<void> {
	for (const name of await objectFileNames(scopeDirectory))
		if (INTERRUPTED_OBJECT_WRITE.test(name))
			await rm(join(telemetryObjectsDirectory(scopeDirectory), name), { force: true });
}

/** Every object the scope holds, as a seal lists them; a file that is not an object is not listed. */
export async function listScopeObjects(scopeDirectory: string): Promise<ScopeObjectEntry[]> {
	const entries: ScopeObjectEntry[] = [];
	for (const name of await objectFileNames(scopeDirectory)) {
		const id = OBJECT_FILE.exec(name)?.[1];
		if (id === undefined) continue;
		const bytes = await readRegularFile(join(telemetryObjectsDirectory(scopeDirectory), name));
		const sha256 = sha256Of(bytes);
		// Objects are content-addressed; a seal never blesses bytes that are not the preimage their id names (#434).
		if (sha256 !== id.slice(4)) throw new Error(`telemetry object ${id} does not match its id`);
		entries.push({ id, sha256, bytes: bytes.length });
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
	share?: ScopeBundleManifest["share"];
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
		...(input.share !== undefined ? { share: input.share } : {}),
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

/** The synchronous {@link readTelemetryScopeFiles}, for the CLI and the synchronous run DTO readers (#434). */
export function readTelemetryScopeFilesSync(scopeDirectory: string): TelemetryScopeFiles {
	if (!lstatSync(scopeDirectory).isDirectory()) throw new Error(`${scopeDirectory} is not a directory`);
	const names = readdirSync(scopeDirectory);
	const manifest = names.includes(TELEMETRY_BUNDLE_FILE)
		? readRegularFileSync(join(scopeDirectory, TELEMETRY_BUNDLE_FILE))
		: null;
	const segments = telemetryJournalFiles(names).map((name) => ({
		name,
		bytes: readRegularFileSync(join(scopeDirectory, name)),
	}));
	const objects = objectFileNamesSync(scopeDirectory).map((name) => ({
		name,
		bytes: readRegularFileSync(join(telemetryObjectsDirectory(scopeDirectory), name)),
	}));
	return { manifest, segments, objects };
}

export type SealMismatch = Static<typeof SealMismatchSchema>;
export type SealVerdict = Static<typeof SealVerdictSchema>;

/** One seal the chain holds, with the chain and the segment header it was written under. */
export interface ChainSeal {
	record: TelemetryRecord;
	/** Index of the segment holding the seal line. */
	segment: number;
	header: SegmentHeader;
	/** Chain head after the seal line. */
	headAfter: string;
}

export interface ChainWalk {
	chain: TelemetryChain;
	/** Every seal in chain order; each was checked against the prefix it covers. */
	seals: ChainSeal[];
	/** Whether the chain's last line is a seal. */
	tipIsSeal: boolean;
	/** Each walked segment's name, sha256 and size. */
	segments: ScopeFileEntry[];
}

const SEAL_KINDS: ReadonlySet<string> = new Set([...Object.values(SEAL_EVENTS), SHARE_SEAL_EVENT]);

function sealOwner(record: TelemetryRecord, kind: TelemetryScopeKind): string | undefined {
	const ctx = record.ctx;
	if ("processId" in ctx) return kind === "process" ? ctx.processId : undefined;
	return kind === "run" ? ctx.runId : kind === "session" ? (ctx.sessionId ?? undefined) : undefined;
}

function sameEntries<T>(left: readonly T[], right: readonly T[]): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Replay a scope's chain over its segments, oldest first, and check every seal it holds against the prefix that seal
 * covers: its head, its line count, the segments before it and its own segment's bytes before the seal line (#434).
 * An earlier seal stays a commitment to the history before it, so a resealed scope cannot launder an edit. `scope`
 * also binds each seal to the scope, and to `sealEvent` when given, else to the scope's own seal event; `objects` checks
 * each seal's object list against the current objects.
 */
export function walkTelemetryChain(
	files: ReadonlyArray<{ name: string; bytes: Buffer }>,
	check: {
		scope?: { kind: TelemetryScopeKind; id: string };
		sealEvent?: string;
		objects?: ReadonlyMap<string, ScopeObjectEntry>;
	} = {},
): ChainWalk | { mismatch: SealMismatch } {
	let chain: TelemetryChain = EMPTY_TELEMETRY_CHAIN;
	const seals: ChainSeal[] = [];
	const segments: ScopeFileEntry[] = files.map(({ name, bytes }) => ({
		name,
		sha256: sha256Of(bytes),
		bytes: bytes.length,
	}));
	let tipIsSeal = false;
	for (const [index, segment] of files.entries()) {
		const scan = scanTelemetrySegment(segment.bytes);
		if (scan.corruptOffset !== null || scan.tornTailBytes > 0 || scan.validBytes !== segment.bytes.length)
			return {
				mismatch: { kind: "chain", name: segment.name, line: scan.rows.length + 1, detail: "segment has a damaged line" },
			};
		let offset = 0;
		let header: SegmentHeader | undefined;
		for (const [line, row] of scan.rows.entries()) {
			const end = segment.bytes.indexOf(0x0a, offset);
			const at = { kind: "chain" as const, name: segment.name, line: line + 1 };
			if (line === 0) {
				if (row.kind !== "header") return { mismatch: { ...at, detail: "segment does not open with a header" } };
				const expected = index === 0 ? undefined : telemetryChainHead(chain);
				if (row.header.chainHead !== expected)
					return {
						mismatch: {
							...at,
							detail: index === 0 ? "first segment claims a prior chain" : "segment does not continue the chain",
						},
					};
			} else if (
				row.kind === "header" &&
				row.header.chainHead !== undefined &&
				row.header.chainHead !== telemetryChainHead(chain)
			)
				return { mismatch: { ...at, detail: "header chain head differs from the chain" } };
			if (row.kind === "header") header = row.header;
			const sealRow = row.kind === "record" && SEAL_KINDS.has(row.record.k) ? row.record : null;
			if (sealRow) {
				const data = sealRow.data as ScopeSealed;
				const label = `seal ${sealRow.id}`;
				if (check.scope) {
					const expected = check.sealEvent ?? SEAL_EVENTS[check.scope.kind];
					if (sealRow.k !== expected)
						return { mismatch: { kind: "seal", detail: `${label} is ${sealRow.k}, not ${expected}` } };
					if (sealOwner(sealRow, check.scope.kind) !== check.scope.id)
						return { mismatch: { kind: "seal", detail: `${label} names another scope` } };
				}
				if (data.head !== telemetryChainHead(chain))
					return { mismatch: { kind: "seal", detail: `${label} head differs from the recomputed chain` } };
				if (data.records !== chain.lines)
					return { mismatch: { kind: "seal", detail: `${label} covers ${data.records} lines, chain has ${chain.lines}` } };
				const expected = [
					...segments.slice(0, index),
					{ name: TELEMETRY_JOURNAL_FILE, sha256: sha256Of(segment.bytes.subarray(0, offset)), bytes: offset },
				];
				if (!sameEntries(data.segments, expected))
					return { mismatch: { kind: "seal", detail: `${label} segment list differs from the files` } };
				for (const object of data.objects) {
					if (object.sha256 !== object.id.slice(4))
						return { mismatch: { kind: "object", name: `${object.id}.json`, detail: "sealed sha256 does not match its id" } };
					const present = check.objects?.get(object.id);
					if (check.objects && (present?.sha256 !== object.sha256 || present.bytes !== object.bytes))
						return { mismatch: { kind: "seal", detail: `${label} lists ${object.id}, which the bundle does not hold` } };
				}
				if (!header) return { mismatch: { ...at, detail: "seal precedes any header" } };
			}
			chain = chainTelemetryLine(chain, segment.bytes.subarray(offset, end));
			if (sealRow && header)
				seals.push({ record: sealRow, segment: index, header, headAfter: telemetryChainHead(chain) as string });
			tipIsSeal = sealRow !== null;
			offset = end + 1;
		}
	}
	return { chain, seals, tipIsSeal, segments };
}

/** One line naming a mismatch, for diagnostics and the CLI. */
export function describeSealMismatch(mismatch: SealMismatch): string {
	switch (mismatch.kind) {
		case "manifest":
		case "seal":
			return `${mismatch.kind}: ${mismatch.detail}`;
		case "segment":
		case "object":
			return `${mismatch.kind} ${mismatch.name}: ${mismatch.detail}`;
		case "chain":
			return `chain at ${mismatch.name} line ${mismatch.line}: ${mismatch.detail}`;
	}
}

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

/**
 * The seal verdict for a scope's files (#434). Pure: it checks every listed segment and object against its size and
 * sha256 and every object against its content-addressed id, replays the chain checking every seal against its prefix,
 * and binds the manifest to the last seal: its record, head, file lists, timestamp, host and writer version. The first
 * mismatch fails the scope; a scope without `bundle.json` is unsealed.
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
	for (const object of manifest.objects)
		if (object.sha256 !== object.id.slice(4))
			return failed({ kind: "object", name: `${object.id}.json`, detail: "sealed sha256 does not match its id" });
	const objectFiles = fileMismatch(
		manifest.objects.map(({ id, sha256, bytes }) => ({ name: `${id}.json`, sha256, bytes })),
		files.objects,
	);
	if (objectFiles) return failed({ kind: "object", ...objectFiles });
	if (
		!sameEntries(
			files.segments.map(({ name }) => name),
			manifest.segments.map(({ name }) => name),
		)
	)
		return failed({ kind: "manifest", detail: "segments are not listed oldest first" });
	const walk = walkTelemetryChain(files.segments, {
		scope: manifest.scope,
		...(manifest.share !== undefined ? { sealEvent: SHARE_SEAL_EVENT } : {}),
		objects: new Map(manifest.objects.map((object) => [object.id, object])),
	});
	if ("mismatch" in walk) return failed(walk.mismatch);
	const last = walk.seals.at(-1);
	if (!last) return failed({ kind: "seal", detail: `seal record ${manifest.seal.recordId} not found` });
	if (last.record.id !== manifest.seal.recordId)
		return failed({ kind: "seal", detail: `bundle names ${manifest.seal.recordId}, the last seal is ${last.record.id}` });
	if (!walk.tipIsSeal) return failed({ kind: "seal", detail: "lines follow the seal" });
	if (last.segment !== files.segments.length - 1 || files.segments.at(-1)?.name !== TELEMETRY_JOURNAL_FILE)
		return failed({ kind: "seal", detail: "seal is not in the live segment" });
	if (!sameEntries((last.record.data as ScopeSealed).objects, manifest.objects))
		return failed({ kind: "seal", detail: "seal object list differs from the bundle" });
	if (manifest.share !== undefined && (last.record.data as { profile?: unknown }).profile !== manifest.share.profile)
		return failed({ kind: "seal", detail: "share profile differs from the seal" });
	if (last.headAfter !== manifest.seal.head)
		return failed({ kind: "seal", detail: "bundle head differs from the chain after the seal" });
	// The manifest's provenance is a copy of what the chain committed; a copy that disagrees is forged (#434).
	if (manifest.sealedAt !== last.record.t)
		return failed({ kind: "manifest", detail: "sealedAt differs from the seal record" });
	if (manifest.host !== last.header.clockOrigin.host)
		return failed({ kind: "manifest", detail: "host differs from the segment that holds the seal" });
	if (manifest.clioCoderVersion !== last.header.writer.clioCoderVersion)
		return failed({ kind: "manifest", detail: "clioCoderVersion differs from the segment that holds the seal" });
	return {
		status: "verified",
		scope: manifest.scope,
		sealedAt: manifest.sealedAt,
		seal: manifest.seal,
		records: walk.chain.lines,
		segments: files.segments.length,
		objects: files.objects.length,
	};
}
