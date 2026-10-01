import { randomBytes } from "node:crypto";
import type { ApprovalAuthority } from "../safety/admission.js";
import { type GrantEffectDescriptor, grantEffectDigest } from "../safety/grant-effect.js";

/**
 * The trusted grant broker (Phase D, Codex review "Live grant protocol").
 *
 * It holds the authoritative record of every worker ask routed to the main
 * agent. The model and the operator see a bounded preview; a decision is
 * checked against this record, never against copies of its facts the caller
 * supplies. A decision reaches the worker only through `deliver`, bound to
 * the exact request, attempt and argument digest the worker parked.
 *
 * States: pending, authorized, executing, completed, denied, expired,
 * canceled. `completed`, `denied`, `expired` and `canceled` are terminal and
 * each record reaches exactly one of them. A duplicate decision returns the
 * existing state and never delivers twice, so one grant executes at most once.
 * A new call with identical arguments is a new request with its own record.
 */

export type GrantState = "pending" | "authorized" | "executing" | "completed" | "denied" | "expired" | "canceled";
export type GrantExecution = "not_executed" | "executing" | "executed" | "unknown";
export type GrantIssuer = "main" | "operator";
export type GrantDecision = "approve" | "deny";

const TERMINAL_STATES: ReadonlySet<GrantState> = new Set(["completed", "denied", "expired", "canceled"]);

function isTerminalGrantState(state: GrantState): boolean {
	return TERMINAL_STATES.has(state);
}

export interface GrantRequestInput {
	/** The worker registry's id for the parked call; echoed on the decision frame. */
	workerRequestId: string;
	/** The attempt's run id (ledger envelope id). */
	runId: string;
	/** The logical assignment the attempt belongs to. */
	rootRunId: string;
	attempt: number;
	/** Per-attempt secret the host minted into the worker spec; the worker checks it on every decision. */
	attemptToken: string;
	ownerSessionId: string | null;
	agentId: string;
	toolCallId?: string;
	tool: string;
	actionClass: string;
	/** Who may discharge the ask: `main` only for an ordinary autonomy ask under a main-authority permit. */
	approvalAuthority: ApprovalAuthority;
	/** sha256 over the canonical effect descriptor the worker parked. */
	argDigest: string;
	/** The effect descriptor, or null when it did not fit the control frame; a main grant then refuses. */
	effect: GrantEffectDescriptor | null;
	/** Absolute run cwd the effect executes in. */
	cwd: string;
	/** The worker's permit ceiling: tools this attempt may ever call. */
	permitTools: ReadonlyArray<string>;
	summary: string;
	target?: string;
	/** Card text only, composed by the worker from its full command. */
	consequence?: ReadonlyArray<string>;
	reasons: ReadonlyArray<string>;
	/** Epoch ms after which the request expires. */
	deadlineAt: number;
}

export interface GrantRecord extends GrantRequestInput {
	requestId: string;
	state: GrantState;
	execution: GrantExecution;
	createdAt: number;
	decidedAt?: number;
	issuer?: GrantIssuer;
	/** Set when the main agent asked the operator to decide (main at default, attended). */
	forwardedByMain?: true;
	/** Why the record reached its current state. */
	reason?: string;
}

export type GrantOpenResult = { ok: true; record: GrantRecord } | { ok: false; reason: string };

export type GrantDecideResult =
	| { ok: true; record: GrantRecord; duplicate: boolean }
	| { ok: false; reason: string; record?: GrantRecord };

export interface GrantDecideInput {
	decision: GrantDecision;
	issuer: GrantIssuer;
	/**
	 * The deciding session. Undefined only for the host's own operator path in
	 * the owning process; the model path always passes its session, and a
	 * mismatch fails.
	 */
	sessionId?: string | null;
	/** Run or assignment id the caller named; must match the record. */
	runId?: string;
	/** Attempt the caller named; must match the record when given. */
	attempt?: number;
	reason?: string;
}

export interface GrantBrokerDeps {
	/**
	 * Send the bound decision to the worker. Returns false when the worker's
	 * channel is gone; an approval that cannot be delivered cancels the record.
	 */
	deliver(record: GrantRecord, decision: GrantDecision, reason: string): boolean;
	now?: () => number;
	randomId?: () => string;
	/** Bound on pending records across the process. */
	maxPending?: number;
	/** Bound on requests one attempt may open. */
	maxRequestsPerRun?: number;
	/** Terminal records kept for audit and duplicate answers. */
	retainTerminal?: number;
	/** Called after every state change with a snapshot of the record. */
	onChange?: (record: GrantRecord, previous: GrantState | null) => void;
}

export interface GrantListFilter {
	sessionId?: string | null;
	runId?: string;
	state?: GrantState;
}

export interface GrantBroker {
	open(input: GrantRequestInput): GrantOpenResult;
	get(requestId: string): GrantRecord | null;
	findByWorker(runId: string, workerRequestId: string): GrantRecord | null;
	list(filter?: GrantListFilter): GrantRecord[];
	decide(requestId: string, input: GrantDecideInput): GrantDecideResult;
	/** Record that the main agent sent this request to the operator. */
	markForwarded(requestId: string): GrantRecord | null;
	/** Resolves with the record once it leaves `pending`, or null on abort. */
	waitForDecision(requestId: string, signal?: AbortSignal): Promise<GrantRecord | null>;
	/** Worker execution report for an authorized grant. */
	markExecution(
		runId: string,
		workerRequestId: string,
		phase: "start" | "end" | "not_executed",
		detail?: string,
	): GrantRecord | null;
	/** The worker resolved its parked call without a broker decision (its own timeout, abort, a binding mismatch). */
	workerResolved(runId: string, workerRequestId: string, decision: "approved" | "denied", reason: string): void;
	/**
	 * Revoke what an attempt holds. An abort revokes only pending requests,
	 * because the worker still reports what it did with a delivered approval.
	 * Worker exit (`final`) settles everything: an approval delivered or a call
	 * started with no completion report becomes execution `unknown`.
	 */
	revokeRun(runId: string, reason: string, options?: { final?: boolean }): void;
	/** Revoke a session's pending requests: session end, turn cancel, ownership change. */
	revokeSession(sessionId: string | null, reason: string): void;
	dispose(): void;
}

export const DEFAULT_GRANT_MAX_PENDING = 16;
export const DEFAULT_GRANT_MAX_REQUESTS_PER_RUN = 24;
const DEFAULT_RETAIN_TERMINAL = 512;

function snapshot(record: GrantRecord): GrantRecord {
	return Object.freeze({ ...record, reasons: [...record.reasons], permitTools: [...record.permitTools] });
}

export function createGrantBroker(deps: GrantBrokerDeps): GrantBroker {
	const now = deps.now ?? Date.now;
	const randomId = deps.randomId ?? (() => `grant-${randomBytes(16).toString("hex")}`);
	const maxPending = deps.maxPending ?? DEFAULT_GRANT_MAX_PENDING;
	const maxPerRun = deps.maxRequestsPerRun ?? DEFAULT_GRANT_MAX_REQUESTS_PER_RUN;
	const retainTerminal = deps.retainTerminal ?? DEFAULT_RETAIN_TERMINAL;
	const records = new Map<string, GrantRecord>();
	const byWorker = new Map<string, string>();
	const perRun = new Map<string, number>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const waiters = new Map<string, Set<(record: GrantRecord) => void>>();
	const terminalOrder: string[] = [];

	const workerKey = (runId: string, workerRequestId: string): string => `${runId}\u0000${workerRequestId}`;

	const clearTimer = (requestId: string): void => {
		const timer = timers.get(requestId);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(requestId);
		}
	};

	const retire = (requestId: string): void => {
		terminalOrder.push(requestId);
		while (terminalOrder.length > retainTerminal) {
			const oldest = terminalOrder.shift();
			if (oldest === undefined) break;
			const record = records.get(oldest);
			if (record === undefined) continue;
			records.delete(oldest);
			byWorker.delete(workerKey(record.runId, record.workerRequestId));
		}
	};

	const transition = (
		record: GrantRecord,
		state: GrantState,
		patch: Partial<Pick<GrantRecord, "execution" | "issuer" | "reason" | "decidedAt">> = {},
	): GrantRecord => {
		const previous = record.state;
		record.state = state;
		Object.assign(record, patch);
		if (previous === "pending" && state !== "pending") {
			const settled = snapshot(record);
			for (const resolve of waiters.get(record.requestId) ?? []) resolve(settled);
			waiters.delete(record.requestId);
		}
		if (isTerminalGrantState(state)) {
			clearTimer(record.requestId);
			if (!isTerminalGrantState(previous)) retire(record.requestId);
		}
		const view = snapshot(record);
		try {
			deps.onChange?.(view, previous);
		} catch {
			// An observer failure never changes a decision; the record is authoritative.
		}
		return view;
	};

	const expire = (requestId: string): void => {
		timers.delete(requestId);
		const record = records.get(requestId);
		if (record === undefined || record.state !== "pending") return;
		const reason = "the request expired before a decision";
		transition(record, "expired", { execution: "not_executed", reason, decidedAt: now() });
		deps.deliver(record, "deny", reason);
	};

	const pendingCount = (): number => {
		let count = 0;
		for (const record of records.values()) if (record.state === "pending") count += 1;
		return count;
	};

	return {
		open(input) {
			if (input.effect !== null && grantEffectDigest(input.effect) !== input.argDigest) {
				return { ok: false, reason: "the request's argument digest does not match its effect descriptor" };
			}
			const key = workerKey(input.runId, input.workerRequestId);
			if (byWorker.has(key)) return { ok: false, reason: "the worker already opened this request" };
			const opened = perRun.get(input.runId) ?? 0;
			if (opened >= maxPerRun) {
				return {
					ok: false,
					reason: `this attempt already asked ${opened} times, the per-run escalation limit; further asks are denied`,
				};
			}
			// A worker parks one ask at a time. An older pending record for the
			// same attempt means the worker already resolved it on its own (its
			// timeout or an abort) before that report arrived on the bulk lane.
			for (const record of records.values()) {
				if (record.runId === input.runId && record.state === "pending") {
					transition(record, "expired", {
						execution: "not_executed",
						reason: "the worker resolved this request before a decision arrived",
						decidedAt: now(),
					});
				}
			}
			if (pendingCount() >= maxPending) {
				return { ok: false, reason: `${maxPending} worker requests are already pending; this ask is denied` };
			}
			perRun.set(input.runId, opened + 1);
			const createdAt = now();
			const record: GrantRecord = {
				...input,
				reasons: [...input.reasons],
				permitTools: [...input.permitTools],
				requestId: randomId(),
				state: "pending",
				execution: "not_executed",
				createdAt,
			};
			records.set(record.requestId, record);
			byWorker.set(key, record.requestId);
			const delay = Math.max(0, input.deadlineAt - createdAt);
			const timer = setTimeout(() => expire(record.requestId), delay);
			timer.unref?.();
			timers.set(record.requestId, timer);
			const view = snapshot(record);
			try {
				deps.onChange?.(view, null);
			} catch {
				// An observer failure never changes a decision; the record is authoritative.
			}
			return { ok: true, record: view };
		},
		get(requestId) {
			const record = records.get(requestId);
			return record === undefined ? null : snapshot(record);
		},
		findByWorker(runId, workerRequestId) {
			const id = byWorker.get(workerKey(runId, workerRequestId));
			const record = id === undefined ? undefined : records.get(id);
			return record === undefined ? null : snapshot(record);
		},
		list(filter = {}) {
			const out: GrantRecord[] = [];
			for (const record of records.values()) {
				if (filter.sessionId !== undefined && record.ownerSessionId !== filter.sessionId) continue;
				if (filter.runId !== undefined && record.runId !== filter.runId && record.rootRunId !== filter.runId) continue;
				if (filter.state !== undefined && record.state !== filter.state) continue;
				out.push(snapshot(record));
			}
			return out.sort((left, right) => left.createdAt - right.createdAt);
		},
		decide(requestId, input) {
			const record = records.get(requestId);
			if (record === undefined) return { ok: false, reason: `unknown permission request '${requestId}'` };
			if (input.sessionId !== undefined && record.ownerSessionId !== input.sessionId) {
				return { ok: false, reason: `permission request '${requestId}' belongs to another session` };
			}
			if (input.runId !== undefined && input.runId !== record.runId && input.runId !== record.rootRunId) {
				return {
					ok: false,
					reason: `permission request '${requestId}' belongs to run ${record.runId}, not '${input.runId}'`,
				};
			}
			if (input.attempt !== undefined && input.attempt !== record.attempt) {
				return {
					ok: false,
					reason: `permission request '${requestId}' belongs to attempt ${record.attempt}, not ${input.attempt}`,
				};
			}
			if (input.decision === "approve" && input.issuer === "main" && record.approvalAuthority !== "main") {
				return {
					ok: false,
					reason: `permission request '${requestId}' needs the operator's decision; the main agent cannot grant an operator-authority ask`,
					record: snapshot(record),
				};
			}
			if (record.state !== "pending") {
				const view = snapshot(record);
				const approvedBefore = record.state === "authorized" || record.state === "executing";
				if (input.decision === "approve" && approvedBefore) return { ok: true, record: view, duplicate: true };
				if (input.decision === "deny" && record.state === "denied") return { ok: true, record: view, duplicate: true };
				return {
					ok: false,
					reason: `permission request '${requestId}' is already ${record.state}${record.state === "completed" ? ` (execution ${record.execution})` : ""}; it cannot be ${input.decision === "approve" ? "approved" : "denied"} now`,
					record: view,
				};
			}
			const decidedAt = now();
			if (decidedAt >= record.deadlineAt) {
				expire(requestId);
				const expired = records.get(requestId);
				return {
					ok: false,
					reason: `permission request '${requestId}' expired before the decision`,
					...(expired !== undefined ? { record: snapshot(expired) } : {}),
				};
			}
			if (input.decision === "deny") {
				const reason = input.reason ?? `denied by the ${input.issuer === "main" ? "main agent" : "operator"}`;
				const view = transition(record, "denied", { issuer: input.issuer, reason, decidedAt });
				deps.deliver(record, "deny", reason);
				return { ok: true, record: view, duplicate: false };
			}
			const reason = input.reason ?? `approved by the ${input.issuer === "main" ? "main agent" : "operator"}`;
			// Authorize before delivery, so a reentrant duplicate sees the new state.
			transition(record, "authorized", { issuer: input.issuer, reason, decidedAt });
			if (!deps.deliver(record, "approve", reason)) {
				const view = transition(record, "canceled", {
					execution: "not_executed",
					reason: "the worker's channel closed before the approval reached it",
				});
				return { ok: false, reason: view.reason ?? "the worker's channel closed", record: view };
			}
			return { ok: true, record: snapshot(record), duplicate: false };
		},
		markForwarded(requestId) {
			const record = records.get(requestId);
			if (record === undefined || record.state !== "pending") return null;
			record.forwardedByMain = true;
			const view = snapshot(record);
			try {
				deps.onChange?.(view, record.state);
			} catch {
				// An observer failure never changes a decision; the record is authoritative.
			}
			return view;
		},
		waitForDecision(requestId, signal) {
			const record = records.get(requestId);
			if (record === undefined) return Promise.resolve(null);
			if (record.state !== "pending") return Promise.resolve(snapshot(record));
			return new Promise((resolve) => {
				const set = waiters.get(requestId) ?? new Set();
				const onAbort = (): void => {
					set.delete(settle);
					resolve(null);
				};
				const settle = (settled: GrantRecord): void => {
					signal?.removeEventListener("abort", onAbort);
					resolve(settled);
				};
				set.add(settle);
				waiters.set(requestId, set);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		markExecution(runId, workerRequestId, phase, detail) {
			const id = byWorker.get(workerKey(runId, workerRequestId));
			const record = id === undefined ? undefined : records.get(id);
			if (record === undefined) return null;
			if (phase === "start") {
				if (record.state !== "authorized") return snapshot(record);
				return transition(record, "executing", { execution: "executing" });
			}
			if (phase === "end") {
				if (record.state !== "executing") return snapshot(record);
				return transition(record, "completed", {
					execution: "executed",
					...(detail !== undefined ? { reason: detail } : {}),
				});
			}
			if (record.state !== "authorized" && record.state !== "executing") return snapshot(record);
			return transition(record, "completed", {
				execution: "not_executed",
				reason: detail ?? "the worker did not execute the granted call",
			});
		},
		workerResolved(runId, workerRequestId, decision, reason) {
			const id = byWorker.get(workerKey(runId, workerRequestId));
			const record = id === undefined ? undefined : records.get(id);
			if (record === undefined || isTerminalGrantState(record.state)) return;
			if (record.state === "pending") {
				// The worker settled it first: its own deadline, an abort, or no responder.
				transition(record, decision === "approved" ? "canceled" : "expired", {
					execution: "not_executed",
					reason,
					decidedAt: now(),
				});
				return;
			}
			if (decision === "denied" && record.state === "authorized") {
				// The approval reached a worker that no longer held the call, or its binding did not match.
				transition(record, "completed", { execution: "not_executed", reason });
			}
		},
		revokeRun(runId, reason, options = {}) {
			for (const record of records.values()) {
				if (record.runId !== runId || isTerminalGrantState(record.state)) continue;
				if (record.state === "pending") {
					transition(record, "canceled", { execution: "not_executed", reason, decidedAt: now() });
					deps.deliver(record, "deny", reason);
					continue;
				}
				if (options.final !== true) continue;
				// The approval reached the worker, or the call started, and no
				// completion report followed. The side effect may have happened, so
				// the outcome is unknown and nothing replays it automatically.
				transition(record, "completed", {
					execution: "unknown",
					reason: `${reason}; the ${record.state === "executing" ? "granted call started" : "approval was delivered"} and no completion report followed`,
				});
			}
			if (options.final === true) perRun.delete(runId);
		},
		revokeSession(sessionId, reason) {
			for (const record of records.values()) {
				if (record.ownerSessionId !== sessionId || record.state !== "pending") continue;
				transition(record, "canceled", { execution: "not_executed", reason, decidedAt: now() });
				deps.deliver(record, "deny", reason);
			}
		},
		dispose() {
			for (const timer of timers.values()) clearTimeout(timer);
			timers.clear();
		},
	};
}
