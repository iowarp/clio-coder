import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import type { ObjectRef } from "../../core/telemetry/schemas.js";
import { ObjectRefSchema } from "../../core/telemetry/schemas.js";
import { createRedactionTally, secretRedactingReplacer } from "../evidence/redact.js";
import { canonicalJson } from "../prompts/hash.js";
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
	| "observation-trace";
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
const promptStructureSchema = Type.Object(
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
					at: Type.String(),
					previousHash: Type.Union([hash, Type.Null()]),
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

/** Select structure explicitly: passing a compiled prompt must never persist its text in standard mode (#434). */
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
						at: prompt.compile.at,
						previousHash: prompt.compile.previousHash,
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
	"prompt-structure": promptStructureSchema,
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
};
const storedSubjects: ReadonlySet<string> = new Set<StoredSubject>([
	"prompt-structure",
	"tool-schemas",
	"prompt-text",
	"request",
	"config",
	"memory-trace",
	"observation-trace",
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
 * Cold-path storage only. A reference becomes resolvable only after its redacted preimage is durable (#434).
 * `prompt-text`, `memory-trace` and `observation-trace` are content: only a caller holding research content
 * capture for the session stores them. `config` is structure and references once its secret maps are withheld.
 */
export async function storeTelemetryObject(
	scopeDirectory: string,
	subject: StoredSubject,
	value: unknown,
): Promise<ObjectRef> {
	if (!storedSubjects.has(subject)) throw new Error("telemetry object subject is not enabled for capture");
	const shape = contentSchemas[subject];
	if (shape !== undefined && !Value.Check(shape, value))
		throw new Error(`telemetry ${subject} object contains unsupported fields`);
	// Validate before JSON's replacer could silently convert non-finite numbers to null (#434).
	const canonical = canonicalJson(subject === "config" ? withheldSecretMaps(value) : value);
	const redacted = JSON.parse(canonical, secretRedactingReplacer(createRedactionTally()));
	const bytes = canonicalJson(redacted);
	if (Buffer.byteLength(bytes) > maximumBytes) throw new Error("telemetry object exceeds size limit");
	const ref = reference(subject, bytes, "resolvable");
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
	return { kind: "resolved", value };
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
	const value: unknown = JSON.parse(bytes);
	if (canonicalJson(value) !== bytes) throw new Error("telemetry object is not canonical JSON");
	const schema = contentSchemas[ref.subject as StoredSubject];
	if (schema && !Value.Check(schema, value)) throw new Error("invalid telemetry object shape");
	return { kind: "resolved", value };
}
