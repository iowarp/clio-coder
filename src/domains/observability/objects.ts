import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { safeResourceWriteAsync } from "../../core/safe-resource-write.js";
import type { ObjectRef } from "../../core/telemetry/schemas.js";
import { ObjectRefSchema } from "../../core/telemetry/schemas.js";
import { createRedactionTally, secretRedactingReplacer } from "../evidence/redact.js";
import { canonicalJson } from "../prompts/hash.js";

const maximumBytes = 16 * 1024 * 1024;
type StoredSubject = "prompt-structure" | "tool-schemas";
const hash = Type.String({ pattern: "^[0-9a-f]{64}$" });
const promptStructureSchema = Type.Object(
	{
		sections: Type.Array(
			Type.Object(
				{ id: Type.String(), tokenEstimate: Type.Number({ minimum: 0 }), contentHash: Type.Optional(hash) },
				{ additionalProperties: false },
			),
		),
		fragments: Type.Array(
			Type.Object({ id: Type.String(), contentHash: hash, dynamic: Type.Boolean() }, { additionalProperties: false }),
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
	fragmentManifest: ReadonlyArray<{ id: string; contentHash: string; dynamic: boolean }>;
}) {
	return {
		sections: prompt.sections.map(({ id, tokenEstimate, contentHash }) => ({
			id,
			tokenEstimate,
			...(contentHash === undefined ? {} : { contentHash }),
		})),
		fragments: prompt.fragmentManifest.map(({ id, contentHash, dynamic }) => ({ id, contentHash, dynamic })),
	};
}

async function objectDirectory(sessionDirectory: string, create: boolean): Promise<string | null> {
	const directory = join(sessionDirectory, "objects");
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

/** Cold-path storage only. A reference becomes resolvable only after its redacted preimage is durable (#434). */
export async function storeTelemetryObject(
	sessionDirectory: string,
	subject: StoredSubject,
	value: unknown,
): Promise<ObjectRef> {
	if (subject !== "prompt-structure" && subject !== "tool-schemas")
		throw new Error("telemetry object subject is not enabled for standard capture");
	if (subject === "prompt-structure" && !Value.Check(promptStructureSchema, value))
		throw new Error("telemetry prompt structure contains unsupported fields");
	// Validate before JSON's replacer could silently convert non-finite numbers to null (#434).
	const canonical = canonicalJson(value);
	const redacted = JSON.parse(canonical, secretRedactingReplacer(createRedactionTally()));
	const bytes = canonicalJson(redacted);
	if (Buffer.byteLength(bytes) > maximumBytes) throw new Error("telemetry object exceeds size limit");
	const ref = reference(subject, bytes, "resolvable");
	const directory = await objectDirectory(sessionDirectory, true);
	if (directory === null) throw new Error("telemetry object directory unavailable");
	const path = join(directory, `${ref.id}.json`);
	const existing = await readObjectBytes(path);
	if (existing !== null && existing !== bytes) throw new Error("telemetry object digest collision or corrupt preimage");
	if (existing === null) await safeResourceWriteAsync(path, bytes, { mode: 0o600 });
	return ref;
}

export type TelemetryObjectRead = { kind: "resolved"; value: unknown } | { kind: "commitment" } | { kind: "missing" };

/** Verification never repairs, rewrites, or retires an object another install may own (#434). */
export async function readTelemetryObject(sessionDirectory: string, ref: ObjectRef): Promise<TelemetryObjectRead> {
	if (!Value.Check(ObjectRefSchema, ref)) throw new Error("invalid telemetry object reference");
	if (ref.label === "commitment") return { kind: "commitment" };
	const directory = await objectDirectory(sessionDirectory, false);
	const bytes = directory ? await readObjectBytes(join(directory, `${ref.id}.json`)) : null;
	if (bytes === null) return { kind: "missing" };
	if (reference(ref.subject, bytes, "resolvable").id !== ref.id) throw new Error("telemetry object digest mismatch");
	const value: unknown = JSON.parse(bytes);
	if (canonicalJson(value) !== bytes) throw new Error("telemetry object is not canonical JSON");
	return { kind: "resolved", value };
}
