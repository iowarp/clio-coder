import { createHash, randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { cwdHash } from "../../core/cwd-hash.js";
import { safeResourceWrite, safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import type { ContentClass, Tier } from "../../core/telemetry/enums.js";
import type { SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../core/telemetry/envelope.js";
import { ShareProfileSchema } from "../../core/telemetry/schemas.js";
import type { TelemetryChain } from "../../core/telemetry/segment.js";
import {
	chainTelemetryLine,
	EMPTY_TELEMETRY_CHAIN,
	encodeTelemetryLine,
	scanTelemetrySegment,
	telemetryChainHead,
} from "../../core/telemetry/segment.js";
import { createRedactionTally, redactSecretsDeep } from "../evidence/redact.js";
import { canonicalJson } from "../prompts/hash.js";
import { CONTENT_SUBJECTS, collectRefs } from "./objects.js";
import {
	isTelemetryJournalFile,
	TELEMETRY_BUNDLE_FILE,
	TELEMETRY_INSTALL_ID,
	TELEMETRY_JOURNAL_FILE,
	telemetryImportedStateDir,
	telemetryInstallPath,
	telemetryRunDirectory,
	telemetryRunsDirectory,
	telemetrySessionDirectory,
	telemetrySessionsDirectory,
} from "./paths.js";
import type { ScopeBundleManifest, ScopeObjectEntry, SealVerdict, TelemetryScopeFiles } from "./seal.js";
import {
	describeSealMismatch,
	readTelemetryScopeFiles,
	readTelemetryScopeFilesSync,
	SEAL_EVENTS,
	SHARE_SEAL_EVENT,
	scopeBundleManifest,
	verifyTelemetryScope,
} from "./seal.js";
import type { ShareArchiveEntry } from "./share-archive.js";
import { packTelemetryArchive, unpackTelemetryArchive } from "./share-archive.js";

/**
 * `telemetry share` and `telemetry import` (#434). A share filters sealed scope bundles through a named profile,
 * re-applies secret redaction to every record and object it keeps, reseals each filtered scope with `share.sealed` over
 * exactly the bytes it carries, and packs them into one tar.gz with a manifest naming the profile, the source's random
 * install id and the Clio version. Nothing is uploaded. An import verifies every bundle and places it under
 * `<stateDir>/telemetry/imported/<installId>/`, apart from the operator's own telemetry.
 */

export type ShareProfile = Static<typeof ShareProfileSchema>;
export type ShareScopeKind = "session" | "run";

export interface ShareProfileDefinition {
	/** One line for the profile picker and the preview. */
	summary: string;
	tiers: ReadonlyArray<Tier>;
	classes: ReadonlyArray<ContentClass>;
	/** `structure` keeps objects whose subject holds no content; `all` also keeps content objects. */
	objects: "none" | "structure" | "all";
}

/** The share presets, declared once. `research` applies only to scopes whose capture had consent (#434). */
export const SHARE_PROFILES: Readonly<Record<ShareProfile, ShareProfileDefinition>> = {
	"content-free": {
		summary: "accountability and operational records with structural payloads; no objects, no content",
		tiers: ["accountability", "operational"],
		classes: ["content-free", "structural"],
		objects: "none",
	},
	structural: {
		summary: "adds the objects that hold structure, such as prompt and tool-schema manifests",
		tiers: ["accountability", "operational"],
		classes: ["content-free", "structural"],
		objects: "structure",
	},
	research: {
		summary: "adds research records, content records and content objects, for scopes captured under consent",
		tiers: ["accountability", "operational", "research"],
		classes: ["content-free", "structural", "content-bearing"],
		objects: "all",
	},
};
export const SHARE_PROFILE_NAMES = Object.keys(SHARE_PROFILES) as ShareProfile[];
const PROFILE_RANK: Readonly<Record<ShareProfile, number>> = { "content-free": 0, structural: 1, research: 2 };

export function isShareProfile(value: string): value is ShareProfile {
	return Object.hasOwn(SHARE_PROFILES, value);
}

const SCOPE_DIRECTORY: Readonly<Record<ShareScopeKind, string>> = { session: "sessions", run: "runs" };
const SOURCE_SEALS: ReadonlySet<string> = new Set([...Object.values(SEAL_EVENTS), SHARE_SEAL_EVENT]);

function scopeDirectory(stateDir: string, kind: ShareScopeKind, id: string): string {
	return kind === "session" ? telemetrySessionDirectory(stateDir, id) : telemetryRunDirectory(stateDir, id);
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const InstallFileSchema = Type.Object(
	{
		format: Type.Literal("clio-coder.telemetry.install"),
		version: Type.Literal(1),
		installId: Type.String({ pattern: TELEMETRY_INSTALL_ID.source }),
	},
	{ additionalProperties: false },
);

/** This installation's random id, minted on first use. A share names its source by it, never by host or path (#434). */
export function telemetryInstallId(stateDir: string): string {
	const path = telemetryInstallPath(stateDir);
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (Value.Check(InstallFileSchema, parsed)) return parsed.installId;
		throw new Error(`${path} is not a version 1 install file`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const installId = `inst_${randomBytes(16).toString("hex")}`;
	const file: Static<typeof InstallFileSchema> = { format: "clio-coder.telemetry.install", version: 1, installId };
	safeResourceWrite(path, `${JSON.stringify(file, null, "\t")}\n`, { mode: 0o600 });
	return installId;
}

// ---------------------------------------------------------------------------------------------------------------
// Selection

export interface ShareSelection {
	sessions: ReadonlyArray<string>;
	runs: ReadonlyArray<string>;
	/** A repository path: every session its workspace bucket holds. */
	repo: string | null;
	/** ISO bounds on a scope's seal time; they filter repository and time-range candidates, never named scopes. */
	since: string | null;
	until: string | null;
}

export interface ShareScopeSource {
	kind: ShareScopeKind;
	id: string;
	sealedAt: string;
	files: TelemetryScopeFiles;
}

export interface ShareSkip {
	kind: ShareScopeKind;
	id: string;
	reason: string;
}

/** A scope offered to an interactive share: sealed scopes only, newest seal first. */
export interface ShareCandidate {
	kind: ShareScopeKind;
	id: string;
	sealedAt: string;
}

function listIds(directory: string): string[] {
	try {
		return readdirSync(directory).sort();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

function sealedAtOf(directory: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, TELEMETRY_BUNDLE_FILE), "utf8")) as { sealedAt?: unknown };
		return typeof parsed.sealedAt === "string" ? parsed.sealedAt : null;
	} catch {
		// No or unreadable bundle.json: the scope is live or damaged and is not offered.
		return null;
	}
}

/** Every sealed session and run scope, newest seal first, for the interactive picker. Verification comes later. */
export function listShareCandidates(stateDir: string): ShareCandidate[] {
	const candidates: ShareCandidate[] = [];
	for (const [kind, root] of [
		["session", telemetrySessionsDirectory(stateDir)],
		["run", telemetryRunsDirectory(stateDir)],
	] as const)
		for (const id of listIds(root)) {
			const sealedAt = sealedAtOf(join(root, id));
			if (sealedAt !== null) candidates.push({ kind, id, sealedAt });
		}
	return candidates.sort((a, b) => b.sealedAt.localeCompare(a.sealedAt));
}

function referencedRuns(files: TelemetryScopeFiles): string[] {
	const runs = new Set<string>();
	for (const segment of files.segments)
		for (const row of scanTelemetrySegment(segment.bytes).rows)
			if (row.kind === "record" && (row.record.k === "call.linked" || row.record.k === "run.linked"))
				runs.add((row.record.data as { runId: string }).runId);
	return [...runs].sort();
}

/**
 * The sealed, verified scopes a selection names, each once. A session brings the runs it references; a scope that is
 * live, missing or fails verification is skipped with its reason, never shared.
 */
export function resolveShareScopes(
	stateDir: string,
	selection: ShareSelection,
): { scopes: ShareScopeSource[]; skipped: ShareSkip[] } {
	const scopes: ShareScopeSource[] = [];
	const skipped: ShareSkip[] = [];
	const seen = new Set<string>();
	const since = selection.since === null ? Number.NEGATIVE_INFINITY : Date.parse(selection.since);
	const until = selection.until === null ? Number.POSITIVE_INFINITY : Date.parse(selection.until);
	const queue: Array<{ kind: ShareScopeKind; id: string; windowed: boolean }> = [
		...selection.sessions.map((id) => ({ kind: "session" as const, id, windowed: false })),
		...selection.runs.map((id) => ({ kind: "run" as const, id, windowed: false })),
	];
	if (selection.repo !== null)
		for (const id of listIds(join(stateDir, "sessions", cwdHash(selection.repo))))
			queue.push({ kind: "session", id, windowed: true });
	else if (queue.length === 0 && (selection.since !== null || selection.until !== null)) {
		for (const id of listIds(telemetrySessionsDirectory(stateDir))) queue.push({ kind: "session", id, windowed: true });
		for (const id of listIds(telemetryRunsDirectory(stateDir))) queue.push({ kind: "run", id, windowed: true });
	}
	for (let index = 0; index < queue.length; index += 1) {
		const { kind, id, windowed } = queue[index] as (typeof queue)[number];
		const key = `${kind}:${id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		let directory: string;
		try {
			directory = scopeDirectory(stateDir, kind, id);
		} catch (error) {
			skipped.push({ kind, id, reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
			// A repository bucket also lists sessions that never journaled; only named scopes are worth a note.
			if (!windowed) skipped.push({ kind, id, reason: "no telemetry scope" });
			continue;
		}
		let files: TelemetryScopeFiles;
		try {
			files = readTelemetryScopeFilesSync(directory);
		} catch (error) {
			skipped.push({ kind, id, reason: `unreadable: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		const verdict = verifyTelemetryScope(files);
		if (verdict.status === "unsealed") {
			skipped.push({ kind, id, reason: "not sealed (live or never sealed)" });
			continue;
		}
		if (verdict.status === "failed") {
			skipped.push({ kind, id, reason: `fails verification: ${describeSealMismatch(verdict.mismatch)}` });
			continue;
		}
		const at = Date.parse(verdict.sealedAt);
		if (windowed && !(at >= since && at <= until)) continue;
		scopes.push({ kind, id, sealedAt: verdict.sealedAt, files });
		if (kind === "session")
			for (const runId of referencedRuns(files)) queue.push({ kind: "run", id: runId, windowed: false });
	}
	return { scopes, skipped };
}

// ---------------------------------------------------------------------------------------------------------------
// Filtering and resealing

export interface ShareDropped {
	/** Records of a tier the profile leaves out. */
	tier: number;
	/** Records of a content class the profile leaves out. */
	contentClass: number;
	/** Lines this version cannot read; a share carries only what it understands. */
	unreadable: number;
	/** The source's own seals, which cover bytes the share no longer carries. */
	seals: number;
	/** Referenced objects the profile withholds. */
	objects: number;
	/** Referenced objects the scope does not hold. */
	missingObjects: number;
}

export interface ShareScopePlan {
	kind: ShareScopeKind;
	id: string;
	/** The profile this scope was filtered under: `structural` when `research` was asked of a scope without consent. */
	profile: ShareProfile;
	journal: Buffer;
	bundle: Buffer;
	objects: Array<{ id: string; bytes: Buffer }>;
	head: string;
	records: number;
	byTier: Record<string, number>;
	byEvent: Record<string, number>;
	objectBytes: number;
	redactions: number;
	dropped: ShareDropped;
}

export interface SharePlan {
	profile: ShareProfile;
	installId: string;
	clioCoderVersion: string;
	createdAt: string;
	scopes: ShareScopePlan[];
	skipped: ShareSkip[];
}

/** A header as a share carries it: the source host becomes the install id, and the rotation chain head is gone. */
function sharedHeader(header: SegmentHeader, installId: string): SegmentHeader {
	const { chainHead: _chainHead, ...rest } = header;
	return { ...rest, clockOrigin: { ...header.clockOrigin, host: installId } };
}

function admits(profile: ShareProfileDefinition, record: { tier: Tier; cc: ContentClass }): "tier" | "class" | null {
	if (!profile.tiers.includes(record.tier)) return "tier";
	if (!profile.classes.includes(record.cc)) return "class";
	return null;
}

function filterScope(
	source: ShareScopeSource,
	requested: ShareProfile,
	installId: string,
	writer: SegmentHeader["writer"],
	now: Date,
): ShareScopePlan {
	const headers: SegmentHeader[] = [];
	const rows: Array<{ kind: "header"; header: SegmentHeader } | { kind: "record"; record: TelemetryRecord }> = [];
	const dropped: ShareDropped = { tier: 0, contentClass: 0, unreadable: 0, seals: 0, objects: 0, missingObjects: 0 };
	let sourceSeal: TelemetryRecord | undefined;
	for (const segment of source.files.segments)
		for (const row of scanTelemetrySegment(segment.bytes).rows) {
			if (row.kind === "header") headers.push(row.header);
			if (row.kind === "skipped") dropped.unreadable += 1;
			else if (row.kind === "header") rows.push(row);
			else if (SOURCE_SEALS.has(row.record.k)) {
				sourceSeal = row.record;
				dropped.seals += 1;
			} else rows.push(row);
		}
	const first = headers[0];
	const last = headers.at(-1);
	if (!sourceSeal || !first || !last) throw new Error(`${source.kind} ${source.id} has no seal or header`);
	// Consent at capture is what admitted content; a scope captured without it shares structure at most (#434, O6).
	const consented = headers.some((header) => header.capture.content);
	const profile: ShareProfile = requested === "research" && !consented ? "structural" : requested;
	const definition = SHARE_PROFILES[profile];
	const tally = createRedactionTally();
	const kept: Array<SegmentHeader | TelemetryRecord> = [];
	let previousHeader = "";
	for (const row of rows) {
		if (row.kind === "header") {
			const header = sharedHeader(row.header, installId);
			const json = JSON.stringify(header);
			if (json !== previousHeader) kept.push(header);
			previousHeader = json;
			continue;
		}
		const refused = admits(definition, row.record);
		if (refused === "tier") dropped.tier += 1;
		else if (refused === "class") dropped.contentClass += 1;
		else {
			// A secret that reached a journal never leaves in an archive (#434, A3).
			const record = redactSecretsDeep(row.record, tally);
			kept.push(record.origin ? { ...record, origin: { ...record.origin, host: installId } } : record);
		}
	}
	const refs = new Map<string, string>();
	for (const line of kept) if (line.k !== "segment.open") collectRefs(line.data, refs);
	const present = new Map(source.files.objects.map((object) => [object.name, object.bytes]));
	const renamed = new Map<string, string>();
	const objects: Array<{ id: string; bytes: Buffer }> = [];
	for (const [id, subject] of [...refs].sort(([a], [b]) => a.localeCompare(b))) {
		if (definition.objects === "none" || (definition.objects === "structure" && CONTENT_SUBJECTS.has(subject))) {
			dropped.objects += 1;
			continue;
		}
		const bytes = present.get(`${id}.json`);
		if (bytes === undefined) {
			dropped.missingObjects += 1;
			continue;
		}
		const before = tally.count;
		const redacted = redactSecretsDeep(JSON.parse(bytes.toString("utf8")) as unknown, tally);
		// Objects are content-addressed: a redacted preimage is a new object, and the records cite it instead.
		const shared = tally.count === before ? bytes : Buffer.from(canonicalJson(redacted), "utf8");
		const sharedId = `obj_${sha256(shared)}`;
		if (sharedId !== id) renamed.set(id, sharedId);
		objects.push({ id: sharedId, bytes: shared });
	}
	objects.sort((a, b) => a.id.localeCompare(b.id));
	const rewrite = (line: SegmentHeader | TelemetryRecord): SegmentHeader | TelemetryRecord =>
		renamed.size === 0
			? line
			: (JSON.parse(JSON.stringify(line), (_key, value: unknown) =>
					typeof value === "string" ? (renamed.get(value) ?? value) : value,
				) as SegmentHeader | TelemetryRecord);
	const closing: SegmentHeader = {
		v: 1,
		k: "segment.open",
		schemaSet: last.schemaSet,
		mode: last.mode,
		capture: { ...last.capture, content: last.capture.content && profile === "research" },
		clockOrigin: { host: installId, pid: process.pid, birthToken: null, monoEpochWallMs: now.getTime() },
		writer,
	};
	const lines = [...kept.map(rewrite), closing].map(encodeTelemetryLine);
	let chain: TelemetryChain = EMPTY_TELEMETRY_CHAIN;
	for (const line of lines) chain = chainTelemetryLine(chain, line);
	const prefix = Buffer.concat(lines);
	const objectEntries: ScopeObjectEntry[] = objects.map(({ id, bytes }) => ({
		id,
		sha256: id.slice(4),
		bytes: bytes.length,
	}));
	const seal = makeTelemetryRecord(
		"share.sealed",
		{
			head: telemetryChainHead(chain) as string,
			records: chain.lines,
			segments: [{ name: TELEMETRY_JOURNAL_FILE, sha256: sha256(prefix), bytes: prefix.length }],
			objects: objectEntries,
			profile,
		},
		sourceSeal.ctx,
		{ t: now.toISOString(), mono: 0 },
	);
	const sealLine = encodeTelemetryLine(seal);
	const journal = Buffer.concat([prefix, sealLine]);
	const head = telemetryChainHead(chainTelemetryLine(chain, sealLine)) as string;
	const manifest = scopeBundleManifest({
		scope: { kind: source.kind, id: source.id },
		sealedAt: seal.t,
		writer,
		host: installId,
		segments: [{ name: TELEMETRY_JOURNAL_FILE, sha256: sha256(journal), bytes: journal.length }],
		objects: objectEntries,
		seal: { recordId: seal.id, head },
		share: { profile },
	});
	const bundle = Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
	const check = verifyTelemetryScope({
		manifest: bundle,
		segments: [{ name: TELEMETRY_JOURNAL_FILE, bytes: journal }],
		objects: objects.map(({ id, bytes }) => ({ name: `${id}.json`, bytes })),
	});
	if (check.status !== "verified")
		throw new Error(
			`shared ${source.kind} ${source.id} does not verify: ${check.status === "failed" ? describeSealMismatch(check.mismatch) : check.reason}`,
		);
	const byTier: Record<string, number> = {};
	const byEvent: Record<string, number> = {};
	let records = 0;
	for (const line of kept)
		if (line.k !== "segment.open") {
			records += 1;
			byTier[line.tier] = (byTier[line.tier] ?? 0) + 1;
			byEvent[line.k] = (byEvent[line.k] ?? 0) + 1;
		}
	return {
		kind: source.kind,
		id: source.id,
		profile,
		journal,
		bundle,
		objects,
		head,
		records,
		byTier,
		byEvent,
		objectBytes: objects.reduce((sum, object) => sum + object.bytes.length, 0),
		redactions: tally.count,
		dropped,
	};
}

/** Filter, redact and reseal every selected scope in memory; nothing is written until {@link writeShare}. */
export function planShare(input: {
	scopes: ReadonlyArray<ShareScopeSource>;
	skipped: ReadonlyArray<ShareSkip>;
	profile: ShareProfile;
	installId: string;
	writer: SegmentHeader["writer"];
	now?: Date;
}): SharePlan {
	const now = input.now ?? new Date();
	return {
		profile: input.profile,
		installId: input.installId,
		clioCoderVersion: input.writer.clioCoderVersion,
		createdAt: now.toISOString(),
		scopes: input.scopes.map((scope) => filterScope(scope, input.profile, input.installId, input.writer, now)),
		skipped: [...input.skipped],
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Archive

export const SHARE_ARCHIVE_FORMAT = "clio-coder.telemetry.share";
const SHARE_MANIFEST_FILE = "manifest.json";
const ShareManifestSchema = Type.Object(
	{
		format: Type.Literal(SHARE_ARCHIVE_FORMAT),
		version: Type.Literal(1),
		profile: ShareProfileSchema,
		installId: Type.String({ pattern: TELEMETRY_INSTALL_ID.source }),
		clioCoderVersion: Type.String(),
		createdAt: Type.String(),
		scopes: Type.Array(
			Type.Object(
				{
					kind: Type.Union([Type.Literal("session"), Type.Literal("run")]),
					id: Type.String(),
					profile: ShareProfileSchema,
					head: Type.String({ pattern: "^[0-9a-f]{64}$" }),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);
export type ShareManifest = Static<typeof ShareManifestSchema>;

/** The archive bytes for a plan: the manifest first, then each scope's journal, bundle.json and objects. */
export function shareArchiveBytes(plan: SharePlan): Buffer {
	const manifest: ShareManifest = {
		format: SHARE_ARCHIVE_FORMAT,
		version: 1,
		profile: plan.profile,
		installId: plan.installId,
		clioCoderVersion: plan.clioCoderVersion,
		createdAt: plan.createdAt,
		scopes: plan.scopes.map(({ kind, id, profile, head }) => ({ kind, id, profile, head })),
	};
	const entries: ShareArchiveEntry[] = [
		{ path: SHARE_MANIFEST_FILE, bytes: Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`) },
	];
	for (const scope of plan.scopes) {
		const base = `${SCOPE_DIRECTORY[scope.kind]}/${scope.id}`;
		entries.push({ path: `${base}/${TELEMETRY_JOURNAL_FILE}`, bytes: scope.journal });
		entries.push({ path: `${base}/${TELEMETRY_BUNDLE_FILE}`, bytes: scope.bundle });
		for (const object of scope.objects) entries.push({ path: `${base}/objects/${object.id}.json`, bytes: object.bytes });
	}
	return packTelemetryArchive(entries, Math.floor(Date.parse(plan.createdAt) / 1000));
}

/** Write the plan's archive to `out`, which must not exist. */
export async function writeShare(plan: SharePlan, out: string): Promise<number> {
	if (
		await stat(out).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		)
	)
		throw new Error(`refusing to overwrite ${out}`);
	const bytes = shareArchiveBytes(plan);
	await safeResourceWriteAsync(out, bytes, { mode: 0o600 });
	return bytes.length;
}

export interface ShareArchiveScope {
	kind: ShareScopeKind;
	id: string;
	files: TelemetryScopeFiles;
	verdict: SealVerdict;
}

export interface ShareArchiveCheck {
	manifest: ShareManifest | null;
	scopes: ShareArchiveScope[];
	/** Null when every bundle verifies and the archive is what its manifest says; else the first problem. */
	failure: string | null;
}

const MEMBER = /^(sessions|runs)\/([^/]+)\/(.+)$/u;

/** The profile a shared scope's records and objects must stay within, checked line by line. */
function profileViolation(files: TelemetryScopeFiles, profile: ShareProfile): string | null {
	const definition = SHARE_PROFILES[profile];
	const refs = new Map<string, string>();
	for (const segment of files.segments)
		for (const row of scanTelemetrySegment(segment.bytes).rows) {
			if (row.kind === "skipped") return "holds a line this version cannot read";
			if (row.kind !== "record" || row.record.k === SHARE_SEAL_EVENT) continue;
			if (admits(definition, row.record) !== null)
				return `holds ${row.record.k} (${row.record.tier}, ${row.record.cc}) above the ${profile} profile`;
			collectRefs(row.record.data, refs);
		}
	for (const object of files.objects) {
		const id = object.name.replace(/\.json$/u, "");
		const subject = refs.get(id);
		if (subject === undefined) return `holds ${object.name}, which no record cites`;
		if (definition.objects === "none" || (definition.objects === "structure" && CONTENT_SUBJECTS.has(subject)))
			return `holds ${subject} object ${object.name} above the ${profile} profile`;
	}
	return null;
}

/**
 * Verify a share archive with nothing but its own bytes: its manifest, that it holds exactly the scopes the manifest
 * names, every bundle as `telemetry verify` checks a sealed scope, each bundle's share seal, source id and head against
 * the manifest, and every record and object against the profile that bundle was filtered under.
 */
export function verifyShareArchive(archive: Buffer): ShareArchiveCheck {
	const check: ShareArchiveCheck = { manifest: null, scopes: [], failure: null };
	let entries: ReturnType<typeof unpackTelemetryArchive>;
	try {
		entries = unpackTelemetryArchive(archive);
	} catch (error) {
		check.failure = error instanceof Error ? error.message : String(error);
		return check;
	}
	const groups = new Map<string, { kind: ShareScopeKind; id: string; files: TelemetryScopeFiles }>();
	let manifestBytes: Buffer | null = null;
	for (const entry of entries) {
		if (entry.path === SHARE_MANIFEST_FILE) {
			manifestBytes = entry.bytes;
			continue;
		}
		const match = MEMBER.exec(entry.path);
		const rest = match?.[3] ?? "";
		const objectName = /^objects\/([^/]+)$/u.exec(rest)?.[1];
		if (!match || (rest !== TELEMETRY_BUNDLE_FILE && !isTelemetryJournalFile(rest) && objectName === undefined)) {
			check.failure = `unexpected archive member ${entry.path}`;
			return check;
		}
		const kind: ShareScopeKind = match[1] === "sessions" ? "session" : "run";
		const id = match[2] as string;
		const key = `${kind}:${id}`;
		const group = groups.get(key) ?? { kind, id, files: { manifest: null, segments: [], objects: [] } };
		groups.set(key, group);
		if (rest === TELEMETRY_BUNDLE_FILE) group.files.manifest = entry.bytes;
		else if (objectName !== undefined) group.files.objects.push({ name: objectName, bytes: entry.bytes });
		else group.files.segments.push({ name: rest, bytes: entry.bytes });
	}
	if (manifestBytes === null) {
		check.failure = `archive has no ${SHARE_MANIFEST_FILE}`;
		return check;
	}
	try {
		const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
		if (!Value.Check(ShareManifestSchema, parsed)) throw new Error("not a version 1 share manifest");
		check.manifest = parsed;
	} catch (error) {
		check.failure = `${SHARE_MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}`;
		return check;
	}
	const manifest = check.manifest;
	const named = new Set(manifest.scopes.map((scope) => `${scope.kind}:${scope.id}`));
	if (named.size !== manifest.scopes.length) {
		check.failure = `${SHARE_MANIFEST_FILE} names a scope twice`;
		return check;
	}
	for (const key of groups.keys())
		if (!named.has(key)) {
			check.failure = `archive holds ${key.replace(":", " ")}, which the manifest does not name`;
			return check;
		}
	for (const scope of manifest.scopes) {
		const group = groups.get(`${scope.kind}:${scope.id}`);
		if (!group) {
			check.failure = `manifest names ${scope.kind} ${scope.id}, which the archive does not hold`;
			return check;
		}
		const files: TelemetryScopeFiles = {
			...group.files,
			// Verification wants segments oldest first, the live one last, and objects by name.
			segments: [...group.files.segments].sort((a, b) =>
				a.name === TELEMETRY_JOURNAL_FILE ? 1 : b.name === TELEMETRY_JOURNAL_FILE ? -1 : a.name.localeCompare(b.name),
			),
			objects: [...group.files.objects].sort((a, b) => a.name.localeCompare(b.name)),
		};
		const verdict = verifyTelemetryScope(files);
		check.scopes.push({ kind: scope.kind, id: scope.id, files, verdict });
		const label = `${scope.kind} ${scope.id}`;
		if (verdict.status !== "verified") {
			check.failure = `${label}: ${verdict.status === "failed" ? describeSealMismatch(verdict.mismatch) : "has no bundle.json"}`;
			return check;
		}
		const bundle = JSON.parse((files.manifest as Buffer).toString("utf8")) as ScopeBundleManifest;
		if (verdict.scope.kind !== scope.kind || verdict.scope.id !== scope.id)
			check.failure = `${label}: its bundle names ${verdict.scope.kind} ${verdict.scope.id}`;
		else if (bundle.share?.profile !== scope.profile) check.failure = `${label}: not sealed by a ${scope.profile} share`;
		else if (PROFILE_RANK[scope.profile] > PROFILE_RANK[manifest.profile])
			check.failure = `${label}: its ${scope.profile} profile exceeds the archive's ${manifest.profile}`;
		else if (bundle.host !== manifest.installId) check.failure = `${label}: sealed by another source`;
		else if (verdict.seal.head !== scope.head) check.failure = `${label}: its head differs from the manifest`;
		else {
			const violation = profileViolation(files, scope.profile);
			if (violation !== null) check.failure = `${label}: ${violation}`;
		}
		if (check.failure !== null) return check;
	}
	return check;
}

export interface ShareImport {
	installId: string;
	manifest: ShareManifest;
	placed: Array<{ kind: ShareScopeKind; id: string; directory: string }>;
	/** Scopes already imported; never overwritten. `identical` says whether the archive's bundle matches. */
	existing: Array<{ kind: ShareScopeKind; id: string; directory: string; identical: boolean }>;
}

/**
 * Verify an archive completely, then place each bundle under `<stateDir>/telemetry/imported/<installId>/` without
 * overwriting a scope already there, and verify each placed scope again from disk.
 */
export async function importShareArchive(stateDir: string, archive: Buffer): Promise<ShareImport> {
	const check = verifyShareArchive(archive);
	if (check.failure !== null || check.manifest === null) throw new Error(check.failure ?? "archive does not verify");
	const manifest = check.manifest;
	const base = telemetryImportedStateDir(stateDir, manifest.installId);
	const result: ShareImport = { installId: manifest.installId, manifest, placed: [], existing: [] };
	for (const scope of check.scopes) {
		const directory = scopeDirectory(base, scope.kind, scope.id);
		if (existsSync(directory)) {
			const current = await readFile(join(directory, TELEMETRY_BUNDLE_FILE)).catch(() => null);
			result.existing.push({
				kind: scope.kind,
				id: scope.id,
				directory,
				identical: current !== null && scope.files.manifest !== null && current.equals(scope.files.manifest),
			});
			continue;
		}
		await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
		const staging = `${directory}.partial-${randomBytes(6).toString("hex")}`;
		try {
			await mkdir(join(staging, "objects"), { recursive: true, mode: 0o700 });
			for (const segment of scope.files.segments)
				await writeFile(join(staging, segment.name), segment.bytes, { mode: 0o600, flag: "wx" });
			for (const object of scope.files.objects)
				await writeFile(join(staging, "objects", object.name), object.bytes, { mode: 0o600, flag: "wx" });
			await writeFile(join(staging, TELEMETRY_BUNDLE_FILE), scope.files.manifest as Buffer, {
				mode: 0o600,
				flag: "wx",
			});
			// A placed scope appears whole at once; a reader never sees one without its bundle.json.
			await rename(staging, directory);
		} catch (error) {
			await rm(staging, { recursive: true, force: true });
			throw error;
		}
		const placed = verifyTelemetryScope(await readTelemetryScopeFiles(directory));
		if (placed.status !== "verified")
			throw new Error(
				`imported ${scope.kind} ${scope.id} does not verify on disk: ${placed.status === "failed" ? describeSealMismatch(placed.mismatch) : placed.reason}`,
			);
		result.placed.push({ kind: scope.kind, id: scope.id, directory });
	}
	return result;
}
