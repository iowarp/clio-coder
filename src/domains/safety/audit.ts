import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir, stateRootRemoved } from "../../core/xdg.js";
import type { SafetyPolicyDecision } from "./policy-engine.js";

/**
 * NDJSON audit writer. One line per recorded event, file rotated on
 * local-date rollover. Rows are written with writeSync, so in-process readers
 * see them immediately; durability fsync happens on flush(), on close, on
 * rotation, and on a low-frequency background interval instead of once per
 * row, which kept blocking the admission hot path on disk latency. Write
 * errors never throw back to the caller because safety must not kill the hot
 * path; they are logged to stderr with a `[clio:audit]` prefix for
 * post-mortem review.
 *
 * Records are a discriminated union over `kind`:
 *   - `tool_call`: emitted by safety.evaluate() for every classified tool call.
 *   - `permission`: emitted for one-shot tool/action confirmation requests
 *     and resolutions.
 *   - `abort`: emitted on every BusChannels.RunAborted event so /audit consumers
 *     can reconstruct who cancelled which run and how long it ran first.
 *   - `session_park`: emitted on every BusChannels.SessionParked event so /audit
 *     consumers know which session was suspended and why.
 *   - `session_resume`: emitted on every BusChannels.SessionResumed event so
 *     /audit consumers know which session was reopened and how.
 *   - `agent_status_change`: emitted for alarmable agent-status transitions
 *     such as stuck, tool_blocked, retrying, and cancelled turns.
 *   - `completion_contract`: emitted at turn_end for every finish-contract
 *     decision (each OK reason and each engagement) so the decision is
 *     replayable from the ledger alone: it records the mutated paths, the
 *     evidence kinds, the decision, the reason, and the effective rigor.
 *
 * Older audit files written before the discriminator existed have rows with
 * the tool_call shape but no `kind` field. Any future reader should treat a
 * missing `kind` as `tool_call`.
 *
 * Rows flush from concurrent producers (orchestrator, workers, bus
 * subscribers) and are NOT time-ordered within a file. File order is an
 * implementation accident, never a contract: every reader must sort rows by
 * `ts` before reasoning about sequence.
 */

export interface ToolCallAuditRecord {
	kind: "tool_call";
	ts: string;
	correlationId: string;
	requestId?: string;
	tool: string;
	actionClass: string;
	decision: ToolCallAuditDecision;
	posture?: string;
	reasons: ReadonlyArray<string>;
	ruleId?: string;
	reasonCode?: string;
	policySource?: string;
	policyHash?: string;
	command?: string;
	cwd?: string;
	args?: unknown;
}

export type ToolCallAuditDecision = "allowed" | "blocked" | "permission_requested" | "classified" | "denied";

export interface ToolCallAuditInput {
	tool: string;
	classification: { actionClass: string; reasons: ReadonlyArray<string> };
	decision: ToolCallAuditDecision;
	requestId?: string;
	posture?: string;
	args?: unknown;
	policy?: SafetyPolicyDecision;
	reasons?: ReadonlyArray<string>;
	/**
	 * Reason code of the final decision. Set this when the row's decision was
	 * made by a later axis than the policy engine (autonomy denial, budget
	 * admission): the policy's own reasonCode describes a net pass ("allowed")
	 * and would misstate why the call was denied.
	 */
	reasonCode?: string;
	now?: Date;
}

export interface PermissionAuditRecord {
	kind: "permission";
	ts: string;
	correlationId: string;
	status: "requested" | "granted" | "denied" | "expired";
	requestId?: string;
	origin?: string;
	decidedBy?: string;
	tool?: string;
	actionClass?: string;
	reason?: string;
	requestedBy?: string;
}

export type AbortSource = "dispatch_abort" | "dispatch_drain" | "stream_cancel" | "loop_guard";

export interface AbortAuditRecord {
	kind: "abort";
	ts: string;
	correlationId: string;
	source: AbortSource;
	runId: string | null;
	startedAt: string | null;
	elapsedMs: number | null;
	reason?: string;
}

export type SessionParkReason = "create_new" | "resume_other" | "fork" | "switch_branch" | "close" | "shutdown";

export interface SessionParkAuditRecord {
	kind: "session_park";
	ts: string;
	correlationId: string;
	sessionId: string;
	reason: SessionParkReason;
}

export type SessionResumeVia = "resume" | "switch_branch";

export interface SessionResumeAuditRecord {
	kind: "session_resume";
	ts: string;
	correlationId: string;
	sessionId: string;
	via: SessionResumeVia;
}

export interface AgentStatusChangeAuditRecord {
	kind: "agent_status_change";
	ts: string;
	correlationId: string;
	runId: string | null;
	phase: string;
	prevPhase: string;
	elapsedFromStart: number;
	watchdogTier: number;
	metadata?: Record<string, unknown>;
}

export type CompletionContractDecision = "ok" | "engage";

export interface CompletionContractAuditRecord {
	kind: "completion_contract";
	ts: string;
	correlationId: string;
	runId?: string;
	sessionId?: string;
	turnId: string | null;
	decision: CompletionContractDecision;
	reason: string;
	rigor: string;
	mutatedPaths: ReadonlyArray<string>;
	evidenceKinds: ReadonlyArray<string>;
}

export interface CompletionContractAuditInput {
	runId?: string;
	sessionId?: string;
	turnId: string | null;
	decision: CompletionContractDecision;
	reason: string;
	rigor: string;
	mutatedPaths: ReadonlyArray<string>;
	evidenceKinds: ReadonlyArray<string>;
	now?: Date;
}

export type AuditRecord =
	| ToolCallAuditRecord
	| PermissionAuditRecord
	| AbortAuditRecord
	| SessionParkAuditRecord
	| SessionResumeAuditRecord
	| AgentStatusChangeAuditRecord
	| CompletionContractAuditRecord;

export interface AuditWriter {
	write(record: AuditRecord): void;
	/** Fsync any rows written since the last flush so the file is durable on disk. */
	flush(): void;
	close(): Promise<void>;
}

const REDACT_KEY_RE = /(password|token|secret|key|auth|credential)/i;
const MAX_STRING_LEN = 200;

// Local-date YYYY-MM-DD. Intl.DateTimeFormat with en-CA emits ISO ordering in
// local time, which is simpler than composing the parts manually. The formatter
// lives at module scope because every audit row calls it and constructing one is
// expensive enough to matter on a path this file's header says must not block.
//
// A formatter resolves its zone at construction and never re-reads it, so it is
// rebuilt when process.env.TZ no longer matches the zone it was built for. This
// is the same idiom as src/interactive/format-time.ts; it costs one string
// comparison per row and keeps a mid-process TZ change from writing rows into
// the previous zone's file.
const DATE_OPTIONS: Intl.DateTimeFormatOptions = { year: "numeric", month: "2-digit", day: "2-digit" };
let dateFormatterZone = process.env.TZ;
let dateFormatter = new Intl.DateTimeFormat("en-CA", DATE_OPTIONS);

function localDateString(d: Date): string {
	if (process.env.TZ !== dateFormatterZone) {
		dateFormatterZone = process.env.TZ;
		// The zone is passed explicitly, not left for Intl to pick up from
		// process.env.TZ implicitly: see src/interactive/format-time.ts's
		// syncZone() for the traced repro (issue #84) of a rebuilt formatter
		// resolving to the wrong zone while process.env.TZ read correctly at
		// both construction and format time. Same idiom, same fix.
		const zone = dateFormatterZone === undefined ? undefined : { timeZone: dateFormatterZone };
		dateFormatter = new Intl.DateTimeFormat("en-CA", { ...DATE_OPTIONS, ...zone });
	}
	return dateFormatter.format(d);
}

function newCorrelationId(): string {
	// 8 bytes -> base36 -> pad to 12 to keep the id length stable.
	const n = BigInt(`0x${randomBytes(8).toString("hex")}`);
	const raw = n.toString(36);
	if (raw.length >= 12) return raw.slice(0, 12);
	return raw.padStart(12, "0");
}

function redactString(s: string): string {
	if (s.length <= MAX_STRING_LEN) return s;
	const truncated = s.length - MAX_STRING_LEN;
	return `${s.slice(0, MAX_STRING_LEN)}… [truncated ${truncated} chars]`;
}

function redactArgs(value: unknown, depth = 0): unknown {
	if (depth > 8) return "[redacted:depth]";
	if (value == null) return value;
	if (typeof value === "string") return redactString(value);
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) return value.map((item) => redactArgs(item, depth + 1));
	if (typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (REDACT_KEY_RE.test(k)) {
				out[k] = "[redacted]";
				continue;
			}
			out[k] = redactArgs(v, depth + 1);
		}
		return out;
	}
	return String(value);
}

export function buildAuditRecord(input: ToolCallAuditInput): ToolCallAuditRecord {
	const now = input.now ?? new Date();
	const record: ToolCallAuditRecord = {
		kind: "tool_call",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		tool: input.tool,
		actionClass: input.classification.actionClass,
		decision: input.decision,
		reasons: input.reasons ?? input.policy?.reasons ?? input.classification.reasons,
	};
	if (input.requestId !== undefined) record.requestId = input.requestId;
	if (input.posture !== undefined) record.posture = input.posture;
	if (input.policy?.ruleId !== undefined) record.ruleId = input.policy.ruleId;
	const reasonCode = input.reasonCode ?? input.policy?.reasonCode;
	if (reasonCode !== undefined) record.reasonCode = reasonCode;
	if (input.policy?.policySource !== undefined) record.policySource = input.policy.policySource;
	if (input.policy?.policyHash !== undefined) record.policyHash = input.policy.policyHash;
	if (input.policy?.command !== undefined) record.command = redactString(input.policy.command);
	if (input.policy?.cwd !== undefined) record.cwd = input.policy.cwd;
	if (input.args !== undefined) record.args = redactArgs(input.args);
	return record;
}

export function buildAbortAuditRecord(input: {
	source: AbortSource;
	runId: string | null;
	startedAt: string | null;
	elapsedMs: number | null;
	reason?: string;
	now?: Date;
}): AbortAuditRecord {
	const now = input.now ?? new Date();
	const record: AbortAuditRecord = {
		kind: "abort",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		source: input.source,
		runId: input.runId,
		startedAt: input.startedAt,
		elapsedMs: input.elapsedMs,
	};
	if (input.reason !== undefined) record.reason = input.reason;
	return record;
}

export function buildSessionParkAuditRecord(input: {
	sessionId: string;
	reason: SessionParkReason;
	now?: Date;
}): SessionParkAuditRecord {
	const now = input.now ?? new Date();
	return {
		kind: "session_park",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		sessionId: input.sessionId,
		reason: input.reason,
	};
}

export function buildSessionResumeAuditRecord(input: {
	sessionId: string;
	via: SessionResumeVia;
	now?: Date;
}): SessionResumeAuditRecord {
	const now = input.now ?? new Date();
	return {
		kind: "session_resume",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		sessionId: input.sessionId,
		via: input.via,
	};
}

export function buildPermissionAuditRecord(input: {
	status: PermissionAuditRecord["status"];
	requestId?: string;
	origin?: string;
	decidedBy?: string;
	tool?: string;
	actionClass?: string;
	reason?: string;
	requestedBy?: string;
	now?: Date;
}): PermissionAuditRecord {
	const now = input.now ?? new Date();
	const record: PermissionAuditRecord = {
		kind: "permission",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		status: input.status,
	};
	if (input.tool !== undefined) record.tool = input.tool;
	if (input.requestId !== undefined) record.requestId = input.requestId;
	if (input.origin !== undefined) record.origin = input.origin;
	if (input.decidedBy !== undefined) record.decidedBy = input.decidedBy;
	if (input.actionClass !== undefined) record.actionClass = input.actionClass;
	if (input.reason !== undefined) record.reason = input.reason;
	if (input.requestedBy !== undefined) record.requestedBy = input.requestedBy;
	return record;
}

export function buildAgentStatusChangeAuditRecord(input: {
	runId: string | null;
	phase: string;
	prevPhase: string;
	elapsedFromStart: number;
	watchdogTier: number;
	metadata?: Record<string, unknown>;
	now?: Date;
}): AgentStatusChangeAuditRecord {
	const now = input.now ?? new Date();
	const record: AgentStatusChangeAuditRecord = {
		kind: "agent_status_change",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		runId: input.runId,
		phase: input.phase,
		prevPhase: input.prevPhase,
		elapsedFromStart: Math.max(0, Math.floor(input.elapsedFromStart)),
		watchdogTier: Math.max(0, Math.floor(input.watchdogTier)),
	};
	if (input.metadata !== undefined) record.metadata = redactArgs(input.metadata) as Record<string, unknown>;
	return record;
}

export function buildCompletionContractAuditRecord(input: CompletionContractAuditInput): CompletionContractAuditRecord {
	const now = input.now ?? new Date();
	const record: CompletionContractAuditRecord = {
		kind: "completion_contract",
		ts: now.toISOString(),
		correlationId: newCorrelationId(),
		turnId: input.turnId,
		decision: input.decision,
		reason: input.reason,
		rigor: input.rigor,
		mutatedPaths: input.mutatedPaths.map((path) => redactString(path)),
		evidenceKinds: [...input.evidenceKinds],
	};
	if (input.runId !== undefined) record.runId = input.runId;
	if (input.sessionId !== undefined) record.sessionId = input.sessionId;
	return record;
}

interface OpenFile {
	fd: number;
	date: string;
	path: string;
}

function logAuditError(err: unknown, path?: string): void {
	const msg = err instanceof Error ? err.message : String(err);
	const where = path ? ` (${path})` : "";
	process.stderr.write(`[clio:audit] ${msg}${where}\n`);
}

/** Cadence of the background safety flush that bounds how long rows can sit unfsynced. */
const AUDIT_FLUSH_INTERVAL_MS = 5_000;

export function openAuditWriter(opts?: { dateFn?: () => Date }): AuditWriter {
	const dateFn = opts?.dateFn ?? (() => new Date());
	let current: OpenFile | null = null;
	let closed = false;
	let dirty = false;

	function flushCurrent(): void {
		if (current === null || !dirty) return;
		try {
			fsyncSync(current.fd);
			dirty = false;
		} catch (err) {
			logAuditError(err, current.path);
		}
	}

	// Safety flush: a long session must not hold unflushed rows indefinitely.
	// The interval is unref'd so it never keeps the process alive.
	const flushTimer = setInterval(flushCurrent, AUDIT_FLUSH_INTERVAL_MS);
	flushTimer.unref();

	function closeCurrent(): void {
		if (current === null) return;
		flushCurrent();
		try {
			closeSync(current.fd);
		} catch (err) {
			logAuditError(err, current.path);
		}
		current = null;
		dirty = false;
	}

	function ensureFor(date: string): OpenFile | null {
		if (current !== null && current.date === date) return current;
		if (current !== null) closeCurrent();
		// Opening the day's file mkdirs `<state>/audit`, which rebuilds a state
		// root that `clio-coder uninstall` has already removed. A tool call in a session
		// outliving the uninstall must not resurrect it. See core/xdg.ts
		// stateRootRemoved(). Rows are dropped silently for the same reason
		// logAuditError is not called: the removal is the operator's instruction,
		// not a fault.
		if (stateRootRemoved()) return null;
		try {
			const dir = join(clioStateDir(), "audit");
			mkdirSync(dir, { recursive: true });
			const filePath = join(dir, `${date}.jsonl`);
			const fd = openSync(filePath, "a");
			current = { fd, date, path: filePath };
			return current;
		} catch (err) {
			logAuditError(err);
			return null;
		}
	}

	return {
		write(record: AuditRecord): void {
			if (closed) return;
			try {
				const date = localDateString(dateFn());
				const handle = ensureFor(date);
				if (handle === null) return;
				const line = `${JSON.stringify(record)}\n`;
				writeSync(handle.fd, line);
				dirty = true;
			} catch (err) {
				logAuditError(err, current?.path);
			}
		},
		flush(): void {
			flushCurrent();
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			clearInterval(flushTimer);
			closeCurrent();
		},
	};
}
