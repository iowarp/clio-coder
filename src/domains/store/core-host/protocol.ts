import type { StoreBackendFacts, StoreBlobPut, StoreBlobStat, StoreRefusalReason } from "../types.js";

/**
 * The core host protocol: the parent and a child process that holds the
 * clio-core client talk over the child's stdin and stdout in frames of a
 * 4-byte big-endian length then UTF-8 JSON. Control messages only; bulk bytes
 * travel as file paths. Small enough to implement in Python today and in a
 * Node addon host later.
 */
export const CORE_HOST_MAX_FRAME_BYTES = 1024 * 1024;
export const CORE_HOST_MAX_RECORD_BYTES = 64 * 1024;

/**
 * The ops are exactly the `StoreBackend` methods plus `ping`. Records travel base64.
 * `tag` is the physical CTE tag name (`agentspace/<projectKey>/<tag>`); the host
 * maps data ops on a tag to filesystem-module files under `/<tag>/` and, when
 * `records` is true, to plain CTE blobs. The caller decides `records`: an encoded
 * tag name no longer ends in `/.records`. `listBlobs` pages come back
 * sorted; `listTags` returns the tag names that fully match `pattern`.
 */
export interface CoreHostOps {
	ping: { args: Record<string, never>; result: Record<string, never> };
	facts: { args: Record<string, never>; result: StoreBackendFacts };
	getOrCreateTag: { args: { tag: string }; result: { created: boolean } };
	tagExists: { args: { tag: string }; result: { exists: boolean } };
	listTags: { args: { pattern?: string }; result: { tags: string[] } };
	delTag: { args: { tag: string }; result: Record<string, never> };
	setTagXattr: { args: { tag: string; key: string; value: string }; result: Record<string, never> };
	getTagXattrs: { args: { tag: string }; result: { xattrs: Record<string, string> } };
	/** The size and sha256 of the bytes the host streamed, and the stat of its temp copy before the rename. */
	putBlobFromFile: { args: { tag: string; blob: string; source: string }; result: Omit<StoreBlobPut, "key"> };
	getBlobAsPath: { args: { tag: string; blob: string; destDir: string }; result: { path: string; copied: boolean } };
	putRecordIfAbsent: { args: { tag: string; blob: string; data: string }; result: { outcome: "written" | "exists" } };
	getRecord: { args: { tag: string; blob: string }; result: { data: string | null } };
	statBlob: { args: { tag: string; blob: string; records: boolean }; result: { stat: StoreBlobStat | null } };
	listBlobs: {
		args: { tag: string; records: boolean; pattern?: string; offset: number; limit: number };
		result: { names: string[]; hasMore: boolean };
	};
	delBlob: { args: { tag: string; blob: string; records: boolean }; result: { deleted: boolean } };
}

export type CoreHostOp = keyof CoreHostOps;

export const CORE_HOST_OPS: ReadonlyArray<CoreHostOp> = [
	"ping",
	"facts",
	"getOrCreateTag",
	"tagExists",
	"listTags",
	"delTag",
	"setTagXattr",
	"getTagXattrs",
	"putBlobFromFile",
	"getBlobAsPath",
	"putRecordIfAbsent",
	"getRecord",
	"statBlob",
	"listBlobs",
	"delBlob",
];

/** Ops whose duration scales with object size; the host must send progress frames while they run. */
export const CORE_HOST_BULK_OPS: ReadonlySet<CoreHostOp> = new Set(["putBlobFromFile", "getBlobAsPath"]);

export interface CoreHostRequest {
	id: number;
	/** `shutdown` asks the host to finish and exit; it gets no response. */
	op: CoreHostOp | "shutdown";
	args: Record<string, unknown>;
}

export interface CoreHostHello {
	host: "python" | "node";
	hostVersion: string;
	coreVersion: string;
	pool: string;
	transport: string;
	/** Bindings the host's wheel lacks; their ops answer `unavailable`. */
	missing?: string[];
}

export type CoreHostInbound =
	| { kind: "hello"; hello: CoreHostHello }
	/** `{ hello: null, error }`: the host could not attach and is about to exit. */
	| { kind: "hello-error"; error: string }
	| { kind: "result"; id: number; result: unknown }
	| { kind: "refusal"; id: number; reason: StoreRefusalReason; message: string }
	| { kind: "progress"; id: number; bytes: number };

const REFUSAL_REASONS: ReadonlySet<string> = new Set<StoreRefusalReason>([
	"invalid-name",
	"not-found",
	"exists",
	"not-a-file",
	"is-link",
	"no-space",
	"unavailable",
	"io",
]);

export class CoreHostProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CoreHostProtocolError";
	}
}

export function encodeCoreHostFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value), "utf8");
	if (body.byteLength > CORE_HOST_MAX_FRAME_BYTES)
		throw new CoreHostProtocolError(`frame of ${body.byteLength} bytes exceeds ${CORE_HOST_MAX_FRAME_BYTES}`);
	const head = Buffer.alloc(4);
	head.writeUInt32BE(body.byteLength, 0);
	return Buffer.concat([head, body]);
}

/** Splits a byte stream into decoded JSON values; throws `CoreHostProtocolError` on an oversized or unparsable frame. */
export class CoreHostFrameDecoder {
	#pending: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): unknown[] {
		this.#pending = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk]);
		const values: unknown[] = [];
		while (this.#pending.byteLength >= 4) {
			const length = this.#pending.readUInt32BE(0);
			if (length > CORE_HOST_MAX_FRAME_BYTES)
				throw new CoreHostProtocolError(`frame length ${length} exceeds ${CORE_HOST_MAX_FRAME_BYTES}`);
			if (this.#pending.byteLength < 4 + length) break;
			const body = this.#pending.subarray(4, 4 + length);
			this.#pending = this.#pending.subarray(4 + length);
			try {
				values.push(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)));
			} catch (error) {
				throw new CoreHostProtocolError(`unparsable frame: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return values;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validates one frame from the host; anything else is a protocol violation. */
export function parseCoreHostInbound(value: unknown): CoreHostInbound {
	if (!isRecord(value)) throw new CoreHostProtocolError("frame is not a JSON object");
	if ("hello" in value) {
		const hello = value.hello;
		if (hello === null && typeof value.error === "string") return { kind: "hello-error", error: value.error };
		if (
			!isRecord(hello) ||
			(hello.host !== "python" && hello.host !== "node") ||
			typeof hello.hostVersion !== "string" ||
			typeof hello.coreVersion !== "string" ||
			typeof hello.pool !== "string" ||
			typeof hello.transport !== "string"
		)
			throw new CoreHostProtocolError("malformed hello frame");
		return {
			kind: "hello",
			hello: {
				host: hello.host,
				hostVersion: hello.hostVersion,
				coreVersion: hello.coreVersion,
				pool: hello.pool,
				transport: hello.transport,
				...(Array.isArray(hello.missing) && hello.missing.every((name) => typeof name === "string")
					? { missing: hello.missing as string[] }
					: {}),
			},
		};
	}
	if (!isId(value.id)) throw new CoreHostProtocolError("frame has no valid id");
	if ("progress" in value) {
		if (typeof value.progress !== "number" || !Number.isFinite(value.progress) || value.progress < 0)
			throw new CoreHostProtocolError("malformed progress frame");
		return { kind: "progress", id: value.id, bytes: value.progress };
	}
	if (value.ok === true) return { kind: "result", id: value.id, result: value.result };
	if (value.ok === false) {
		if (typeof value.reason !== "string" || !REFUSAL_REASONS.has(value.reason) || typeof value.message !== "string")
			throw new CoreHostProtocolError("malformed refusal frame");
		return { kind: "refusal", id: value.id, reason: value.reason as StoreRefusalReason, message: value.message };
	}
	throw new CoreHostProtocolError("frame is neither hello, progress nor a response");
}
