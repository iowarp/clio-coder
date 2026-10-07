import type { FlowRestrictionSet } from "../core/flow-restrictions.js";
import { isFlowRestrictionSet } from "../core/flow-restrictions.js";
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
 *     cancellation acknowledgements. A bulk flood cannot delay it,
 *     and unmarked stderr stays free-form operator diagnostics.
 *
 * Worker stdin carries the orchestrator's side: the spec line first, then
 * the `admit` verdict on the announce, steers, permission decisions and
 * ledger deltas. The worker starts no model run until `admit` arrives.
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
import { normalizeClioCoderEventRecord } from "../core/naming-events.js";

/** Internal JSON handoffs; artifact and mutation contracts keep their existing delivery paths. */
export const INTERNAL_HELPER_RESULT_KINDS = [
	"mutation-report",
	"scout-report",
	"research-report",
	"world-knowledge-report",
	"provenance-report",
	"oracle-report",
	"context-handbook",
] as const;

/**
 * Current wire protocol. A peer announcing anything else is not executed.
 * Version 2 holds the model run until the orchestrator's `admit` frame; a
 * version 1 worker would start without waiting, so it is refused.
 */
export const WORKER_PROTOCOL_VERSION = 2;

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
 * How long the orchestrator waits, from writing the spec, for an attestation
 * verdict. A worker held for admission produces no bulk output, so the
 * bulk-triggered grace never starts for it; this bound refuses a peer that
 * heartbeats but never announces. It covers a cold module load, a busy node,
 * and an SSH connect (whose own default ConnectTimeout is 10 s).
 */
export const WORKER_ANNOUNCE_DEADLINE_MS = 60_000;

/**
 * How long an announced worker waits for `admit` before it exits unadmitted.
 * The orchestrator answers in the same tick it verifies the announce, so this
 * covers one round trip on a slow channel and nothing else.
 */
export const WORKER_ADMISSION_WAIT_MS = 30_000;

/**
 * Stdin frame the orchestrator writes once it accepts an announce. It names the
 * spec digest the orchestrator approved, and the worker checks it against the
 * digest it attested before it starts the run.
 */
export interface WorkerAdmitFrame {
	type: "admit";
	specDigest: string;
}

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
 * The orchestrator compares every field against the approved plan, and the
 * worker starts no model run until the orchestrator's `admit` frame names the
 * spec digest it attested here.
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

/**
 * The agent ledger is the bounded coordination surface concurrent dispatch
 * workers share. Its wire shapes live here because both the worker and the
 * orchestrator validate them and src/worker may not value-import src/domains.
 *
 * A claim stakes a scope, a finding carries a citation, a review targets an
 * existing entry, and a bounded message carries an intended recipient and an
 * optional reply reference. None of these entries grant execution authority.
 */
export type AgentLedgerBody =
	| { kind: "claim"; scope: ReadonlyArray<string>; intent: string }
	| { kind: "finding"; claim: string; path?: string; line?: number }
	| { kind: "review"; target: string; passed: boolean; evidence: string }
	| { kind: "message"; to: string; text: string; replyTo?: string };

/** Bounds on one posted body. Out-of-bounds input is refused, never truncated. */
export const AGENT_LEDGER_SCOPE_MAX_ENTRIES = 8;
export const AGENT_LEDGER_SCOPE_ENTRY_MAX_CHARS = 200;
export const AGENT_LEDGER_INTENT_MAX_CHARS = 200;
export const AGENT_LEDGER_CLAIM_MAX_CHARS = 400;
export const AGENT_LEDGER_EVIDENCE_MAX_CHARS = 400;
export const AGENT_LEDGER_PATH_MAX_CHARS = 400;

/** `e<sequence>`: short enough that a weak model can retype it from a board. */
const AGENT_LEDGER_ENTRY_ID = /^e[1-9][0-9]*$/;

/** True when a string has the shape of a ledger entry id. */
export function isAgentLedgerEntryId(value: unknown): value is string {
	return typeof value === "string" && AGENT_LEDGER_ENTRY_ID.test(value);
}

export type AgentLedgerBodyParse = { ok: true; body: AgentLedgerBody } | { ok: false; reason: string };

function boundedString(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * The length the model sent, so an over-long body says by how much instead of
 * leaving a weak model to guess how hard to cut. A non-string has no length to report.
 */
function sentLength(value: unknown): string {
	return typeof value === "string" ? `; got ${value.length}` : "";
}

/**
 * The single shared validator. The worker tool calls it to refuse a model
 * synchronously and the orchestrator calls it again at append, because the
 * control lane is one-way and only the orchestrator's verdict is authoritative.
 */
export function parseAgentLedgerBody(value: unknown): AgentLedgerBodyParse {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "ledger body is not an object" };
	}
	const record = value as Record<string, unknown>;
	switch (record.kind) {
		case "message": {
			if (!boundedString(record.to, 200) || !boundedString(record.text, 1000)) {
				return { ok: false, reason: "message requires to (1..200 characters) and text (1..1000 characters)" };
			}
			if (record.replyTo !== undefined && !isAgentLedgerEntryId(record.replyTo)) {
				return { ok: false, reason: "message replyTo must be an entry id such as e3" };
			}
			return {
				ok: true,
				body: {
					kind: "message",
					to: record.to,
					text: record.text,
					...(record.replyTo === undefined ? {} : { replyTo: record.replyTo as string }),
				},
			};
		}
		case "claim": {
			const scope = record.scope;
			if (!Array.isArray(scope) || scope.length === 0) {
				return { ok: false, reason: "claim scope must be a non-empty array of path prefixes" };
			}
			if (scope.length > AGENT_LEDGER_SCOPE_MAX_ENTRIES) {
				return { ok: false, reason: `claim scope exceeds ${AGENT_LEDGER_SCOPE_MAX_ENTRIES} entries` };
			}
			for (const entry of scope) {
				if (!boundedString(entry, AGENT_LEDGER_SCOPE_ENTRY_MAX_CHARS)) {
					return {
						ok: false,
						reason: `claim scope entries must be 1..${AGENT_LEDGER_SCOPE_ENTRY_MAX_CHARS} characters${sentLength(entry)}`,
					};
				}
			}
			if (!boundedString(record.intent, AGENT_LEDGER_INTENT_MAX_CHARS)) {
				return {
					ok: false,
					reason: `claim intent must be 1..${AGENT_LEDGER_INTENT_MAX_CHARS} characters${sentLength(record.intent)}`,
				};
			}
			return { ok: true, body: { kind: "claim", scope: scope.map(String), intent: record.intent } };
		}
		case "finding": {
			if (!boundedString(record.claim, AGENT_LEDGER_CLAIM_MAX_CHARS)) {
				return {
					ok: false,
					reason: `finding claim must be 1..${AGENT_LEDGER_CLAIM_MAX_CHARS} characters${sentLength(record.claim)}`,
				};
			}
			const body: { kind: "finding"; claim: string; path?: string; line?: number } = {
				kind: "finding",
				claim: record.claim,
			};
			if (record.path !== undefined) {
				if (!boundedString(record.path, AGENT_LEDGER_PATH_MAX_CHARS)) {
					return {
						ok: false,
						reason: `finding path must be 1..${AGENT_LEDGER_PATH_MAX_CHARS} characters${sentLength(record.path)}`,
					};
				}
				body.path = record.path;
			}
			if (record.line !== undefined) {
				const line = record.line;
				if (typeof line !== "number" || !Number.isSafeInteger(line) || line <= 0) {
					return { ok: false, reason: "finding line must be a positive safe integer" };
				}
				body.line = line;
			}
			return { ok: true, body };
		}
		case "review": {
			if (!isAgentLedgerEntryId(record.target)) {
				return { ok: false, reason: "review target must be a ledger entry id such as e3" };
			}
			if (typeof record.passed !== "boolean") {
				return { ok: false, reason: "review passed must be a boolean" };
			}
			if (!boundedString(record.evidence, AGENT_LEDGER_EVIDENCE_MAX_CHARS)) {
				return {
					ok: false,
					reason: `review evidence must be 1..${AGENT_LEDGER_EVIDENCE_MAX_CHARS} characters${sentLength(record.evidence)}`,
				};
			}
			return {
				ok: true,
				body: { kind: "review", target: record.target, passed: record.passed, evidence: record.evidence },
			};
		}
		default:
			return { ok: false, reason: `unknown ledger entry kind ${String(record.kind)}` };
	}
}

/**
 * One admitted entry. Every attribution field is stamped by the orchestrator
 * from its own admission record; no worker-supplied value reaches any of them.
 */
export interface AgentLedgerEntry {
	/** `e<sequence>`, unique within one ledger. Weak models must be able to retype it. */
	id: string;
	sequence: number;
	at: string;
	runId: string;
	assignmentId: string;
	agentId: string;
	nodeId: string;
	body: AgentLedgerBody;
	flowRestrictions?: FlowRestrictionSet;
	/** Host-stamped final receipt projection; never supplied by a worker post. */
	source?: "receipt";
	/** Entry ids of live peer claims this claim's scope overlaps. Orchestrator-computed. */
	conflictsWith?: ReadonlyArray<string>;
}

/**
 * Parse one attributed entry off the stdin lane. The worker re-validates what
 * the orchestrator stamped because a mirror that accepted a malformed entry
 * would render it back to the model as if it were an admitted contribution.
 */
export function parseAgentLedgerEntry(value: unknown): AgentLedgerEntry | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const sequence = record.sequence;
	if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) return null;
	if (!isAgentLedgerEntryId(record.id) || record.id !== `e${sequence}`) return null;
	if (record.flowRestrictions !== undefined && !isFlowRestrictionSet(record.flowRestrictions)) return null;
	for (const key of ["at", "runId", "assignmentId", "agentId", "nodeId"] as const) {
		if (typeof record[key] !== "string" || (record[key] as string).length === 0) return null;
	}
	if (record.source !== undefined && record.source !== "receipt") return null;
	const body = parseAgentLedgerBody(record.body);
	if (!body.ok) return null;
	const conflicts = record.conflictsWith;
	if (conflicts !== undefined && !(Array.isArray(conflicts) && conflicts.every(isAgentLedgerEntryId))) return null;
	return {
		id: record.id,
		sequence,
		at: record.at as string,
		runId: record.runId as string,
		assignmentId: record.assignmentId as string,
		agentId: record.agentId as string,
		nodeId: record.nodeId as string,
		body: body.body,
		...(record.source === "receipt" ? { source: "receipt" as const } : {}),
		...(record.flowRestrictions === undefined
			? {}
			: { flowRestrictions: structuredClone(record.flowRestrictions as FlowRestrictionSet) }),
		...(conflicts === undefined ? {} : { conflictsWith: [...(conflicts as string[])] }),
	};
}

/** Stdin frame that pushes newly admitted entries toward one worker's mirror. */
export interface AgentLedgerDeltaFrame {
	type: "ledger_delta";
	entries: ReadonlyArray<AgentLedgerEntry>;
}

/**
 * The port both sides share. `post` is fire and forget over the control lane,
 * so its refusal is the worker-local bound check; `read` answers from the local
 * mirror and returns null when this run has no ledger at all.
 */
export interface AgentLedgerPort {
	post(
		body: AgentLedgerBody,
		flowRestrictions?: FlowRestrictionSet,
	): { ok: true } | { ok: false; reason: string } | Promise<{ ok: true } | { ok: false; reason: string }>;
	read(): { open: boolean; watermark: number; entries: ReadonlyArray<AgentLedgerEntry> } | null;
}

/**
 * A model the worker's own request loaded and pinned. The orchestrator owns the
 * release of worker loads (#379), so the worker reports each one and the
 * orchestrator releases it when it exits. Only ids cross the wire: the
 * orchestrator resolves the endpoint and any headers from its own settings for
 * the admitted target, so no credential ever travels on the control lane.
 */
export interface WorkerModelLoad {
	targetId: string;
	modelId: string;
	/** Other names the server answered for the same model, such as a `:latest` tag. */
	aliasIds: ReadonlyArray<string>;
}

/** Bounds on one model load report. */
export const WORKER_MODEL_LOAD_ID_MAX_CHARS = 256;
export const WORKER_MODEL_LOAD_ALIAS_MAX = 8;

/**
 * One worker ask routed to the main agent (Phase D). It rides the control
 * lane, which is never journaled or shown, because it carries the effect
 * descriptor the host evaluates the grant against. Everything a display may
 * show also rides the bulk `clio_coder_permission_escalated` event, bounded
 * and sanitized.
 */
export interface WorkerGrantRequestFrame {
	/** The worker registry's id for the parked call. */
	requestId: string;
	attemptToken: string;
	attempt: number;
	tool: string;
	actionClass: string;
	authority: "main" | "operator";
	/** sha256 over the canonical effect descriptor. */
	argDigest: string;
	/** Null when the descriptor did not fit the frame; a main grant then refuses. */
	effect: { tool: string; args: Record<string, unknown> } | null;
	summary: string;
	target?: string;
	/** Card text only: what a bash command would do, composed in the worker from the full command. */
	consequence?: ReadonlyArray<string>;
	reasons: ReadonlyArray<string>;
	axis?: string;
	timeoutMs: number;
	toolCallId?: string;
}

export type WorkerControlFrame =
	| { kind: "announce"; attestation: WorkerAttestation }
	| { kind: "heartbeat" }
	| { kind: "cancel_ack"; at: number }
	| { kind: "ledger_post"; body: AgentLedgerBody; flowRestrictions?: FlowRestrictionSet }
	| { kind: "model_loaded"; load: WorkerModelLoad }
	| { kind: "grant_request"; request: WorkerGrantRequestFrame };

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
	if (url === undefined || url.trim().length === 0) return sha256Hex("clio-coder.endpoint:none");
	const raw = url.trim();
	let canonical: string;
	try {
		const parsed = new URL(raw);
		const path = parsed.pathname.replace(/\/+$/u, "");
		canonical = `${parsed.protocol}//${parsed.hostname}:${parsed.port}${path}`;
	} catch {
		canonical = raw.replace(/\/+$/u, "");
	}
	return sha256Hex(`clio-coder.endpoint:${canonical}`);
}

/** Digest of one WorkerSpec document, computed identically on both ends. */
export function workerSpecDigest(spec: unknown): string {
	return sha256Hex(`clio-coder.workerSpec:${canonicalJson(spec)}`);
}

/**
 * Digest of a worker permit's authority: its version, ceiling, allowance and
 * trust opt-in, never its own digest field. The host seals it and the worker
 * recomputes it, so the computation lives here rather than in the safety
 * domain the worker may not value-import.
 */
export function workerPermitDigest(permit: {
	version: number;
	ceiling: unknown;
	allowance: unknown;
	trustedUnmediated?: true;
}): string {
	const payload = {
		version: permit.version,
		ceiling: permit.ceiling,
		allowance: permit.allowance,
		...(permit.trustedUnmediated === true ? { trustedUnmediated: true } : {}),
	};
	return sha256Hex(`clio-coder.workerPermit:${canonicalJson(payload)}`);
}

/** Stable signature of the effective tool surface a worker will expose. */
export function toolSignatureOf(names: ReadonlyArray<string>): string {
	return sha256Hex(`clio-coder.tools:${[...names].sort().join(",")}`);
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
	const parsed = parseJsonObject(line, WORKER_BULK_FRAME_MAX_BYTES, "bulk");
	return parsed.ok ? { ok: true, value: normalizeClioCoderEventRecord(parsed.value) } : parsed;
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

function isModelLoadId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= WORKER_MODEL_LOAD_ID_MAX_CHARS;
}

function parseModelLoad(value: unknown): FrameParseResult<WorkerModelLoad> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "model_loaded load is not an object" };
	}
	const record = value as Record<string, unknown>;
	if (!isModelLoadId(record.targetId)) return { ok: false, reason: "model_loaded targetId is missing or too long" };
	if (!isModelLoadId(record.modelId)) return { ok: false, reason: "model_loaded modelId is missing or too long" };
	const aliases = record.aliasIds ?? [];
	if (!Array.isArray(aliases) || aliases.length > WORKER_MODEL_LOAD_ALIAS_MAX || !aliases.every(isModelLoadId)) {
		return { ok: false, reason: "model_loaded aliasIds must be a short list of model ids" };
	}
	return { ok: true, value: { targetId: record.targetId, modelId: record.modelId, aliasIds: [...aliases] } };
}

const GRANT_TEXT_MAX_CHARS = 1024;

function boundedText(value: unknown, max = GRANT_TEXT_MAX_CHARS): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

const GRANT_CONSEQUENCE_MAX_LINES = 10;
const GRANT_CONSEQUENCE_LINE_MAX_CHARS = 512;

/** The display sentences of a grant request, or null when the field is absent or malformed. A bad one costs the card its line, never the request. */
function parseGrantConsequence(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length === 0 || value.length > GRANT_CONSEQUENCE_MAX_LINES) return null;
	const lines: string[] = [];
	for (const entry of value) {
		const line = boundedText(entry, GRANT_CONSEQUENCE_LINE_MAX_CHARS);
		if (line === null) return null;
		lines.push(line);
	}
	return lines;
}

function parseGrantRequest(value: unknown): FrameParseResult<WorkerGrantRequestFrame> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, reason: "grant_request request is not an object" };
	}
	const record = value as Record<string, unknown>;
	const requestId = boundedText(record.requestId, 128);
	const attemptToken = boundedText(record.attemptToken, 128);
	const tool = boundedText(record.tool, 128);
	const actionClass = boundedText(record.actionClass, 64);
	const summary = boundedText(record.summary);
	if (requestId === null || attemptToken === null || tool === null || actionClass === null || summary === null) {
		return { ok: false, reason: "grant_request is missing an identity field" };
	}
	if (record.authority !== "main" && record.authority !== "operator") {
		return { ok: false, reason: "grant_request authority must be main or operator" };
	}
	if (typeof record.argDigest !== "string" || !HEX_64.test(record.argDigest)) {
		return { ok: false, reason: "grant_request argDigest must be a sha256 hex digest" };
	}
	if (!Number.isSafeInteger(record.attempt) || Number(record.attempt) < 0) {
		return { ok: false, reason: "grant_request attempt must be a non-negative integer" };
	}
	const timeoutMs = readFiniteNumber(record, "timeoutMs");
	if (timeoutMs === null || timeoutMs <= 0) return { ok: false, reason: "grant_request timeoutMs must be positive" };
	let effect: WorkerGrantRequestFrame["effect"] = null;
	if (record.effect !== null) {
		const raw = record.effect;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return { ok: false, reason: "grant_request effect must be an object or null" };
		}
		const effectTool = boundedText((raw as Record<string, unknown>).tool, 128);
		const args = (raw as Record<string, unknown>).args;
		if (effectTool === null || typeof args !== "object" || args === null || Array.isArray(args)) {
			return { ok: false, reason: "grant_request effect needs a tool and an args object" };
		}
		effect = { tool: effectTool, args: args as Record<string, unknown> };
	}
	const reasons = Array.isArray(record.reasons)
		? record.reasons.filter((entry): entry is string => typeof entry === "string").slice(0, 8)
		: [];
	const target = boundedText(record.target);
	const consequence = parseGrantConsequence(record.consequence);
	const axis = boundedText(record.axis, 256);
	const toolCallId = boundedText(record.toolCallId, 256);
	return {
		ok: true,
		value: {
			requestId,
			attemptToken,
			attempt: Number(record.attempt),
			tool,
			actionClass,
			authority: record.authority,
			argDigest: record.argDigest,
			effect,
			summary,
			...(target !== null ? { target } : {}),
			...(consequence !== null ? { consequence } : {}),
			reasons: reasons.map((reason) => reason.slice(0, GRANT_TEXT_MAX_CHARS)),
			...(axis !== null ? { axis } : {}),
			timeoutMs,
			...(toolCallId !== null ? { toolCallId } : {}),
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
		case "heartbeat":
			// Legacy workers still send `at`; nothing reads it, so it is ignored.
			return { ok: true, value: { kind: "heartbeat" } };
		case "cancel_ack": {
			const at = readFiniteNumber(record, "at");
			if (at === null) return { ok: false, reason: "cancel_ack frame requires a finite at" };
			return { ok: true, value: { kind: "cancel_ack", at } };
		}
		case "ledger_post": {
			const body = parseAgentLedgerBody(record.body);
			if (!body.ok) return { ok: false, reason: `ledger_post frame rejected: ${body.reason}` };
			if (record.flowRestrictions !== undefined && !isFlowRestrictionSet(record.flowRestrictions)) {
				return { ok: false, reason: "ledger_post has invalid flow restrictions" };
			}
			return {
				ok: true,
				value: {
					kind: "ledger_post",
					body: body.body,
					...(record.flowRestrictions === undefined
						? {}
						: { flowRestrictions: structuredClone(record.flowRestrictions as FlowRestrictionSet) }),
				},
			};
		}
		case "model_loaded": {
			const load = parseModelLoad(record.load);
			if (!load.ok) return load;
			return { ok: true, value: { kind: "model_loaded", load: load.value } };
		}
		case "grant_request": {
			const request = parseGrantRequest(record.request);
			if (!request.ok) return request;
			return { ok: true, value: { kind: "grant_request", request: request.value } };
		}
		default:
			return { ok: false, reason: `unknown control frame kind ${String(record.kind)}` };
	}
}

/**
 * Bulk frames whose loss would destroy receipt evidence. Everything else on
 * the bulk lane exists to drive a live display and may be dropped under
 * pressure.
 *
 * Every entry must name a frame some worker emits and the receipt fold reads.
 * The tool frames stand in for five legacy names nothing emits any more
 * (`clio_coder_tool_activity` and its siblings), which left the frames that
 * feed `toolStats`, `skillActivations`, safety decisions, in-flight tool
 * coverage and finish-contract entries droppable above the queue bound.
 */
const RECEIPT_BEARING_BULK_TYPES = new Set([
	"clio_coder_helper_result",
	"message_end",
	"clio_coder_run_outcome",
	"clio_coder_flow_restrictions",
	"clio_coder_permission_escalated",
	"clio_coder_permission_resolved",
	"clio_coder_permission_grant_execution",
	"clio_coder_steer_received",
	"clio_coder_tool_start",
	"clio_coder_tool_finish",
	"tool_execution_start",
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
