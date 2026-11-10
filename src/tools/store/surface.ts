import { Type } from "typebox";
import { ToolNames } from "../../core/tool-names.js";
import { StringEnum } from "../../engine/ai.js";
import type { ToolSurface } from "../lazy-tool.js";
import { resolveToCwd } from "../path-utils.js";

/**
 * The `store` capability's immutable surface, kept apart from the backend so
 * the registry attaches the schema and defers the implementation until the
 * first call. The schema is one constant for every op and every backend.
 */

export const STORE_TOOL_NAME = ToolNames.Store;

export const STORE_OPS = ["tags", "create", "list", "stat", "get", "put", "note", "remove"] as const;
export type StoreOp = (typeof STORE_OPS)[number];

const STORE_TAG_CLASSES = ["input", "output", "cache", "archive"] as const;

const DESCRIPTION =
	"A tag is a named container of blobs and a blob is a named byte sequence, the CLIO Core model. " +
	"The store lives outside the working tree and is the same for the main session and every worker of this project. " +
	"op=get returns a readable path to pass unchanged to data, read, run_script or an MCP tool, and may copy on some backends. " +
	"op=stat reports what Clio recorded (size, hash, producing script and inputs) and drift when the bytes differ from the record. " +
	"The facts under backend say what this backend does not offer.";

function numberArg(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim().length > 0) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function refListArg(value: unknown): string[] | undefined {
	const items: unknown[] = typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : [];
	const out = items
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
	return out.length > 0 ? out : undefined;
}

/**
 * Accept the weak-model argument shapes: `file`/`file_path` for `path`,
 * numbers as strings, `derived_from` as a comma-separated string, and
 * `ref: "<tag>:<blob>"` for `tag` plus `blob`, split at the first `:`.
 */
export function prepareStoreArguments(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...args };
	if (typeof out.path !== "string") {
		const alias = out.file ?? out.file_path ?? out.filePath;
		if (typeof alias === "string") out.path = alias;
	}
	if (typeof out.path === "string") out.path = out.path.trim();
	if (typeof out.ref === "string" && typeof out.tag !== "string") {
		const ref = out.ref.trim();
		const colon = ref.indexOf(":");
		if (colon < 0) out.tag = ref;
		else {
			out.tag = ref.slice(0, colon);
			if (typeof out.blob !== "string" && colon + 1 < ref.length) out.blob = ref.slice(colon + 1);
		}
	}
	for (const key of ["offset", "limit"] as const) {
		const parsed = numberArg(out[key]);
		if (parsed !== undefined) out[key] = parsed;
		else if (out[key] !== undefined) delete out[key];
	}
	const derived = refListArg(out.derived_from);
	if (derived !== undefined) out.derived_from = derived;
	else if (out.derived_from !== undefined) delete out.derived_from;
	return out;
}

/** Freeze the normalized call, `path` made absolute, so admission judges exactly what the tool will do. */
export function prepareStoreAdmissionArguments(
	args: Record<string, unknown>,
	cwd = process.cwd(),
): Record<string, unknown> {
	const prepared = prepareStoreArguments(args);
	if (typeof prepared.path === "string" && prepared.path.length > 0) prepared.path = resolveToCwd(prepared.path, cwd);
	return prepared;
}

export const storeToolSurface: ToolSurface = {
	name: STORE_TOOL_NAME,
	description: DESCRIPTION,
	parameters: Type.Object({
		op: StringEnum(STORE_OPS, { description: "tags, create, list, stat, get, put, note, or remove." }),
		tag: Type.Optional(Type.String({ description: "Tag name, e.g. sim/run7. Every op but tags." })),
		blob: Type.Optional(
			Type.String({
				description: "Blob name inside the tag. stat, get, note, remove; put defaults it to the file's basename.",
			}),
		),
		path: Type.Optional(Type.String({ description: "put: the workspace file to store." })),
		pattern: Type.Optional(Type.String({ description: "list: regular expression matched against the whole blob name." })),
		offset: Type.Optional(Type.Number({ description: "list: 0-based first blob (default 0)." })),
		limit: Type.Optional(Type.Number({ description: "list: blobs returned (default 100, max 500)." })),
		description: Type.Optional(Type.String({ description: "create: what the tag holds." })),
		class: Type.Optional(
			StringEnum(STORE_TAG_CLASSES, { description: "create: input, output (default), cache, or archive." }),
		),
		note: Type.Optional(Type.String({ description: "put and note: a note kept in the blob's record." })),
		derived_from: Type.Optional(
			Type.Array(Type.String(), { description: "put and note: the <tag>:<blob> refs this blob was made from." }),
		),
	}),
	baseActionClass: "read",
	executionMode: "sequential",
	prepareArguments: prepareStoreArguments,
	prepareAdmissionArguments: prepareStoreAdmissionArguments,
};
