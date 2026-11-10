import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { resolvePackageRoot } from "../../core/package-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { FailureCause, vocabulary } from "../../core/telemetry/enums.js";
import { createRedactionTally, redactSecretsText } from "../evidence/index.js";
import {
	filterEntriesToActivePath,
	type MessageEntry,
	projectMessage,
	readSessionEntriesForId,
	type SessionEntry,
} from "../session/index.js";
import {
	freshShareSource,
	packShare,
	packTelemetryArchive,
	planShare,
	resolveShareScopes,
	type ShareArchiveEntry,
	unpackTelemetryArchive,
	verifyShareArchive,
} from "../telemetry/index.js";
import { canaryRefusal, canaryScan } from "./canary.js";
import { REPORT_ID, type ReportDraft } from "./draft.js";
import { outboxEntry, readOutbox, updateOutbox } from "./outbox.js";
import { type LocalIdentity, scrubText } from "./scrub.js";
import { reportsDirectory } from "./store.js";
import { REPORT_AUTONOMY, REPORT_INSTALL_KINDS, REPORT_KINDS, REPORT_SURFACES, REPORT_TRIGGERS } from "./vocabulary.js";

export const REPORT_BUNDLE_FORMAT = "clio-coder.report.bundle";
export const REPORT_TRANSCRIPT_FORMAT = "clio-coder.report.transcript";
export const CONSENT_SCOPES = ["debug", "dataset"] as const;
export type ConsentScope = (typeof CONSENT_SCOPES)[number];
/** At least one scope: a bundle is never built without the reporter's restated consent. */
export type ConsentScopes = readonly [ConsentScope, ...ConsentScope[]];
export type BundleContent = "none" | "transcript";
export const CONSENT_TEXT_VERSION = 1;
export const TRANSCRIPT_TURNS_DEFAULT = 3;
export const TRANSCRIPT_TURNS_MAX = 10;
/** A bundle stays in the reports directory this long after it was sent (D-REPORT 5.8). */
export const BUNDLE_RETENTION_DAYS = 30;

const MEMBER_ENVELOPE = "report.json";
const MEMBER_TELEMETRY = "telemetry.tar.gz";
const MEMBER_TRANSCRIPT = "transcript.jsonl";
const DAY_MS = 24 * 60 * 60 * 1000;

/** What a bundle keeps, shown before the reporter agrees (D-REPORT 5.2). Fixed text: it does not depend on the bundle. */
export const BUNDLE_KEPT: ReadonlyArray<string> = [
	"Call mechanics: disposition, stop reason, failure cause, stages and timings, transport, usage, cache verdict, retries.",
	"Turn and run settlement: stop reason, terminal cause and stage, outcome and exit codes, tool counts by built-in tool name.",
	"Routing: mode, posture, verdict, rejection reasons, built-in runtime ids.",
	"Safety and context: decision classes, rule ids as anonymous names, compaction outcomes, prune and recall counts.",
	"Process: boot phases and durations, health samples, domain load results, exit code.",
	"Structure: prompt section ids and token estimates, tool schemas without descriptions, settings field names.",
	"Versions and the environment block.",
];

export const BUNDLE_NEVER_KEPT: ReadonlyArray<string> = [
	"Prompts, model text, thinking, tool arguments and output, unless the transcript is ticked.",
	"File contents, diffs, commit messages.",
	"Absolute or relative paths, repository names and remotes, branch names.",
	"Host and user names, endpoint URLs, target ids, agent, rule and hook names, environment variables.",
	"Anything a schema does not bound.",
];

// ---------------------------------------------------------------------------------------------------------------
// Envelope

const HASH = Type.String({ pattern: "^[0-9a-f]{64}$" });
const SCOPE_ID = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_:-]*$" });
/** A harness vocabulary word: what the share projection leaves readable as a token, tool or runtime name. */
const NAME = Type.String({ pattern: "^[A-Za-z][A-Za-z0-9_.:-]*$" });
/** A model id that names no location: no whitespace, no backslash, no scheme. */
const MODEL_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9_.:@+/-]*$";
const MODEL = Type.String({ pattern: MODEL_ID_PATTERN });
const nullable = <T extends Parameters<typeof Type.Union>[0][number]>(schema: T) => Type.Union([schema, Type.Null()]);
const closed = { additionalProperties: false } as const;

const ANON_KINDS = ["host", "user", "path", "endpoint", "config", "model", "literal", "id", "name"] as const;

/**
 * The envelope of a report bundle (R-17): why it was sent, what it may be used for, and what it carries. Every string
 * is a vocabulary, a pattern-bound id or a hash, so the envelope leaves the machine verbatim; the boundary check runs
 * the share soundness walk over it.
 */
export const REPORT_BUNDLE_ENVELOPE_SCHEMA = Type.Object(
	{
		format: Type.Literal(REPORT_BUNDLE_FORMAT),
		version: Type.Literal(1),
		reportId: Type.String({ pattern: REPORT_ID.source }),
		createdOn: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" }),
		kind: vocabulary(REPORT_KINDS),
		trigger: vocabulary(REPORT_TRIGGERS),
		cause: nullable(FailureCause),
		fingerprint: nullable(Type.String({ pattern: "^fp_[0-9a-f]{12}$" })),
		environment: Type.Object(
			{
				clioCoder: Type.String({ pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?$" }),
				platform: Type.String({ pattern: "^[a-z0-9]+-[a-z0-9]+$" }),
				node: Type.String({ pattern: "^[0-9]+\\.[0-9]+$" }),
				install: vocabulary(REPORT_INSTALL_KINDS),
				surface: vocabulary(REPORT_SURFACES),
				autonomy: nullable(vocabulary(REPORT_AUTONOMY)),
				runtime: nullable(NAME),
				model: nullable(MODEL),
			},
			closed,
		),
		consent: Type.Object(
			{
				scopes: Type.Array(vocabulary(CONSENT_SCOPES), { minItems: 1, uniqueItems: true }),
				content: vocabulary(["none", "transcript"] as const),
				textVersion: Type.Literal(CONSENT_TEXT_VERSION),
				textSha256: HASH,
				grantedAt: Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$" }),
			},
			closed,
		),
		selection: Type.Object(
			{
				sessions: Type.Array(SCOPE_ID),
				runs: Type.Array(SCOPE_ID),
				process: nullable(SCOPE_ID),
				snapshot: vocabulary(["live", "sealed"] as const),
			},
			closed,
		),
		inventory: Type.Object(
			{
				readable: Type.Object(
					{ model: Type.Array(MODEL), runtime: Type.Array(NAME), tool: Type.Array(NAME), token: Type.Array(NAME) },
					closed,
				),
				anonymized: Type.Object(
					Object.fromEntries(ANON_KINDS.map((kind) => [kind, Type.Optional(Type.Integer({ minimum: 0 }))])),
					closed,
				),
				withheld: Type.Integer({ minimum: 0 }),
			},
			closed,
		),
		telemetrySha256: HASH,
		transcriptSha256: nullable(HASH),
	},
	closed,
);
export type ReportBundleEnvelope = Static<typeof REPORT_BUNDLE_ENVELOPE_SCHEMA>;

// ---------------------------------------------------------------------------------------------------------------
// Consent text

function sha256(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function consentFile(): Buffer {
	return readFileSync(join(resolvePackageRoot(), "src", "domains", "report", "consent", `v${CONSENT_TEXT_VERSION}.md`));
}

/** The sentences shown on the send step for each scope and the transcript tick, from the shipped consent file. */
export function consentText(): { version: number; sha256: string; debug: string; dataset: string; transcript: string } {
	const bytes = consentFile();
	const sections = new Map<string, string>();
	let name: string | null = null;
	let lines: string[] = [];
	const close = () => {
		if (name !== null) sections.set(name, lines.join(" ").replace(/\s+/gu, " ").trim());
	};
	for (const line of bytes.toString("utf8").split("\n")) {
		const heading = /^## (\w+)$/u.exec(line);
		if (heading) {
			close();
			name = heading[1] ?? null;
			lines = [];
		} else if (name !== null) lines.push(line);
	}
	close();
	const section = (key: string): string => {
		const text = sections.get(key);
		if (!text) throw new Error(`the consent text has no "${key}" section`);
		return text;
	};
	return {
		version: CONSENT_TEXT_VERSION,
		sha256: sha256(bytes),
		debug: section("debug"),
		dataset: section("dataset"),
		transcript: section("transcript"),
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Transcript excerpt

const REASONING_BLOCKS: ReadonlySet<unknown> = new Set(["thinking", "redacted_thinking", "reasoning"]);
const OMITTED_ARGS = "[omitted: tool arguments]";
const OMITTED_OUTPUT = "[omitted: tool output]";

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	const content = (value as { content?: unknown } | null)?.content;
	if (Array.isArray(content) && content.every((block) => typeof block?.text === "string" || block?.type !== "text")) {
		const texts = content.filter((block) => block?.type === "text").map((block) => block.text as string);
		if (texts.length === content.length) return texts.join("\n");
	}
	return JSON.stringify(value ?? null) ?? "null";
}

export interface TranscriptExcerpt {
	bytes: Buffer;
	turns: number;
	of: number;
	lines: number;
}

/**
 * The last turns of the session ledger's current branch, each message through `projectMessage`, then secret
 * redaction, then the report scrubber. Operator and assistant text and tool call names are kept; tool arguments and
 * results only with `toolOutput`. Every part left out is a placeholder line or block, so the excerpt never looks
 * complete when it is not.
 */
export function transcriptExcerpt(
	entries: ReadonlyArray<SessionEntry>,
	options: { turns: number; toolOutput: boolean; identity: LocalIdentity; leafTurnId?: string },
): TranscriptExcerpt {
	const tally = createRedactionTally();
	const clean = (text: string): string => scrubText(redactSecretsText(text, tally), options.identity).text;
	const active = filterEntriesToActivePath(entries, options.leafTurnId);
	const userAt = active.flatMap((entry, index) => (entry.kind === "message" && entry.role === "user" ? [index] : []));
	const turns = Math.min(options.turns, userAt.length);
	const start = turns === 0 ? active.length : (userAt[userAt.length - turns] ?? 0);
	const lines: Array<Record<string, unknown>> = [
		{ format: REPORT_TRANSCRIPT_FORMAT, version: 1, turns, of: userAt.length, toolOutput: options.toolOutput },
	];
	if (start > 0) lines.push({ omitted: "earlier entries", count: start });
	for (const entry of active.slice(start)) {
		if (entry.kind !== "message") {
			lines.push({ omitted: entry.kind });
			continue;
		}
		const line = messageLine(entry, options.toolOutput, clean);
		lines.push(line);
	}
	const bytes = Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	return { bytes, turns, of: userAt.length, lines: lines.length };
}

function messageLine(
	entry: MessageEntry,
	toolOutput: boolean,
	clean: (text: string) => string,
): Record<string, unknown> {
	const projection = projectMessage(entry);
	if (projection === null || entry.role === "system") return { omitted: entry.role };
	const incomplete = projection.complete ? {} : { incomplete: true };
	const material = projection.material;
	switch (entry.role) {
		case "user":
			return { role: "user", text: clean(projection.exact ?? textOf(material.text)), ...incomplete };
		case "assistant": {
			const raw = (entry.payload as { content?: unknown } | null)?.content;
			const thinking = Array.isArray(raw) ? raw.filter((block) => REASONING_BLOCKS.has(block?.type)).length : 0;
			const content: Array<Record<string, unknown>> = [];
			if (thinking > 0) content.push({ type: "omitted", part: "thinking", count: thinking });
			const blocks = Array.isArray(material.content) ? (material.content as Array<Record<string, unknown>>) : [];
			if (blocks.length === 0 && typeof material.text === "string")
				content.push({ type: "text", text: clean(material.text) });
			for (const block of blocks) {
				if (block.type === "text" && typeof block.text === "string")
					content.push({ type: "text", text: clean(block.text) });
				else if (block.type === "toolCall")
					content.push({
						type: "toolCall",
						name: clean(String(block.name ?? "")),
						arguments: toolOutput ? clean(textOf(block.arguments)) : OMITTED_ARGS,
					});
				else content.push({ type: "omitted", part: "block" });
			}
			return { role: "assistant", content, ...incomplete };
		}
		case "tool_call":
			return {
				role: "tool_call",
				name: clean(String(material.name ?? "")),
				arguments: toolOutput ? clean(textOf(material.args)) : OMITTED_ARGS,
				...incomplete,
			};
		case "tool_result":
			return {
				role: "tool_result",
				name: clean(String(material.toolName ?? "")),
				isError: material.isError === true,
				result: toolOutput ? clean(textOf(material.result)) : OMITTED_OUTPUT,
				...incomplete,
			};
		default:
			return { omitted: entry.role };
	}
}

// ---------------------------------------------------------------------------------------------------------------
// Build

export interface BundleOptions {
	/** Required on every call: there is no standing consent (D-REPORT 5.7). */
	consent: { scopes: ConsentScopes };
	/** Include the conversation excerpt: the last `turns` turns (default 3, at most 10). */
	transcript?: { turns?: number; toolOutput?: boolean };
	identity: LocalIdentity;
	stateDir: string;
	/** Flush the live telemetry journals before they are read (R-15). */
	flush?: () => Promise<void>;
	/** The running process's telemetry scope, shared as a live snapshot. */
	process?: string | null;
	models?: "keep" | "anonymize";
	writer?: { clioCoderVersion: string; piVersion: string };
	now?: Date;
	/** Write the bundle under the reports directory and record it in the outbox. Default true. */
	write?: boolean;
}

export interface BundleSummary {
	bytes: number;
	records: number;
	scopes: number;
	readable: ReportBundleEnvelope["inventory"]["readable"];
	anonymized: ReportBundleEnvelope["inventory"]["anonymized"];
	withheld: number;
	content: BundleContent;
	/** Turns in the excerpt and in the session, when the transcript is included. */
	transcript: { turns: number; of: number; toolOutput: boolean } | null;
	scopesGranted: ConsentScope[];
	kept: ReadonlyArray<string>;
	neverKept: ReadonlyArray<string>;
}

export interface BuiltBundle {
	/** Null when the bundle was built without writing it. */
	path: string | null;
	sha256: string;
	bytes: Buffer;
	members: ShareArchiveEntry[];
	envelope: ReportBundleEnvelope;
	summary: BundleSummary;
}

export function reportBundlesDirectory(stateDir: string): string {
	return join(reportsDirectory(stateDir), "bundles");
}

export function reportBundlePath(stateDir: string, id: string): string {
	if (!REPORT_ID.test(id)) throw new Error(`not a report id: ${id}`);
	return join(reportBundlesDirectory(stateDir), `${id}.tar.gz`);
}

function packageWriter(): { clioCoderVersion: string; piVersion: string } {
	const pkg = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8")) as {
		version: string;
		dependencies?: Record<string, string>;
	};
	return { clioCoderVersion: pkg.version, piVersion: pkg.dependencies?.["@earendil-works/pi-ai"] ?? "unknown" };
}

function consentScopes(value: unknown): ConsentScope[] {
	if (!Array.isArray(value) || value.length === 0)
		throw new Error("the bundle was not built: no consent scope was given; debug is the least a bundle needs");
	const scopes = [...new Set(value)];
	for (const scope of scopes)
		if (!(CONSENT_SCOPES as ReadonlyArray<unknown>).includes(scope))
			throw new Error(`the bundle was not built: unknown consent scope ${String(scope)}`);
	return CONSENT_SCOPES.filter((scope) => scopes.includes(scope));
}

function envelopeProblem(envelope: unknown): string | null {
	const error = Value.Errors(REPORT_BUNDLE_ENVELOPE_SCHEMA, envelope)[0];
	if (!error) return null;
	const where = error.instancePath || "/";
	if (where.startsWith("/inventory/readable/model"))
		return `a model id the envelope cannot carry is readable (${where}); build it with models anonymized`;
	return `the envelope does not match its schema at ${where}: ${error.message}`;
}

/**
 * Build a report bundle (R-17): a share archive of the reported session under the `report` profile, verified, an
 * envelope saying what the reporter agreed to, and the transcript excerpt only when asked. Every member passes the
 * canary scan (R-19) before anything is written. Any failed check throws with its reason and leaves no bundle file;
 * a rebuild first removes the previous one.
 */
export async function buildBundle(draft: ReportDraft, options: BundleOptions): Promise<BuiltBundle> {
	const scopesGranted = consentScopes((options.consent as { scopes?: unknown } | undefined)?.scopes);
	const write = options.write !== false;
	if (write) deleteReportBundle(options.stateDir, draft.id);
	const now = options.now ?? new Date();
	if (draft.sessionId === null) throw new Error("the bundle was not built: the report names no session");
	await options.flush?.();
	const resolved = resolveShareScopes(options.stateDir, {
		sessions: [draft.sessionId],
		runs: [],
		processes: options.process ? [options.process] : [],
		repo: null,
		since: null,
		until: null,
		live: "snapshot",
	});
	if (!resolved.scopes.some((scope) => scope.kind === "session" && scope.id === draft.sessionId)) {
		const skip = resolved.skipped.find((scope) => scope.kind === "session" && scope.id === draft.sessionId);
		throw new Error(`the bundle was not built: the session's telemetry cannot be shared: ${skip?.reason ?? "missing"}`);
	}
	const plan = planShare({
		scopes: resolved.scopes,
		skipped: resolved.skipped,
		profile: "report",
		source: freshShareSource(),
		writer: options.writer ?? packageWriter(),
		now,
		models: options.models ?? "keep",
		inventory: true,
	});
	const telemetry = packShare(plan);
	const failure = verifyShareArchive(telemetry).failure;
	if (failure !== null) throw new Error(`the bundle was not built: the telemetry archive does not verify: ${failure}`);

	let transcript: TranscriptExcerpt | null = null;
	if (options.transcript) {
		const turns = options.transcript.turns ?? TRANSCRIPT_TURNS_DEFAULT;
		if (!Number.isInteger(turns) || turns < 1 || turns > TRANSCRIPT_TURNS_MAX)
			throw new Error(`the bundle was not built: transcript turns must be 1 to ${TRANSCRIPT_TURNS_MAX}`);
		const read = await readSessionEntriesForId(options.stateDir, draft.sessionId);
		if (read.missing) throw new Error("the bundle was not built: the session ledger was not found");
		transcript = transcriptExcerpt(read.entries, {
			turns,
			toolOutput: options.transcript.toolOutput === true,
			identity: options.identity,
			...(read.leafTurnId !== undefined ? { leafTurnId: read.leafTurnId } : {}),
		});
	}

	const inventory = plan.inventory ?? {
		readable: { model: [], runtime: [], tool: [], token: [] },
		anonymized: {},
		withheld: 0,
	};
	const consent = consentText();
	const environment = draft.environment;
	const scopeIds = (kind: string) => plan.scopes.filter((scope) => scope.kind === kind).map((scope) => scope.id);
	const envelope: ReportBundleEnvelope = {
		format: REPORT_BUNDLE_FORMAT,
		version: 1,
		reportId: draft.id,
		createdOn: now.toISOString().slice(0, 10),
		kind: draft.kind,
		trigger: draft.trigger,
		cause: Value.Check(FailureCause, draft.cause) ? draft.cause : null,
		fingerprint: draft.fingerprint,
		environment: {
			clioCoder: environment.clioCoder,
			platform: environment.platform,
			node: environment.node,
			install: environment.install,
			surface: environment.surface,
			autonomy: environment.autonomy,
			runtime: environment.runtime,
			model:
				options.models !== "anonymize" && draft.includeModel && environment.model !== null
					? new RegExp(MODEL_ID_PATTERN, "u").test(environment.model)
						? environment.model
						: null
					: null,
		},
		consent: {
			scopes: scopesGranted,
			content: transcript ? "transcript" : "none",
			textVersion: CONSENT_TEXT_VERSION,
			textSha256: consent.sha256,
			grantedAt: now.toISOString(),
		},
		selection: {
			sessions: scopeIds("session"),
			runs: scopeIds("run"),
			process: scopeIds("process")[0] ?? null,
			snapshot: plan.scopes.some((scope) => scope.snapshotAt !== undefined) ? "live" : "sealed",
		},
		inventory: { readable: inventory.readable, anonymized: inventory.anonymized, withheld: inventory.withheld },
		telemetrySha256: sha256(telemetry),
		transcriptSha256: transcript ? sha256(transcript.bytes) : null,
	};
	const problem = envelopeProblem(envelope);
	if (problem !== null) throw new Error(`the bundle was not built: ${problem}`);

	const members: ShareArchiveEntry[] = [
		{ path: MEMBER_ENVELOPE, bytes: Buffer.from(`${JSON.stringify(envelope, null, "\t")}\n`) },
		{ path: MEMBER_TELEMETRY, bytes: telemetry },
		...(transcript ? [{ path: MEMBER_TRANSCRIPT, bytes: transcript.bytes }] : []),
	];
	const hits = canaryScan(
		members.map((member) => ({ name: member.path, bytes: member.bytes })),
		options.identity,
		{ stateDir: options.stateDir },
	);
	if (hits.length > 0) throw new Error(canaryRefusal(hits));

	const bytes = packTelemetryArchive(members, Math.floor(now.getTime() / 1000));
	const hash = sha256(bytes);
	const built: BuiltBundle = {
		path: null,
		sha256: hash,
		bytes,
		members,
		envelope,
		summary: {
			bytes: bytes.length,
			records: plan.scopes.reduce((sum, scope) => sum + scope.records, 0),
			scopes: plan.scopes.length,
			readable: envelope.inventory.readable,
			anonymized: envelope.inventory.anonymized,
			withheld: envelope.inventory.withheld,
			content: envelope.consent.content,
			transcript: transcript
				? { turns: transcript.turns, of: transcript.of, toolOutput: options.transcript?.toolOutput === true }
				: null,
			scopesGranted,
			kept: BUNDLE_KEPT,
			neverKept: BUNDLE_NEVER_KEPT,
		},
	};
	return write ? saveBuiltBundle(options.stateDir, draft, built, now) : built;
}

/**
 * Keep a bundle built without writing it: the file at 0600 and its sha256, scopes and content in the outbox. A surface
 * calls this only once the reporter has seen the bundle's summary and consent text and chosen to send or save.
 */
export function saveBuiltBundle(
	stateDir: string,
	draft: Pick<ReportDraft, "id" | "kind" | "title">,
	built: BuiltBundle,
	now: Date = new Date(),
): BuiltBundle {
	if (built.envelope.reportId !== draft.id)
		throw new Error(`the bundle is for ${built.envelope.reportId}, not ${draft.id}`);
	sweepReportBundles(stateDir, now);
	deleteReportBundle(stateDir, draft.id);
	const path = reportBundlePath(stateDir, draft.id);
	safeResourceWrite(path, built.bytes, { mode: 0o600 });
	updateOutbox(stateDir, draft.id, {
		kind: draft.kind,
		title: draft.title,
		bundle: { sha256: built.sha256, scopes: built.summary.scopesGranted, content: built.envelope.consent.content },
	});
	return { ...built, path };
}

// ---------------------------------------------------------------------------------------------------------------
// Preview, retention, deletion

export interface BundlePreview {
	sha256: string;
	bytes: number;
	/** The members as the reporter reads them: the envelope, each telemetry member, then the transcript. */
	sections: Array<{ name: string; text: string }>;
}

function prettyJournal(text: string): string {
	return text
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => {
			const frame = line.lastIndexOf("\t#");
			const body = frame >= 0 ? line.slice(0, frame) : line;
			try {
				return JSON.stringify(JSON.parse(body), null, 2);
			} catch {
				return line;
			}
		})
		.join("\n");
}

/** Every member of a bundle as text, from the bytes given: what `v` pages and `report show --bundle` prints. */
export function previewBundle(bytes: Buffer): BundlePreview {
	const sections: BundlePreview["sections"] = [];
	for (const member of unpackTelemetryArchive(bytes)) {
		if (member.path === MEMBER_TELEMETRY) {
			for (const inner of unpackTelemetryArchive(member.bytes))
				sections.push({ name: `${MEMBER_TELEMETRY}/${inner.path}`, text: prettyJournal(inner.bytes.toString("utf8")) });
		} else sections.push({ name: member.path, text: member.bytes.toString("utf8").replace(/\n$/u, "") });
	}
	return { sha256: sha256(bytes), bytes: bytes.length, sections };
}

export function renderBundlePreview(preview: BundlePreview): string {
	const lines = [`bundle sha256 ${preview.sha256}, ${preview.bytes} bytes`];
	for (const section of preview.sections) lines.push("", `==> ${section.name} <==`, section.text);
	return `${lines.join("\n")}\n`;
}

/**
 * The bundle file recorded for a report, read once: its bytes match the hash in the outbox or it is refused. Null when
 * the report has no bundle.
 */
export function readReportBundle(stateDir: string, id: string): Buffer | null {
	const recorded = outboxEntry(stateDir, id)?.bundle ?? null;
	let bytes: Buffer;
	try {
		bytes = readFileSync(reportBundlePath(stateDir, id));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	if (recorded === null) throw new Error(`the bundle for ${id} is not recorded in the outbox`);
	if (sha256(bytes) !== recorded.sha256)
		throw new Error(`the bundle for ${id} does not match the sha256 recorded in the outbox`);
	return bytes;
}

/** Remove a report's bundle file and its outbox record. True when a file was removed. */
export function deleteReportBundle(stateDir: string, id: string): boolean {
	const path = reportBundlePath(stateDir, id);
	const removed = existsSync(path);
	rmSync(path, { force: true });
	const entry = outboxEntry(stateDir, id);
	if (entry?.bundle) updateOutbox(stateDir, id, { kind: entry.kind, title: entry.title, bundle: null });
	return removed;
}

/** Delete bundles sent more than {@link BUNDLE_RETENTION_DAYS} days ago or withdrawn. Returns the report ids. */
export function sweepReportBundles(stateDir: string, now = new Date()): string[] {
	let names: string[];
	try {
		names = readdirSync(reportBundlesDirectory(stateDir));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const outbox = readOutbox(stateDir);
	const swept: string[] = [];
	for (const name of names) {
		const id = name.replace(/\.tar\.gz$/u, "");
		if (id === name || !REPORT_ID.test(id)) continue;
		const entry = outbox[id];
		if (entry === undefined) continue;
		const age = entry.sentAt === null ? Number.NaN : now.getTime() - Date.parse(entry.sentAt);
		if (entry.state === "withdrawn" || age >= BUNDLE_RETENTION_DAYS * DAY_MS) {
			deleteReportBundle(stateDir, id);
			swept.push(id);
		}
	}
	return swept;
}
