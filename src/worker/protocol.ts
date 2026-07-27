/**
 * Worker wire protocol: lanes, bounds, and the attestation frame schema.
 *
 * Two lanes cross every transport, and they never share a queue:
 *
 *   - The bulk lane is worker stdout. It carries model and tool events. It is
 *     high volume, and an orchestrator may drop its display-only frames under
 *     pressure.
 *   - The control lane is worker stderr, restricted to lines that carry the
 *     CONTROL_FRAME_PREFIX marker. It carries the announce, heartbeats, and
 *     steer and cancellation acknowledgements. A bulk flood cannot delay it,
 *     and unmarked stderr stays free-form operator diagnostics.
 *
 * Every lane has an explicit byte limit that is enforced on the raw line
 * before JSON parsing, so an oversized or adversarial frame costs a length
 * comparison rather than a parse.
 *
 * This module lives under src/worker because both the worker and the
 * orchestrator need it and src/worker may not value-import src/domains. The
 * orchestrator-facing surface is re-exported from
 * src/domains/dispatch/worker-protocol.ts.
 */

import { createHash } from "node:crypto";

/** Current wire protocol. A peer announcing anything else is not executed. */
export const WORKER_PROTOCOL_VERSION = 1;

/** Marker that promotes one stderr line into the structured control lane. */
export const CONTROL_FRAME_PREFIX = "@clio-control/1 ";

/**
 * Lane bounds. Control frames are small and fixed shape, so their ceiling is
 * tight. The bulk ceiling accommodates one large tool result while still
 * bounding a single allocation. The stdin ceilings bound what an orchestrator
 * may queue toward a worker that stopped reading.
 */
export const WORKER_CONTROL_FRAME_MAX_BYTES = 16 * 1024;
export const WORKER_BULK_FRAME_MAX_BYTES = 4 * 1024 * 1024;
export const WORKER_STDIN_FRAME_MAX_BYTES = 1024 * 1024;
export const WORKER_STDIN_QUEUE_MAX_BYTES = 4 * 1024 * 1024;

/** Orchestrator event-queue ceiling, in frames, before display frames drop. */
export const WORKER_EVENT_QUEUE_MAX_FRAMES = 4096;

/**
 * One observable resource value. Unknown is a distinct state, never a zero or
 * an optimistic guess, so an active hard requirement can refuse it.
 */
export type WorkerResourceValue<T> = { known: true; value: T } | { known: false };

export function knownResource<T>(value: T): WorkerResourceValue<T> {
	return { known: true, value };
}

export const UNKNOWN_RESOURCE: WorkerResourceValue<never> = { known: false };

/** Bounded node resource facts observed by the worker that will execute. */
export interface WorkerResourceFacts {
	/** Operator-configured node labels carried through the spec. */
	labels: ReadonlyArray<string>;
	cpuCount: WorkerResourceValue<number>;
	totalMemoryBytes: WorkerResourceValue<number>;
	freeMemoryBytes: WorkerResourceValue<number>;
	gpuCount: WorkerResourceValue<number>;
	vramBytes: WorkerResourceValue<number>;
	residentModels: WorkerResourceValue<ReadonlyArray<string>>;
}

/** Bound on how much attested resource detail one announce may carry. */
export const WORKER_RESOURCE_LABEL_MAX = 32;
export const WORKER_RESIDENT_MODEL_MAX = 64;

/**
 * Route and node identity attested by the process that will execute the run.
 * The orchestrator compares every field against the approved plan before the
 * worker is allowed to reach a model.
 */
export interface WorkerAttestation {
	protocolVersion: typeof WORKER_PROTOCOL_VERSION;
	specVersion: number;
	pid: number;
	/** Process-group leader id, or null where the platform has no groups. */
	processGroupId: number | null;
	host: string;
	settingsFingerprint: string;
	/** Worker-computed digest of the specification document it received. */
	specDigest: string;
	runtimeId: string;
	targetId: string;
	/** Hash of the resolved endpoint, so no receipt or log carries a raw URL. */
	endpointIdentityHash: string;
	wireModelId: string;
	toolSignature: string;
	resources: WorkerResourceFacts;
}

export type WorkerControlFrame =
	| { kind: "announce"; attestation: WorkerAttestation }
	| { kind: "heartbeat"; at: number }
	| { kind: "steer_ack"; sequence: number }
	| { kind: "cancel_ack"; at: number };

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Canonical endpoint identity. The scheme, host, and port decide whether two
 * routes reach the same model plane; credentials, query, and trailing path
 * separators do not. An unset URL hashes a fixed sentinel so the field is
 * always present and never leaks absence as an empty string.
 */
export function endpointIdentityHash(url: string | undefined): string {
	if (url === undefined || url.trim().length === 0) return sha256Hex("clio.endpoint:none");
	const raw = url.trim();
	let canonical: string;
	try {
		const parsed = new URL(raw);
		const path = parsed.pathname.replace(/\/+$/u, "");
		canonical = `${parsed.protocol}//${parsed.hostname}:${parsed.port}${path}`;
	} catch {
		canonical = raw.replace(/\/+$/u, "");
	}
	return sha256Hex(`clio.endpoint:${canonical}`);
}

/** Digest of one WorkerSpec document, computed identically on both ends. */
export function workerSpecDigest(spec: unknown): string {
	return sha256Hex(`clio.workerSpec:${canonicalJson(spec)}`);
}

/** Stable signature of the effective tool surface a worker will expose. */
export function toolSignatureOf(names: ReadonlyArray<string>): string {
	return sha256Hex(`clio.tools:${[...names].sort().join(",")}`);
}

/**
 * Deterministic JSON with sorted keys. Two peers must agree byte for byte, so
 * property order and undefined handling cannot depend on construction order.
 */
export function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null";
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value))
		return `[${value.map((entry) => (entry === undefined ? "null" : canonicalJson(entry))).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).sort()) {
			const child = record[key];
			if (child === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonicalJson(child)}`);
		}
		return `{${parts.join(",")}}`;
	}
	return "null";
}

export type FrameParseResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Reject an oversized line before it reaches JSON.parse. Byte length, not code
 * unit length, because the limit exists to bound allocation.
 */
export function withinFrameBudget(line: string, maxBytes: number): boolean {
	return Buffer.byteLength(line, "utf8") <= maxBytes;
}

function parseJsonObject(line: string, maxBytes: number, lane: string): FrameParseResult<Record<string, unknown>> {
	if (!withinFrameBudget(line, maxBytes)) {
		return { ok: false, reason: `${lane} frame exceeds ${maxBytes} bytes` };
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { ok: false, reason: `${lane} frame is not JSON` };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: `${lane} frame is not a JSON object` };
	}
	return { ok: true, value: value as Record<string, unknown> };
}

/** Parse one bulk stdout line under the bulk ceiling. */
export function parseBulkFrame(line: string): FrameParseResult<Record<string, unknown>> {
	return parseJsonObject(line, WORKER_BULK_FRAME_MAX_BYTES, "bulk");
}

/** True when a raw stderr line belongs to the structured control lane. */
export function isControlLine(line: string): boolean {
	return line.startsWith(CONTROL_FRAME_PREFIX);
}

/** Serialize one control frame for the stderr control lane. */
export function encodeControlFrame(frame: WorkerControlFrame): string {
	return `${CONTROL_FRAME_PREFIX}${JSON.stringify(frame)}\n`;
}

function readFiniteNumber(record: Record<string, unknown>, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readResourceValue(value: unknown, validate: (raw: unknown) => boolean): WorkerResourceValue<never> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (record.known === false) return { known: false };
	if (record.known !== true || !validate(record.value)) return null;
	return { known: true, value: record.value } as WorkerResourceValue<never>;
}

function isFiniteNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedStringArray(value: unknown, max: number): boolean {
	return Array.isArray(value) && value.length <= max && value.every((entry) => typeof entry === "string");
}

function parseResourceFacts(value: unknown): WorkerResourceFacts | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (!isBoundedStringArray(record.labels, WORKER_RESOURCE_LABEL_MAX)) return null;
	const numeric = ["cpuCount", "totalMemoryBytes", "freeMemoryBytes", "gpuCount", "vramBytes"] as const;
	const parsed: Record<string, unknown> = { labels: [...(record.labels as string[])] };
	for (const key of numeric) {
		const fact = readResourceValue(record[key], isFiniteNumber);
		if (fact === null) return null;
		parsed[key] = fact;
	}
	const residentModels = readResourceValue(record.residentModels, (raw) =>
		isBoundedStringArray(raw, WORKER_RESIDENT_MODEL_MAX),
	);
	if (residentModels === null) return null;
	parsed.residentModels = residentModels;
	return parsed as unknown as WorkerResourceFacts;
}

function parseAttestation(value: unknown): FrameParseResult<WorkerAttestation> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "announce attestation is not an object" };
	}
	const record = value as Record<string, unknown>;
	if (record.protocolVersion !== WORKER_PROTOCOL_VERSION) {
		return { ok: false, reason: `announce protocol version ${String(record.protocolVersion)} is unsupported` };
	}
	const specVersion = readFiniteNumber(record, "specVersion");
	if (specVersion === null) return { ok: false, reason: "announce specVersion must be a finite number" };
	const pid = readFiniteNumber(record, "pid");
	if (pid === null) return { ok: false, reason: "announce pid must be a finite number" };
	const rawPgid = record.processGroupId;
	if (rawPgid !== null && !(typeof rawPgid === "number" && Number.isFinite(rawPgid))) {
		return { ok: false, reason: "announce processGroupId must be a finite number or null" };
	}
	for (const key of ["host", "runtimeId", "targetId", "wireModelId"] as const) {
		if (typeof record[key] !== "string" || (record[key] as string).length === 0) {
			return { ok: false, reason: `announce ${key} must be a non-empty string` };
		}
	}
	for (const key of ["settingsFingerprint", "specDigest", "endpointIdentityHash", "toolSignature"] as const) {
		if (typeof record[key] !== "string" || !HEX_64.test(record[key] as string)) {
			return { ok: false, reason: `announce ${key} must be a sha256 hex digest` };
		}
	}
	const resources = parseResourceFacts(record.resources);
	if (resources === null) return { ok: false, reason: "announce resources are missing or malformed" };
	return {
		ok: true,
		value: {
			protocolVersion: WORKER_PROTOCOL_VERSION,
			specVersion,
			pid,
			processGroupId: typeof rawPgid === "number" ? rawPgid : null,
			host: record.host as string,
			settingsFingerprint: record.settingsFingerprint as string,
			specDigest: record.specDigest as string,
			runtimeId: record.runtimeId as string,
			targetId: record.targetId as string,
			endpointIdentityHash: record.endpointIdentityHash as string,
			wireModelId: record.wireModelId as string,
			toolSignature: record.toolSignature as string,
			resources,
		},
	};
}

/**
 * Parse one marked stderr line into a control frame. The caller has already
 * established that the line carries the marker.
 */
export function parseControlFrame(line: string): FrameParseResult<WorkerControlFrame> {
	if (!isControlLine(line)) return { ok: false, reason: "control frame is missing its lane marker" };
	const body = line.slice(CONTROL_FRAME_PREFIX.length);
	const parsed = parseJsonObject(body, WORKER_CONTROL_FRAME_MAX_BYTES, "control");
	if (!parsed.ok) return parsed;
	const record = parsed.value;
	switch (record.kind) {
		case "announce": {
			const attestation = parseAttestation(record.attestation);
			if (!attestation.ok) return attestation;
			return { ok: true, value: { kind: "announce", attestation: attestation.value } };
		}
		case "heartbeat": {
			const at = readFiniteNumber(record, "at");
			if (at === null) return { ok: false, reason: "heartbeat frame requires a finite at" };
			return { ok: true, value: { kind: "heartbeat", at } };
		}
		case "steer_ack": {
			const sequence = readFiniteNumber(record, "sequence");
			if (sequence === null) return { ok: false, reason: "steer_ack frame requires a finite sequence" };
			return { ok: true, value: { kind: "steer_ack", sequence } };
		}
		case "cancel_ack": {
			const at = readFiniteNumber(record, "at");
			if (at === null) return { ok: false, reason: "cancel_ack frame requires a finite at" };
			return { ok: true, value: { kind: "cancel_ack", at } };
		}
		default:
			return { ok: false, reason: `unknown control frame kind ${String(record.kind)}` };
	}
}

/**
 * Bulk frames whose loss would destroy receipt evidence. Everything else on
 * the bulk lane exists to drive a live display and may be dropped under
 * pressure.
 */
const RECEIPT_BEARING_BULK_TYPES = new Set([
	"message_end",
	"clio_run_outcome",
	"clio_permission_escalated",
	"clio_permission_resolved",
	"clio_steer_received",
	"clio_tool_activity",
	"clio_skill_activation",
	"clio_safety_decision",
	"clio_verification",
	"clio_usage",
	"tool_execution_end",
	"spawn_error",
]);

/** True when dropping this frame would lose evidence a receipt must seal. */
export function isReceiptBearingFrame(value: unknown): boolean {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
	const type = (value as { type?: unknown }).type;
	if (typeof type !== "string") return true;
	return RECEIPT_BEARING_BULK_TYPES.has(type);
}
