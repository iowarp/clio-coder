import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import type { ObjectRef } from "../../core/telemetry/schemas.js";
import { EvidenceFindingsObjectSchema, ObjectRefSchema, RunResultObjectSchema } from "../../core/telemetry/schemas.js";
import { matchesTrace, traceValue } from "../../core/value-trace.js";
import type { RedactionTally } from "../evidence/redact.js";
import { createRedactionTally, secretRedactingReplacer } from "../evidence/redact.js";
import { canonicalJson } from "../prompts/hash.js";
import { redactSecretString } from "../safety/redaction.js";
import type { SessionPromptCompileRecord } from "../session/prompt-manifest.js";
import { telemetryObjectsDirectory } from "./paths.js";

const maximumBytes = 16 * 1024 * 1024;
type StoredSubject =
	| "prompt-structure"
	| "tool-schemas"
	| "prompt-text"
	| "request"
	| "config"
	| "memory-trace"
	| "observation-trace"
	| "run-result"
	| "evidence-findings";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const count = Type.Integer({ minimum: 0 });
const range = Type.Union([Type.Tuple([Type.Integer({ minimum: 1 }), Type.Integer({ minimum: 1 })]), Type.Null()]);
const projectPreloadSchema = Type.Union([
	Type.Null(),
	Type.Object(
		{
			mode: Type.Union([Type.Literal("full"), Type.Literal("partial"), Type.Literal("synopsis"), Type.Literal("none")]),
			chars: count,
			lines: count,
			reason: Type.Union([Type.Literal("size"), Type.Literal("lines"), Type.Literal("no-clio-md"), Type.Null()]),
			nearLimit: Type.Boolean(),
			label: Type.String(),
			includedChars: Type.Optional(count),
			includedLines: Type.Optional(count),
			omittedSupportFragments: Type.Optional(count),
			providerSupportsTools: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
			sources: Type.Optional(
				Type.Array(
					Type.Object(
						{
							path: Type.String(),
							contentHash: hash,
							availableChars: count,
							availableLines: count,
							includedChars: count,
							includedLines: count,
							includedRange: range,
							omittedRange: range,
							omissionReason: Type.Union([Type.Literal("budget"), Type.Null()]),
						},
						{ additionalProperties: false },
					),
				),
			),
		},
		{ additionalProperties: false },
	),
]);
/** A `prompt-structure` object; exported so the share soundness check can walk it against its projection (#434). */
export const PromptStructureObjectSchema = Type.Object(
	{
		sections: Type.Array(
			Type.Object(
				{ id: Type.String(), tokenEstimate: Type.Number({ minimum: 0 }), contentHash: Type.Optional(hash) },
				{ additionalProperties: false },
			),
		),
		fragments: Type.Array(
			Type.Object(
				{ id: Type.String(), relPath: Type.Optional(Type.String()), contentHash: hash, dynamic: Type.Boolean() },
				{ additionalProperties: false },
			),
		),
		compile: Type.Optional(
			Type.Object(
				{
					version: Type.Integer({ minimum: 1 }),
					/** Written by builds before the timestamp moved to the `prompt.compiled` record. */
					at: Type.Optional(Type.String()),
					/** Written by builds before the predecessor hash moved to the `prompt.compiled` record. */
					previousHash: Type.Optional(Type.Union([hash, Type.Null()])),
					systemPromptHash: hash,
					tokenEstimate: Type.Integer({ minimum: 0 }),
					thinkingLevel: Type.Union([Type.String(), Type.Null()]),
					contextWindow: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
					contextWindowSource: Type.Union([Type.String(), Type.Null()]),
					projectPreload: projectPreloadSchema,
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

/**
 * Object subjects that hold content: a share below the research profile drops them, and research retention expires a
 * session's before the records that cite them. A run's `run-result` and `evidence-findings` are written in every mode
 * (#434).
 */
export const CONTENT_SUBJECTS: ReadonlySet<string> = new Set([
	"prompt-text",
	"request",
	"memory-trace",
	"observation-trace",
	"run-result",
	"evidence-findings",
]);

const OBJECT_ID = /^obj_[0-9a-f]{64}$/;

/** Resolvable references anywhere in a record's payload: object id to subject. */
export function collectRefs(value: unknown, refs: Map<string, string>): void {
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

/** Commitments intentionally perform no I/O and make no claim that a preimage is retained (#434). */
export function telemetryCommitment(subject: ObjectRef["subject"], value: unknown): ObjectRef {
	return reference(subject, canonicalJson(value), "commitment");
}

function reference(subject: ObjectRef["subject"], bytes: string, label: ObjectRef["label"]): ObjectRef {
	return {
		label,
		function: "sha256",
		canonicalization: "json-sorted-v1",
		subject,
		id: `obj_${createHash("sha256").update(bytes, "utf8").digest("hex")}`,
	};
}

/**
 * Select structure explicitly: passing a compiled prompt must never persist its text in standard mode (#434). The
 * compile's timestamp and predecessor hash stay out: the object id is a content hash, and a byte-stable recompile must
 * keep its id. The `prompt.compiled` record carries them as `compiledAt` and `previousHash`.
 */
export function telemetryPromptStructure(prompt: {
	sections: ReadonlyArray<{ id: string; tokenEstimate: number; contentHash?: string }>;
	fragmentManifest: ReadonlyArray<{ id: string; relPath?: string; contentHash: string; dynamic: boolean }>;
	compile?: SessionPromptCompileRecord;
}) {
	return {
		sections: prompt.sections.map(({ id, tokenEstimate, contentHash }) => ({
			id,
			tokenEstimate,
			...(contentHash === undefined ? {} : { contentHash }),
		})),
		fragments: prompt.fragmentManifest.map(({ id, relPath, contentHash, dynamic }) => ({
			id,
			contentHash,
			dynamic,
			...(relPath === undefined ? {} : { relPath }),
		})),
		...(prompt.compile
			? {
					compile: {
						version: prompt.compile.version,
						systemPromptHash: prompt.compile.systemPromptHash,
						tokenEstimate: prompt.compile.tokenEstimate,
						thinkingLevel: prompt.compile.thinkingLevel,
						contextWindow: prompt.compile.contextWindow,
						contextWindowSource: prompt.compile.contextWindowSource,
						projectPreload: prompt.compile.projectPreload,
					},
				}
			: {}),
	};
}

async function objectDirectory(scopeDirectory: string, create: boolean): Promise<string | null> {
	const directory = telemetryObjectsDirectory(scopeDirectory);
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
	try {
		const stat = await lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("telemetry objects directory is not a directory");
	} catch (error) {
		if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return directory;
}

async function readObjectBytes(path: string): Promise<string | null> {
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || stat.size > maximumBytes) throw new Error("invalid telemetry object size or type");
			return await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

const promptTextSchema = Type.Object({ text: Type.String() }, { additionalProperties: false });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const contentSchemas: Partial<Record<StoredSubject, TSchema>> = {
	"prompt-structure": PromptStructureObjectSchema,
	"prompt-text": promptTextSchema,
	// A body past the research capture cap keeps only its head, as text (#434).
	request: Type.Union([
		Type.Object({ body: Type.Unknown() }, { additionalProperties: false }),
		Type.Object({ bodyText: Type.String(), truncated: Type.Literal(true) }, { additionalProperties: false }),
	]),
	"memory-trace": Type.Object(
		{ response: Type.String(), userPrompt: Type.String(), reminder: nullableText, error: nullableText },
		{ additionalProperties: false },
	),
	"observation-trace": Type.Object(
		{ event: Type.String(), facts: Type.Record(Type.String(), Type.Unknown()) },
		{ additionalProperties: false },
	),
	"run-result": RunResultObjectSchema,
	"evidence-findings": EvidenceFindingsObjectSchema,
};
const storedSubjects: ReadonlySet<string> = new Set<StoredSubject>([
	"prompt-structure",
	"tool-schemas",
	"prompt-text",
	"request",
	"config",
	"memory-trace",
	"observation-trace",
	"run-result",
	"evidence-findings",
]);

/**
 * Settings are structure, but a `headers` or `env` map carries whatever an operator typed, often a credential no
 * value pattern recognizes (`Authorization: Bearer <opaque>`). The names stay; every value is withheld (#434).
 */
function withheldSecretMaps(value: unknown, key?: string): unknown {
	if (Array.isArray(value)) return value.map((item) => withheldSecretMaps(item));
	if (value === null || typeof value !== "object") return value;
	const entries = Object.entries(value as Record<string, unknown>);
	if ((key === "headers" || key === "env") && entries.every(([, item]) => typeof item === "string"))
		return Object.fromEntries(entries.map(([name]) => [name, `[redacted:${key}]`]));
	return Object.fromEntries(entries.map(([name, item]) => [name, withheldSecretMaps(item, name)]));
}

/**
 * A property that names a credential. Its value is a credential whatever its shape: a passphrase of short words
 * matches no value pattern, and redacting only a credential-shaped prefix left the rest exposed (#434). Plural
 * counts such as `inputTokens` and compounds such as `tokenEstimate` are not credentials.
 */
const CREDENTIAL_PROPERTY =
	/(?:api[_-]?key|password|passwd|passphrase|secret|token|credentials?|authorization|private[_-]?key)$/iu;

/** Every string a credential-named property holds, directly or as a list, is withheld whole. */
function withheldCredentials(value: unknown, tally: RedactionTally, credential = false): unknown {
	if (typeof value === "string") {
		if (!credential || value.startsWith("[redacted:")) return value;
		tally.count += 1;
		return "[redacted:credential]";
	}
	if (Array.isArray(value)) return value.map((item) => withheldCredentials(item, tally, credential));
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, withheldCredentials(item, tally, CREDENTIAL_PROPERTY.test(key))]),
	);
}

const ENV_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;

/**
 * The redaction an object's preimage gets before it is hashed, and a share re-applies to every record and object it
 * exports: a credential-named property's whole value, value patterns, URL userinfo, query credentials and secret
 * flags, and for settings the withheld `headers` and `env` maps (#434).
 */
export function redactTelemetryValue<T>(value: T, tally: RedactionTally, secretMaps: boolean): T {
	const secretValues = secretRedactingReplacer(tally);
	const named = withheldCredentials(secretMaps ? withheldSecretMaps(value) : value, tally);
	return JSON.parse(canonicalJson(named), (key, item: unknown) => {
		if (typeof item !== "string") return item;
		// `auth.apiKeyEnvVar` names an environment variable, not its value; a name shape stays readable, anything else
		// (a key pasted into the field) is still redacted below.
		if (key === "apiKeyEnvVar" && ENV_VARIABLE_NAME.test(item)) return item;
		const scrubbed = redactSecretString(item);
		if (scrubbed !== item) tally.count += 1;
		return secretValues(key, scrubbed);
	}) as T;
}

/**
 * A stored `run-result` as readers use it (C-28). A version 2 record keeps a structured answer once, as its data, and
 * regains `text` here as the data's canonical JSON, reading as version 1; anything else, version 1 records included,
 * reads as it was written. A malformed version 2 record is returned unchanged for the schema check to refuse.
 * Writers still store version 1 so binaries without this reader keep reading the shared state root.
 */
export function readStoredRunResult(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const record = value as { version?: unknown; output?: unknown };
	if (record.version !== 2 || record.output === null || typeof record.output !== "object") return value;
	const output = record.output as { text?: unknown; structured?: unknown };
	const structured = output.structured;
	if (output.text !== undefined || structured === null || typeof structured !== "object") return value;
	const data = (structured as { data?: unknown }).data;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return value;
	try {
		return { ...record, version: 1, output: { ...output, text: canonicalJson(data) } };
	} catch {
		return value;
	}
}

/** The redacted canonical bytes an object stores and the reference they hash to; no I/O. */
function storedPreimage(subject: StoredSubject, value: unknown): { ref: ObjectRef; bytes: string } {
	if (!storedSubjects.has(subject)) throw new Error("telemetry object subject is not enabled for capture");
	const shape = contentSchemas[subject];
	if (shape !== undefined && !Value.Check(shape, value))
		throw new Error(`telemetry ${subject} object contains unsupported fields`);
	// Validate before JSON's replacer could silently convert non-finite numbers to null (#434).
	const bytes = canonicalJson(redactTelemetryValue(value, createRedactionTally(), subject === "config"));
	if (Buffer.byteLength(bytes) > maximumBytes) throw new Error("telemetry object exceeds size limit");
	return { ref: reference(subject, bytes, "resolvable"), bytes };
}

/** Structure every model call stores again, usually unchanged: the request's prompt structure and tool schemas. */
const REQUEST_SUBJECTS: ReadonlySet<StoredSubject> = new Set<StoredSubject>(["prompt-structure", "tool-schemas"]);

type Preimage = ReturnType<typeof storedPreimage>;

/**
 * One writer's preimages. A request subject keeps its last prepared bytes with the trace of the value they came from,
 * and a value with the same keys and leaves reuses them instead of validating, redacting, canonicalizing and hashing
 * again. Content subjects are always prepared afresh and never held. Reuse only skips preparation: storing still
 * reads the object back without following links, compares the bytes and writes a missing one (Astra r8-2).
 */
export function createTelemetryPreimages(): (subject: StoredSubject, value: unknown) => Preimage {
	const last = new Map<StoredSubject, { trace: unknown[]; preimage: Preimage }>();
	return (subject, value) => {
		if (!REQUEST_SUBJECTS.has(subject)) return storedPreimage(subject, value);
		const cached = last.get(subject);
		if (cached && matchesTrace(value, cached.trace)) return cached.preimage;
		const preimage = storedPreimage(subject, value);
		const trace = traceValue(value);
		if (trace) last.set(subject, { trace, preimage });
		else last.delete(subject);
		return preimage;
	};
}

/**
 * The reference an object will store under, computed without storing it: a producer that must name the object before
 * its writer stores it, such as a run's result, cites the same id the store writes (#434).
 */
export function telemetryObjectRef(subject: StoredSubject, value: unknown): ObjectRef {
	return storedPreimage(subject, value).ref;
}

/**
 * Cold-path storage only. A reference becomes resolvable only after its redacted preimage is durable (#434).
 * `prompt-text`, `memory-trace` and `observation-trace` are content: only a caller holding research content
 * capture for the session stores them. `config` is structure and references once its secret maps are withheld.
 * `run-result` is content stored in every mode: a finished run's deliverable, which a share profile drops.
 */
export async function storeTelemetryObject(
	scopeDirectory: string,
	subject: StoredSubject,
	value: unknown,
	prepare: (subject: StoredSubject, value: unknown) => Preimage = storedPreimage,
): Promise<ObjectRef> {
	const { ref, bytes } = prepare(subject, value);
	const directory = await objectDirectory(scopeDirectory, true);
	if (directory === null) throw new Error("telemetry object directory unavailable");
	const path = join(directory, `${ref.id}.json`);
	const existing = await readObjectBytes(path);
	if (existing !== null && existing !== bytes) throw new Error("telemetry object digest collision or corrupt preimage");
	if (existing === null) await safeResourceWriteAsync(path, bytes, { mode: 0o600 });
	return ref;
}

export type TelemetryObjectRead = { kind: "resolved"; value: unknown } | { kind: "commitment" } | { kind: "missing" };

/** Verification never repairs, rewrites, or retires an object another install may own (#434). */
export async function readTelemetryObject(scopeDirectory: string, ref: ObjectRef): Promise<TelemetryObjectRead> {
	if (!Value.Check(ObjectRefSchema, ref)) throw new Error("invalid telemetry object reference");
	if (ref.label === "commitment") return { kind: "commitment" };
	const directory = await objectDirectory(scopeDirectory, false);
	const bytes = directory ? await readObjectBytes(join(directory, `${ref.id}.json`)) : null;
	if (bytes === null) return { kind: "missing" };
	if (reference(ref.subject, bytes, "resolvable").id !== ref.id) throw new Error("telemetry object digest mismatch");
	const value: unknown = JSON.parse(bytes);
	if (canonicalJson(value) !== bytes) throw new Error("telemetry object is not canonical JSON");
	return { kind: "resolved", value: ref.subject === "run-result" ? readStoredRunResult(value) : value };
}

/** Synchronous cold resume uses the same verified preimages as asynchronous surfaces (#434). */
export function readTelemetryObjectSync(scopeDirectory: string, ref: ObjectRef): TelemetryObjectRead {
	if (!Value.Check(ObjectRefSchema, ref)) throw new Error("invalid telemetry object reference");
	if (ref.label === "commitment") return { kind: "commitment" };
	const directory = telemetryObjectsDirectory(scopeDirectory);
	let bytes: string;
	try {
		const stat = lstatSync(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("telemetry objects directory is not a directory");
		const fd = openSync(join(directory, `${ref.id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const file = fstatSync(fd);
			if (!file.isFile() || file.size > maximumBytes) throw new Error("invalid telemetry object size or type");
			bytes = readFileSync(fd, "utf8");
		} finally {
			closeSync(fd);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
		throw error;
	}
	if (reference(ref.subject, bytes, "resolvable").id !== ref.id) throw new Error("telemetry object digest mismatch");
	const parsed: unknown = JSON.parse(bytes);
	if (canonicalJson(parsed) !== bytes) throw new Error("telemetry object is not canonical JSON");
	const value = ref.subject === "run-result" ? readStoredRunResult(parsed) : parsed;
	const schema = contentSchemas[ref.subject as StoredSubject];
	if (schema && !Value.Check(schema, value)) throw new Error("invalid telemetry object shape");
	return { kind: "resolved", value };
}
