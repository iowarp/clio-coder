#!/usr/bin/env node
/**
 * Maintainer tooling: turn consented report bundles in an intake store into a dataset release (R-21, mechanics first).
 *
 *   node --import tsx scripts/report-dataset.ts build --store <dir> --release <name> --out <dir> [--kind mechanics|traces]
 *       [--identities <file.json>]
 *   node --import tsx scripts/report-dataset.ts withdraw --store <dir> <reportId>
 *   node --import tsx scripts/report-dataset.ts --self-check
 *
 * The intake store holds `index.jsonl` (one line per bundle: reportId, sha256, scopes, content, status),
 * `bundles/<reportId>.tar.gz`, `exclusions.txt` and, for traces, `reviewed.txt`. The tool reads the store and writes only
 * `exclusions.txt` and `releases/<release>/private-map.jsonl`. It publishes nothing and makes no network request.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import type { SegmentHeader, TelemetryRecord } from "../src/core/telemetry/envelope.js";
import { encodeTelemetryLine, scanTelemetrySegment } from "../src/core/telemetry/segment.js";
import { createRedactionTally, redactSecretsText } from "../src/domains/evidence/index.js";
import { REPORT_ID } from "../src/domains/report/draft.js";
import {
	canaryScan,
	type LocalIdentity,
	REPORT_BUNDLE_ENVELOPE_SCHEMA,
	type ReportBundleEnvelope,
} from "../src/domains/report/index.js";
import {
	freshShareSource,
	packShare,
	packTelemetryArchive,
	planShare,
	type ShareArchiveEntry,
	unpackTelemetryArchive,
	verifyShareArchive,
} from "../src/domains/telemetry/index.js";
import type { ShareScopeSource } from "../src/domains/telemetry/share.js";

const EXPORTER_VERSION = 1;
/** Below this many admitted bundles a release is too small to hide anyone in. */
const MIN_BUNDLES = 20;
/** A readable value seen in fewer bundles than this is replaced by `rare_<kind>`. */
const RARE_BELOW = 5;
const EPOCH = Date.UTC(2000, 0, 1);
const RARE_KINDS = ["model", "token"] as const;
type RareKind = (typeof RARE_KINDS)[number];

const ANON = /anon_[0-9a-f]{16}/gu;
const RECORD_ID = /^rec_([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Every other minted id that carries its own mint time: a UUIDv7 under any prefix, a ULID, a compact-UTC run id. */
const UUID_V7_ID =
	/^([a-z][a-z0-9]{0,11}[_:-])?([0-9a-f]{8})-([0-9a-f]{4})(-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const ULID_ID = /^([a-z][a-z0-9]{0,11}[_:-])?([0-9A-HJKMNP-TV-Z]{10})([0-9A-HJKMNP-TV-Z]{16})$/u;
const COMPACT_RUN_ID = /^([a-z][a-z0-9]{0,11}[_:-])?(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z(-[0-9a-f]{6})$/u;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const EPOCH_MS_MIN = 1e12;
const EPOCH_MS_MAX = 1e13;
const TIME_KEY = /(?:At|Ms|Time|Ts|Epoch)$|^(?:wall|ts|time)$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export interface IndexLine {
	reportId: string;
	sha256: string;
	scopes: string[];
	content: "none" | "transcript";
	status: string;
}

interface Admitted {
	line: IndexLine;
	envelope: ReportBundleEnvelope;
	telemetry: Buffer;
	transcript: Buffer | null;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function lines(path: string): string[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

function readIndex(store: string): IndexLine[] {
	return lines(join(store, "index.jsonl")).map((line) => JSON.parse(line) as IndexLine);
}

/** A UUIDv7-shaped record id at `ms`, so ids still sort by time without carrying the original clock. */
function recordIdAt(ms: number): string {
	const hex = Math.max(0, ms).toString(16).padStart(12, "0").slice(-12);
	const rand = randomBytes(10).toString("hex");
	const variant = ((Number.parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
	return `rec_${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(8, 20)}`;
}

/** The same id re-minted `shiftMs` earlier with fresh random bits, or null when it carries no mint time. */
function shiftedMintedId(value: string, shiftMs: number): string | null {
	const uuid = UUID_V7_ID.exec(value);
	if (uuid) {
		const hex = Math.max(0, Number.parseInt(`${uuid[2]}${uuid[3]}`, 16) - shiftMs)
			.toString(16)
			.padStart(12, "0")
			.slice(-12);
		const rand = randomBytes(10).toString("hex");
		const variant = ((Number.parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
		return `${uuid[1] ?? ""}${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(8, 20)}`;
	}
	const ulid = ULID_ID.exec(value);
	if (ulid) {
		let ms = 0;
		for (const char of ulid[2] ?? "") ms = ms * 32 + CROCKFORD.indexOf(char);
		let time = "";
		for (let left = Math.max(0, ms - shiftMs), n = 0; n < 10; n += 1, left = Math.floor(left / 32))
			time = `${CROCKFORD[left % 32]}${time}`;
		const rand = [...randomBytes(16)].map((byte) => CROCKFORD[byte % 32]).join("");
		return `${ulid[1] ?? ""}${time}${rand}`;
	}
	const run = COMPACT_RUN_ID.exec(value);
	if (run) {
		const [, prefix = "", y, mo, d, h, mi, sec] = run;
		const at = new Date(Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}Z`) - shiftMs).toISOString();
		return `${prefix}${at.replace(/[-:]|\.\d{3}/gu, "")}-${randomBytes(3).toString("hex")}`;
	}
	return null;
}

/**
 * Admission: held index lines whose scopes include `dataset`, not excluded, whose bundle matches its recorded hash
 * and whose own envelope agrees on `dataset`. Traces also need a transcript and a reviewed sign-off. No flag widens it.
 */
export function admit(store: string, kind: "mechanics" | "traces"): Admitted[] {
	const excluded = new Set(lines(join(store, "exclusions.txt")));
	const reviewed = new Set(lines(join(store, "reviewed.txt")));
	const admitted: Admitted[] = [];
	for (const line of readIndex(store)) {
		if (line.status !== "held" || !Array.isArray(line.scopes) || !line.scopes.includes("dataset")) continue;
		if (!REPORT_ID.test(line.reportId) || excluded.has(line.reportId)) continue;
		if (kind === "traces" && (line.content !== "transcript" || !reviewed.has(line.reportId))) continue;
		const path = join(store, "bundles", `${line.reportId}.tar.gz`);
		if (!existsSync(path)) throw new Error(`${line.reportId}: the index holds it but bundles/ does not`);
		const bytes = readFileSync(path);
		if (sha256(bytes) !== line.sha256) throw new Error(`${line.reportId}: the bundle does not match its index sha256`);
		const members = unpackTelemetryArchive(bytes);
		const member = (name: string) => members.find((entry) => entry.path === name)?.bytes ?? null;
		const envelopeBytes = member("report.json");
		const telemetry = member("telemetry.tar.gz");
		if (envelopeBytes === null || telemetry === null) throw new Error(`${line.reportId}: not a report bundle`);
		const envelope: unknown = JSON.parse(envelopeBytes.toString("utf8"));
		if (!Value.Check(REPORT_BUNDLE_ENVELOPE_SCHEMA, envelope))
			throw new Error(`${line.reportId}: the envelope does not match its schema`);
		if (envelope.reportId !== line.reportId) throw new Error(`${line.reportId}: the envelope names another report`);
		// The envelope is what the reporter agreed to; the index only mirrors it.
		if (!envelope.consent.scopes.includes("dataset")) continue;
		if (kind === "traces" && envelope.consent.content !== "transcript") continue;
		const failure = verifyShareArchive(telemetry).failure;
		if (failure !== null) throw new Error(`${line.reportId}: the telemetry does not verify: ${failure}`);
		admitted.push({ line, envelope, telemetry, transcript: kind === "traces" ? member("transcript.jsonl") : null });
	}
	return admitted;
}

/** The readable values seen in fewer than {@link RARE_BELOW} admitted bundles, by kind. */
function rareValues(admitted: ReadonlyArray<Admitted>): Map<string, RareKind> {
	const counts = new Map<string, { kind: RareKind; bundles: number }>();
	for (const { envelope } of admitted) {
		const seen = new Map<string, RareKind>();
		for (const kind of RARE_KINDS) for (const value of envelope.inventory.readable[kind]) seen.set(value, kind);
		if (envelope.environment.model !== null) seen.set(envelope.environment.model, "model");
		for (const [value, kind] of seen) {
			const entry = counts.get(value) ?? { kind, bundles: 0 };
			entry.bundles += 1;
			counts.set(value, entry);
		}
	}
	const rare = new Map<string, RareKind>();
	for (const [value, { kind, bundles }] of counts) if (bundles < RARE_BELOW) rare.set(value, kind);
	return rare;
}

interface Mapper {
	string(value: string): string;
	value<T>(value: T): T;
	ambiguous: ReadonlySet<string>;
}

/** Re-key anonymous ids under the release key, shift every timestamp and record id, rename scopes, drop rare values. */
function mapper(
	releaseKey: Buffer,
	shiftMs: number,
	scopeIds: Map<string, string>,
	rare: Map<string, RareKind>,
): Mapper {
	const records = new Map<string, string>();
	const string = (value: string): string => {
		const scope = scopeIds.get(value);
		if (scope !== undefined) return scope;
		const kind = rare.get(value);
		if (kind !== undefined) return `rare_${kind}`;
		if (ISO.test(value)) return new Date(Date.parse(value) - shiftMs).toISOString();
		const record = RECORD_ID.exec(value);
		if (record) {
			let mapped = records.get(value);
			if (mapped === undefined) {
				mapped = recordIdAt(Number.parseInt(`${record[1]}${record[2]}`, 16) - shiftMs);
				records.set(value, mapped);
			}
			return mapped;
		}
		const minted = records.get(value) ?? shiftedMintedId(value, shiftMs);
		if (minted !== null) {
			records.set(value, minted);
			return minted;
		}
		return value.replace(ANON, (id) => `anon_${createHmac("sha256", releaseKey).update(id).digest("hex").slice(0, 16)}`);
	};
	const ambiguous = new Set<string>();
	// Epoch milliseconds under a time-shaped key move with the strings; durations and counters stay as they are. A
	// number in the epoch range under any other key is reported for a human to decide, never guessed.
	const number = (key: string, item: number): number => {
		if (item < EPOCH_MS_MIN || item >= EPOCH_MS_MAX) return item;
		if (TIME_KEY.test(key)) return item - shiftMs;
		ambiguous.add(key);
		return item;
	};
	const value = <T>(input: T): T =>
		JSON.parse(JSON.stringify(input), (key, item: unknown) =>
			typeof item === "string" ? string(item) : typeof item === "number" ? number(key, item) : item,
		) as T;
	return { string, value, ambiguous };
}

interface Trace {
	traceId: string;
	reportId: string;
	archive: Buffer;
	records: Buffer;
	trace: Record<string, unknown>;
	transcript: Buffer | null;
	schemaSets: string[];
	ambiguous: string[];
	clioCoder: string;
	consentVersion: number;
}

function rebuildTrace(item: Admitted, releaseKey: Buffer, rare: Map<string, RareKind>): Trace {
	const check = verifyShareArchive(item.telemetry);
	const manifest = check.manifest;
	if (manifest === null) throw new Error(`${item.line.reportId}: no share manifest`);
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;
	const scanned = check.scopes.map((scope) => ({
		scope,
		segments: scope.files.segments.map((segment) => ({
			name: segment.name,
			rows: scanTelemetrySegment(segment.bytes).rows,
		})),
	}));
	for (const { segments } of scanned)
		for (const segment of segments)
			for (const row of segment.rows)
				if (row.kind === "record") {
					const t = Date.parse(row.record.t);
					first = Math.min(first, t);
					last = Math.max(last, t);
				}
	if (!Number.isFinite(first)) throw new Error(`${item.line.reportId}: the telemetry holds no record`);
	const shiftMs = first - EPOCH;
	const scopeIds = new Map(
		check.scopes.map((scope) => [scope.id, `${scope.kind}_${randomBytes(8).toString("hex")}`] as const),
	);
	const map = mapper(releaseKey, shiftMs, scopeIds, rare);
	const sources: ShareScopeSource[] = scanned.map(({ scope, segments }) => {
		const rewritten = segments.map((segment) => ({
			name: segment.name,
			bytes: Buffer.concat(
				segment.rows.flatMap((row) => {
					if (row.kind === "record") return [encodeTelemetryLine(map.value(row.record) as TelemetryRecord)];
					if (row.kind === "header") {
						return [encodeTelemetryLine(map.value(row.header) as SegmentHeader)];
					}
					return [];
				}),
			),
		}));
		return {
			kind: scope.kind,
			id: scopeIds.get(scope.id) as string,
			sealedAt: new Date(last - shiftMs).toISOString(),
			files: {
				manifest: null,
				segments: rewritten,
				objects: scope.files.objects.map((object) => ({
					name: object.name,
					bytes: Buffer.from(JSON.stringify(map.value(JSON.parse(object.bytes.toString("utf8")) as unknown))),
				})),
			},
		};
	});
	const plan = planShare({
		scopes: sources,
		skipped: [],
		profile: "report",
		// A source minted for this trace alone: its install id links it to nothing.
		source: freshShareSource(),
		writer: { clioCoderVersion: manifest.clioCoderVersion, piVersion: "unknown" },
		now: new Date(last - shiftMs),
		models: "keep",
	});
	const archive = packShare(plan);
	const failure = verifyShareArchive(archive).failure;
	if (failure !== null) throw new Error(`${item.line.reportId}: the rebuilt archive does not verify: ${failure}`);
	const records: string[] = [];
	const schemaSets = new Set<string>();
	for (const scope of plan.scopes)
		for (const row of scanTelemetrySegment(scope.journal).rows) {
			if (row.kind === "record") records.push(JSON.stringify(row.record));
			if (row.kind === "header") schemaSets.add(String(row.header.schemaSet));
		}
	const envelope = item.envelope;
	const traceId = `trace_${randomBytes(12).toString("hex")}`;
	const trace = {
		traceId,
		kind: envelope.kind,
		trigger: envelope.trigger,
		cause: envelope.cause,
		environment: map.value(envelope.environment),
		consent: {
			scopes: envelope.consent.scopes,
			content: envelope.consent.content,
			textVersion: envelope.consent.textVersion,
		},
		inventory: {
			readable: Object.fromEntries(
				Object.entries(map.value(envelope.inventory.readable)).map(([kind, values]) => [kind, [...new Set(values)]]),
			),
			anonymized: envelope.inventory.anonymized,
			withheld: envelope.inventory.withheld,
		},
	};
	return {
		traceId,
		reportId: item.line.reportId,
		archive,
		records: Buffer.from(records.map((record) => `${record}\n`).join("")),
		trace,
		transcript:
			item.transcript === null
				? null
				: Buffer.from(
						item.transcript
							.toString("utf8")
							.split("\n")
							.map((line) => (line.length === 0 ? line : JSON.stringify(map.value(JSON.parse(line) as unknown))))
							.join("\n"),
					),
		schemaSets: [...schemaSets],
		ambiguous: [...map.ambiguous],
		clioCoder: envelope.environment.clioCoder,
		consentVersion: envelope.consent.textVersion,
	};
}

/** Every string of every original bundle that must not survive: report ids, fingerprints, anonymous, scope and install ids. */
function linkingValues(admitted: ReadonlyArray<Admitted>): string[] {
	const values = new Set<string>();
	for (const item of admitted) {
		values.add(item.line.reportId);
		if (item.envelope.fingerprint !== null) values.add(item.envelope.fingerprint);
		const check = verifyShareArchive(item.telemetry);
		if (check.manifest) values.add(check.manifest.installId);
		for (const scope of check.scopes) values.add(scope.id);
		for (const entry of unpackTelemetryArchive(item.telemetry))
			for (const id of entry.bytes.toString("utf8").match(ANON) ?? []) values.add(id);
	}
	return [...values];
}

function stringsOf(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
	else if (value !== null && typeof value === "object") for (const item of Object.values(value)) stringsOf(item, out);
	return out;
}

function datasetCard(kind: string, release: string, count: number): string {
	return `# Clio Coder report ${kind} dataset, release ${release}

${count} traces of Clio Coder sessions, one per bug report whose sender ticked the dataset scope.

## How it was collected
Only from reports the sender chose to file and, in the send step, agreed may be used to build a dataset. Nothing
was collected by background telemetry. Bundles sent for debugging only are never included.

## What was removed
- Report ids, issue links, fingerprints and creation dates; each trace has a fresh random trace id.
- Every anonymous id was re-keyed under a key made for this release and discarded, so ids are stable within the
  release and cannot be linked to the bundles the maintainers hold or to another release.
- Time: each trace is shifted so its first record is at 2000-01-01T00:00:00Z. Order, intervals and monotonic
  clocks are kept; the date and hour of work are gone.
- Readable values (model ids, non-built-in tokens) seen in fewer than ${RARE_BELOW} traces are replaced by
  \`rare_<kind>\`. A release is not built from fewer than ${MIN_BUNDLES} traces.
${kind === "traces" ? "- Transcripts are included only after a maintainer read and signed off each one.\n" : "- No prompts, model text or tool output: mechanics only.\n"}
## Known biases
These are sessions that went wrong, from people willing to share them. They are not a picture of normal operation.

## Licence
To be set by the maintainers before any publication.

## Removal
A sender can withdraw a report at any time; the next release omits its trace. Copies of releases already published
cannot be recalled.
`;
}

export interface BuildOptions {
	store: string;
	release: string;
	out: string;
	kind: "mechanics" | "traces";
	identities?: ReadonlyArray<LocalIdentity>;
}

export function build(options: BuildOptions): { traces: number; out: string; ambiguous: string[] } {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(options.release)) throw new Error(`not a release name: ${options.release}`);
	const admitted = admit(options.store, options.kind);
	if (admitted.length < MIN_BUNDLES)
		throw new Error(
			`refused: ${admitted.length} bundles admitted, a release needs at least ${MIN_BUNDLES} to hide anyone in`,
		);
	const releaseDir = join(options.store, "releases", options.release);
	if (existsSync(releaseDir)) throw new Error(`release ${options.release} already exists in the store`);
	if (existsSync(options.out) && readdirSync(options.out).length > 0) throw new Error(`${options.out} is not empty`);
	const releaseKey = randomBytes(32);
	const rare = rareValues(admitted);
	const traces = admitted.map((item) => rebuildTrace(item, releaseKey, rare));
	releaseKey.fill(0);

	// Re-verify everything that would be published before writing any of it.
	const forbidden = linkingValues(admitted);
	const files: ShareArchiveEntry[] = [];
	for (const trace of traces) {
		const base = `${options.kind}/${trace.traceId}`;
		files.push({ path: `${base}/trace.json`, bytes: Buffer.from(`${JSON.stringify(trace.trace, null, "\t")}\n`) });
		files.push({ path: `${base}/records.jsonl`, bytes: trace.records });
		files.push({ path: `${base}/telemetry.tar.gz`, bytes: trace.archive });
		if (trace.transcript !== null) files.push({ path: `${base}/transcript.jsonl`, bytes: trace.transcript });
	}
	const manifest = {
		format: "clio-coder.report.dataset",
		version: 1,
		kind: options.kind,
		release: options.release,
		exporterVersion: EXPORTER_VERSION,
		traces: traces.length,
		schemaSets: [...new Set(traces.flatMap((trace) => trace.schemaSets))].sort(),
		clioCoder: [...new Set(traces.map((trace) => trace.clioCoder))].sort(),
		consentTextVersions: [...new Set(traces.map((trace) => trace.consentVersion))].sort(),
		rareBelow: RARE_BELOW,
		minimumTraces: MIN_BUNDLES,
	};
	files.push({ path: "manifest.json", bytes: Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`) });
	files.push({ path: "DATASET.md", bytes: Buffer.from(datasetCard(options.kind, options.release, traces.length)) });
	const plain = files.flatMap((file) =>
		file.path.endsWith(".tar.gz")
			? unpackTelemetryArchive(file.bytes).map((inner) => ({ name: `${file.path}/${inner.path}`, bytes: inner.bytes }))
			: [{ name: file.path, bytes: file.bytes }],
	);
	for (const { name, bytes } of plain) {
		const text = bytes.toString("utf8");
		for (const value of forbidden) if (text.includes(value)) throw new Error(`refused: ${name} still holds a linking id`);
		if (name.endsWith(".json") || name.endsWith(".jsonl") || name.endsWith(".md"))
			for (const string of name.endsWith(".md") ? [text] : text.split("\n").flatMap((line) => linesStrings(line)))
				if (redactSecretsText(string, createRedactionTally()) !== string)
					throw new Error(`refused: ${name} holds a string a secret pattern matches`);
	}
	for (const identity of options.identities ?? []) {
		const hits = canaryScan(plain, identity);
		if (hits.length > 0) throw new Error(`refused: an identity canary was found in ${hits[0]?.member ?? "a member"}`);
	}

	mkdirSync(releaseDir, { recursive: true });
	writeFileSync(
		join(releaseDir, "private-map.jsonl"),
		traces.map((trace) => `${JSON.stringify({ traceId: trace.traceId, reportId: trace.reportId })}\n`).join(""),
		{ mode: 0o600 },
	);
	const ambiguous = [...new Set(traces.flatMap((trace) => trace.ambiguous))].sort();
	if (ambiguous.length > 0)
		writeFileSync(join(releaseDir, "ambiguous-fields.txt"), ambiguous.map((key) => `${key}\n`).join(""));
	for (const file of files) {
		const path = join(options.out, file.path);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, file.bytes);
	}
	return { traces: traces.length, out: options.out, ambiguous };
}

function linesStrings(line: string): string[] {
	if (line.length === 0) return [];
	try {
		return stringsOf(JSON.parse(line) as unknown);
	} catch {
		return [line];
	}
}

/** Exclude a report from every later release and name the releases that already carry its trace. */
export function withdraw(store: string, reportId: string): Array<{ release: string; traceId: string }> {
	if (!REPORT_ID.test(reportId)) throw new Error(`not a report id: ${reportId}`);
	if (!lines(join(store, "exclusions.txt")).includes(reportId))
		appendFileSync(join(store, "exclusions.txt"), `${reportId}\n`);
	const releases = join(store, "releases");
	const found: Array<{ release: string; traceId: string }> = [];
	if (!existsSync(releases)) return found;
	for (const release of readdirSync(releases).sort())
		for (const line of lines(join(releases, release, "private-map.jsonl"))) {
			const entry = JSON.parse(line) as { traceId: string; reportId: string };
			if (entry.reportId === reportId) found.push({ release, traceId: entry.traceId });
		}
	return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-check over synthetic bundles: admission, unlinking, the rare-value rule, the minimum size and withdrawal.

/** Minted ids whose own bits carry the real time they were made: a UUIDv7 call id and a compact-UTC run id. */
const SELF_CALL_ID = `cal_${Date.now()
	.toString(16)
	.padStart(12, "0")
	.replace(/^(.{8})(.{4})$/u, "$1-$2")}-7abc-8def-0123456789ab`;
const SELF_RUN_ID = `${new Date().toISOString().replace(/[-:]|\.\d{3}/gu, "")}-abc123`;

async function syntheticStore(
	root: string,
	total: number,
): Promise<{ store: string; debugOnly: string[]; rareModel: string }> {
	const { buildBundle, composeReportDraft } = await import("../src/domains/report/index.js");
	const { openCallJournal } = await import("../src/domains/telemetry/call-journal.js");
	const { telemetrySessionDirectory } = await import("../src/domains/telemetry/index.js");
	const stateDir = join(root, "state");
	const store = join(root, "store");
	mkdirSync(join(store, "bundles"), { recursive: true });
	const writer = { clioCoderVersion: "0.8.0", piVersion: "0.0.0-selfcheck" };
	const identity: LocalIdentity = { packageRoot: null, paths: ["/home/zqxselfcheck"], remotes: [], names: [] };
	const index: IndexLine[] = [];
	const debugOnly: string[] = [];
	const rareModel = "zqx-rare-model-1";
	for (let n = 0; n < total; n += 1) {
		const sessionId = `ses_selfcheck${n}`;
		const ctx = { sessionId, agent: { role: "main", id: sessionId }, parentRunId: SELF_RUN_ID, callId: SELF_CALL_ID };
		const journal = await openCallJournal({
			directory: telemetrySessionDirectory(stateDir, sessionId),
			context: ctx as never,
			writer,
		});
		for (const kind of ["session.opened", "turn.settled"])
			journal.enqueue({
				kind,
				data:
					kind === "session.opened"
						? {}
						: { stopReason: "stop", terminal: { cause: null, stage: null, retries: 0, callIds: [SELF_CALL_ID] } },
				ctx,
				wallMs: Date.now() + n * 1000,
				mono: performance.now(),
			} as never);
		await journal.flush();
		await journal.close();
		const draft = composeReportDraft({
			kind: "bug",
			surface: "headless",
			title: `Self-check report ${n}`,
			happened: "The dataset self-check composes this report over a synthetic session.",
			session: { id: sessionId, observations: [] },
		});
		const scopes: ["debug"] | ["debug", "dataset"] = n < 3 ? ["debug"] : ["debug", "dataset"];
		const built = await buildBundle(draft, { consent: { scopes }, identity, stateDir, writer, write: false });
		const envelope = structuredClone(built.envelope);
		const model = n >= 3 && n < 6 ? rareModel : "zqx-common-model";
		envelope.environment.model = model;
		envelope.inventory.readable.model = [model];
		const members = built.members.map((member) =>
			member.path === "report.json"
				? { path: member.path, bytes: Buffer.from(`${JSON.stringify(envelope, null, "\t")}\n`) }
				: member,
		);
		const bytes = packTelemetryArchive(members, 0);
		writeFileSync(join(store, "bundles", `${draft.id}.tar.gz`), bytes);
		if (n < 3) debugOnly.push(draft.id);
		// The index of a debug-only bundle claims dataset too: the envelope still keeps it out.
		index.push({
			reportId: draft.id,
			sha256: sha256(bytes),
			scopes: ["debug", "dataset"],
			content: "none",
			status: "held",
		});
	}
	writeFileSync(join(store, "index.jsonl"), index.map((line) => `${JSON.stringify(line)}\n`).join(""));
	return { store, debugOnly, rareModel };
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`self-check failed: ${message}`);
}

export async function selfCheck(): Promise<string[]> {
	const root = mkdtempSync(join(tmpdir(), "report-dataset-"));
	const passed: string[] = [];
	try {
		// 3 debug-only bundles and 22 with the dataset scope; the rare model sits in 3 of them.
		const { store, debugOnly, rareModel } = await syntheticStore(root, 25);
		const admitted = admit(store, "mechanics");
		assert(admitted.length === 22, `admitted ${admitted.length}, expected 22`);
		assert(!admitted.some((item) => debugOnly.includes(item.line.reportId)), "a debug-only bundle was admitted");
		assert(admit(store, "traces").length === 0, "traces admitted a bundle without a reviewed transcript");
		passed.push("admission: debug-only bundles never enter, whatever the index says");

		const out = join(root, "out");
		const result = build({ store, release: "r1", out, kind: "mechanics" });
		assert(result.traces === 22, `built ${result.traces} traces`);
		const published: Array<{ name: string; text: string }> = [];
		const walk = (dir: string, rel = ""): void => {
			for (const name of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, name.name);
				if (name.isDirectory()) walk(path, `${rel}${name.name}/`);
				else if (name.name.endsWith(".tar.gz")) {
					const bytes = readFileSync(path);
					assert(verifyShareArchive(bytes).failure === null, `${rel}${name.name} does not verify`);
					for (const inner of unpackTelemetryArchive(bytes))
						published.push({ name: `${rel}${name.name}/${inner.path}`, text: inner.bytes.toString("utf8") });
				} else published.push({ name: `${rel}${name.name}`, text: readFileSync(path, "utf8") });
			}
		};
		walk(out);
		passed.push("every published scope verifies");
		const all = published.map((file) => file.text).join("\n");
		for (const id of linkingValues(admitted)) assert(!all.includes(id), `${id} survived`);
		for (const id of debugOnly) assert(!all.includes(id), `debug-only ${id} appears`);
		assert(!/rpt_[0-9A-Z]{26}/u.test(all), "a report id survived");
		const times = all.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu) ?? [];
		assert(times.length > 0 && times.every((time) => time < "2000-01-02"), "a timestamp after 2000-01-02 survived");
		for (const id of [SELF_CALL_ID, SELF_RUN_ID]) assert(!all.includes(id), `minted id ${id} survived`);
		// The exporter's own seal is minted at build time, which dates the release, not the reporter.
		const seals = new Set(
			all
				.split("\n")
				.filter((line) => line.includes('"share.sealed"'))
				.flatMap((line) => line.match(/rec_[0-9a-f-]{36}/gu) ?? []),
		);
		const reported = all
			.split("\n")
			.filter((line) => !line.includes('"share.sealed"'))
			.join("\n")
			.replace(/rec_[0-9a-f-]{36}/gu, (id) => (seals.has(id) ? "" : id));
		for (const hit of reported.matchAll(/\b[a-z]{3}_([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-/gu))
			assert(
				Number.parseInt(`${hit[1]}${hit[2]}`, 16) < EPOCH + 86_400_000,
				`a UUIDv7 id decodes after 2000-01-02: ${reported.slice(Math.max(0, (hit.index ?? 0) - 10), (hit.index ?? 0) + 120).replace(/\s+/gu, " ")}`,
			);
		for (const [stamp] of all.matchAll(/\b\d{8}T\d{6}Z(?=-[0-9a-f]{6})/gu))
			assert(stamp < "20000102", `a compact-UTC run id after 2000-01-02 survived: ${stamp}`);
		passed.push("unlinking: no report id, original anonymous, scope or install id, or real timestamp survives");
		const epochs = [...all.matchAll(/"(\w+)":(\d{12,13})\b/gu)];
		assert(
			epochs.some(([, key]) => key === "monoEpochWallMs") && epochs.every(([, , ms]) => Number(ms) < EPOCH + 86_400_000),
			`an epoch-ms value after 2000-01-02 survived: ${epochs
				.filter(([, , ms]) => Number(ms) >= EPOCH + 86_400_000)
				.map(([m]) => m)
				.slice(0, 5)
				.join(" ")}`,
		);
		assert(result.ambiguous.length === 0, `ambiguous epoch fields: ${result.ambiguous.join(", ")}`);
		passed.push("epoch-ms values under time-shaped keys are shifted too");
		assert(!all.includes(rareModel), "the rare model id survived");
		assert(
			all.includes("rare_model") && all.includes("zqx-common-model"),
			"rare_model replacement or common model missing",
		);
		passed.push("rare values: a model in 3 of 22 traces is rare_model everywhere");

		const withdrawn = admitted[3]?.line.reportId as string;
		const releases = withdraw(store, withdrawn);
		assert(releases.length === 1 && releases[0]?.release === "r1", "withdraw did not name the release");
		const second = join(root, "out2");
		build({ store, release: "r2", out: second, kind: "mechanics" });
		const map = readFileSync(join(store, "releases", "r2", "private-map.jsonl"), "utf8");
		assert(!map.includes(withdrawn), "a withdrawn report was rebuilt");
		passed.push("withdraw names the releases holding the trace and the next build omits it");

		withdraw(store, admitted[4]?.line.reportId as string);
		withdraw(store, admitted[5]?.line.reportId as string);
		let refused = "";
		try {
			build({ store, release: "r3", out: join(root, "out3"), kind: "mechanics" });
		} catch (error) {
			refused = error instanceof Error ? error.message : String(error);
		}
		assert(/19 bundles admitted/u.test(refused), `19 admitted did not refuse: ${refused || "built"}`);
		passed.push("19 admitted bundles refuse with the reason");
		return passed;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
	const [verb] = argv;
	if (verb === "--self-check") {
		for (const line of await selfCheck()) process.stdout.write(`ok ${line}\n`);
		return 0;
	}
	const store = flag(argv, "--store");
	if (verb === "build" && store) {
		const release = flag(argv, "--release");
		const out = flag(argv, "--out");
		const kind = flag(argv, "--kind") ?? "mechanics";
		if (!release || !out || (kind !== "mechanics" && kind !== "traces"))
			throw new Error("build needs --release, --out and --kind mechanics|traces");
		const identitiesFile = flag(argv, "--identities");
		const identities = identitiesFile ? (JSON.parse(readFileSync(identitiesFile, "utf8")) as LocalIdentity[]) : [];
		const result = build({ store, release, out, kind, identities });
		process.stdout.write(`built ${result.traces} ${kind} traces in ${result.out}; nothing was published\n`);
		if (result.ambiguous.length > 0)
			process.stdout.write(
				`epoch-like numbers under keys left unshifted, review before publishing: ${result.ambiguous.join(", ")}\n`,
			);
		return 0;
	}
	const reportId = argv[argv.length - 1];
	if (verb === "withdraw" && store && reportId) {
		const found = withdraw(store, reportId);
		process.stdout.write(`${reportId} is excluded from every later release\n`);
		for (const { release, traceId } of found) process.stdout.write(`published in ${release} as ${traceId}\n`);
		return 0;
	}
	process.stderr.write(
		"usage: report-dataset.ts build --store <dir> --release <name> --out <dir> [--kind mechanics|traces] [--identities <file>]\n" +
			"       report-dataset.ts withdraw --store <dir> <reportId>\n       report-dataset.ts --self-check\n",
	);
	return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		},
	);
