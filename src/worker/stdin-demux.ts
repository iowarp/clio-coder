import {
	type AgentLedgerEntry,
	parseAgentLedgerEntry,
	WORKER_STDIN_FRAME_MAX_BYTES,
	withinFrameBudget,
} from "./protocol.js";
import { parseWorkerSpec, type WorkerSpec } from "./spec-contract.js";

export interface WorkerStdinDemux {
	feed(chunk: string): void;
	eof(): void;
	readSpec(): Promise<WorkerSpec>;
	/**
	 * Register the handler for post-spec steer lines
	 * (`{"type":"steer","text":"...","sequence":1}`). The sequence is assigned by
	 * the parent and is what lets `clio_coder_steer_received` acknowledge one exact
	 * receipt entry, so a line without a positive integer sequence is dropped
	 * rather than delivered unattributed. Steers that arrive before registration
	 * are buffered in order and flushed to the handler. Single handler; a second
	 * registration replaces the first.
	 */
	onSteer(handler: (steer: WorkerSteerMessage) => void): void;
	/**
	 * Register the handler for post-spec permission-decision lines
	 * (`{"type":"permission_decision","requestId":"...","decision":"approve"|"deny"}`).
	 * Decisions that arrive before registration are buffered in order and
	 * flushed. Single handler; a second registration replaces the first.
	 */
	onPermissionDecision(handler: (decision: WorkerPermissionDecision) => void): void;
	/**
	 * Register the handler for agent-ledger delta lines
	 * (`{"type":"ledger_delta","entries":[...]}`). The orchestrator replays the
	 * full board on subscription, which can land before the runtime wires its
	 * handler, so batches that arrive early are buffered in order and flushed.
	 * Single handler; a second registration replaces the first.
	 */
	onLedgerDelta(handler: (entries: ReadonlyArray<AgentLedgerEntry>) => void): void;
	/** Post-spec lines that were not valid steer or permission-decision messages. */
	droppedLineCount(): number;
	/**
	 * Register the handler for the control channel closing after the spec was
	 * received (parent exit, SSH channel drop). Fires at most once; if the
	 * channel already closed the handler is invoked immediately. The pre-spec
	 * close case stays a readSpec() rejection, not a channel-close event.
	 */
	onChannelClose(handler: () => void): void;
}

/**
 * What a live grant decision names (Phase D). The worker checks every field
 * against its single parked call before it consumes the decision.
 */
export interface WorkerDecisionBinding {
	attemptToken: string;
	attempt: number;
	argDigest: string;
	issuer: "main" | "operator";
	/** The host's run id for audit; the worker cannot check it. */
	runId?: string;
	/** Host broker request id, for the worker's own resolution events. */
	grantId?: string;
	/** Why the host decided, bounded; a denial quotes it to the worker model. */
	reason?: string;
}

export interface WorkerPermissionDecision {
	requestId: string;
	decision: "approve" | "deny";
	binding?: WorkerDecisionBinding;
}

function parseDecisionBinding(value: unknown): WorkerDecisionBinding | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.attemptToken !== "string" || record.attemptToken.length === 0) return null;
	if (!Number.isSafeInteger(record.attempt)) return null;
	if (typeof record.argDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.argDigest)) return null;
	if (record.issuer !== "main" && record.issuer !== "operator") return null;
	return {
		attemptToken: record.attemptToken,
		attempt: Number(record.attempt),
		argDigest: record.argDigest,
		issuer: record.issuer,
		...(typeof record.runId === "string" ? { runId: record.runId } : {}),
		...(typeof record.grantId === "string" ? { grantId: record.grantId } : {}),
		...(typeof record.reason === "string" && record.reason.length > 0 ? { reason: record.reason.slice(0, 300) } : {}),
	};
}

export interface WorkerSteerMessage {
	text: string;
	/** Parent-assigned receipt-provenance sequence for exact acknowledgement. */
	sequence: number;
}

/**
 * Preserve stdin order while a runtime accepts guidance asynchronously.
 * `clio_coder_steer_received` echoes the parent-assigned sequence, so an
 * acknowledgement closes out one exact receipt entry. Ordering still matters
 * for the runtime itself: a later steer must never reach it ahead of an earlier
 * pending one, or the guidance arrives out of the order the operator sent it.
 */
export function createOrderedSteerHandler(
	deliver: (text: string) => boolean | Promise<boolean>,
	onAccepted: (steer: WorkerSteerMessage) => void,
	onRejected: (reason: string) => void,
): (steer: WorkerSteerMessage) => Promise<void> {
	let tail = Promise.resolve();
	return (steer: WorkerSteerMessage): Promise<void> => {
		tail = tail.then(async () => {
			let rejection: string | null = null;
			try {
				if (await deliver(steer.text)) onAccepted(steer);
				else rejection = "runtime does not accept live guidance";
			} catch (error) {
				rejection = error instanceof Error ? error.message : String(error);
			}
			if (rejection !== null) {
				try {
					onRejected(rejection);
				} catch {
					// Diagnostics cannot be allowed to poison subsequent delivery.
				}
			}
		});
		return tail;
	};
}

export function createWorkerStdinDemux(): WorkerStdinDemux {
	let buffer = "";
	let specResolve: ((spec: WorkerSpec) => void) | null = null;
	let specReject: ((err: Error) => void) | null = null;
	let specValue: WorkerSpec | null = null;
	let specError: Error | null = null;
	let specReceived = false;
	let closed = false;
	let steerHandler: ((steer: WorkerSteerMessage) => void) | null = null;
	const pendingSteers: WorkerSteerMessage[] = [];
	let permissionHandler: ((decision: WorkerPermissionDecision) => void) | null = null;
	const pendingPermissionDecisions: WorkerPermissionDecision[] = [];
	let ledgerDeltaHandler: ((entries: ReadonlyArray<AgentLedgerEntry>) => void) | null = null;
	const pendingLedgerDeltas: Array<ReadonlyArray<AgentLedgerEntry>> = [];
	let droppedLines = 0;
	let channelCloseHandler: (() => void) | null = null;
	let channelCloseDelivered = false;
	let channelClosedAfterSpec = false;

	function deliverChannelClose(): void {
		if (channelCloseDelivered || channelCloseHandler === null) return;
		channelCloseDelivered = true;
		channelCloseHandler();
	}

	function resolveSpec(spec: WorkerSpec): void {
		specValue = spec;
		specResolve?.(spec);
	}

	function rejectSpec(err: Error): void {
		specError = err;
		specReject?.(err);
	}

	function deliverSteer(steer: WorkerSteerMessage): void {
		if (steerHandler) {
			steerHandler(steer);
			return;
		}
		pendingSteers.push(steer);
	}

	function deliverPermissionDecision(entry: WorkerPermissionDecision): void {
		if (permissionHandler) {
			permissionHandler(entry);
			return;
		}
		pendingPermissionDecisions.push(entry);
	}

	function deliverLedgerDelta(entries: ReadonlyArray<AgentLedgerEntry>): void {
		if (ledgerDeltaHandler) {
			ledgerDeltaHandler(entries);
			return;
		}
		pendingLedgerDeltas.push(entries);
	}

	function processPostSpecLine(line: string): void {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			droppedLines += 1;
			return;
		}
		if (
			typeof value === "object" &&
			value !== null &&
			(value as { type?: unknown }).type === "steer" &&
			typeof (value as { text?: unknown }).text === "string" &&
			(value as { text: string }).text.trim().length > 0 &&
			Number.isSafeInteger((value as { sequence?: unknown }).sequence) &&
			Number((value as { sequence: number }).sequence) > 0
		) {
			deliverSteer({
				text: (value as { text: string }).text,
				sequence: (value as { sequence: number }).sequence,
			});
			return;
		}
		if (
			typeof value === "object" &&
			value !== null &&
			(value as { type?: unknown }).type === "permission_decision" &&
			typeof (value as { requestId?: unknown }).requestId === "string" &&
			(value as { requestId: string }).requestId.length > 0 &&
			((value as { decision?: unknown }).decision === "approve" || (value as { decision?: unknown }).decision === "deny")
		) {
			// A malformed binding is delivered as no binding, which a grant-bound
			// park treats as a mismatch and denies.
			const binding = parseDecisionBinding((value as { binding?: unknown }).binding);
			deliverPermissionDecision({
				requestId: (value as { requestId: string }).requestId,
				decision: (value as { decision: "approve" | "deny" }).decision,
				...(binding !== null ? { binding } : {}),
			});
			return;
		}
		if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "ledger_delta") {
			const raw = (value as { entries?: unknown }).entries;
			if (!Array.isArray(raw)) {
				droppedLines += 1;
				return;
			}
			const entries: AgentLedgerEntry[] = [];
			for (const candidate of raw) {
				const entry = parseAgentLedgerEntry(candidate);
				if (entry !== null) entries.push(entry);
			}
			if (entries.length === 0) {
				droppedLines += 1;
				return;
			}
			deliverLedgerDelta(entries);
			return;
		}
		droppedLines += 1;
	}

	function processLine(line: string): void {
		if (line.length === 0) return;
		// The byte ceiling is checked before JSON.parse so an oversized or
		// adversarial line costs a length comparison, not a parse and an
		// allocation proportional to its size.
		if (!withinFrameBudget(line, WORKER_STDIN_FRAME_MAX_BYTES)) {
			if (!specReceived) {
				specReceived = true;
				rejectSpec(new Error(`WorkerSpec line exceeds the ${WORKER_STDIN_FRAME_MAX_BYTES} byte stdin frame limit`));
				return;
			}
			droppedLines += 1;
			return;
		}
		if (!specReceived) {
			specReceived = true;
			try {
				resolveSpec(parseWorkerSpec(JSON.parse(line)));
			} catch (err) {
				rejectSpec(err instanceof Error ? err : new Error(String(err)));
			}
			return;
		}
		processPostSpecLine(line);
	}

	/**
	 * Discard an unterminated run that already exceeds the frame ceiling. A peer
	 * that never sends a newline cannot grow this buffer without bound; the
	 * oversized remainder is dropped up to the next newline.
	 */
	let discardingOversizedLine = false;

	return {
		feed(chunk: string): void {
			if (closed) return;
			buffer += chunk;
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (discardingOversizedLine) {
					discardingOversizedLine = false;
					droppedLines += 1;
				} else {
					processLine(line);
				}
				idx = buffer.indexOf("\n");
			}
			if (!withinFrameBudget(buffer, WORKER_STDIN_FRAME_MAX_BYTES)) {
				if (!specReceived) {
					specReceived = true;
					rejectSpec(new Error(`WorkerSpec line exceeds the ${WORKER_STDIN_FRAME_MAX_BYTES} byte stdin frame limit`));
				}
				buffer = "";
				discardingOversizedLine = true;
			}
		},
		eof(): void {
			if (closed) return;
			closed = true;
			if (buffer.length > 0) {
				processLine(buffer);
				buffer = "";
			}
			if (!specReceived) {
				rejectSpec(new Error("worker stdin closed before spec received"));
				return;
			}
			channelClosedAfterSpec = true;
			deliverChannelClose();
		},
		readSpec(): Promise<WorkerSpec> {
			if (specValue) return Promise.resolve(specValue);
			if (specError) return Promise.reject(specError);
			if (closed && !specReceived) return Promise.reject(new Error("worker stdin closed before spec received"));
			return new Promise((resolve, reject) => {
				specResolve = resolve;
				specReject = reject;
			});
		},
		onSteer(handler: (steer: WorkerSteerMessage) => void): void {
			steerHandler = handler;
			while (pendingSteers.length > 0) {
				const steer = pendingSteers.shift();
				if (steer !== undefined) handler(steer);
			}
		},
		onPermissionDecision(handler: (decision: WorkerPermissionDecision) => void): void {
			permissionHandler = handler;
			while (pendingPermissionDecisions.length > 0) {
				const entry = pendingPermissionDecisions.shift();
				if (entry !== undefined) handler(entry);
			}
		},
		onLedgerDelta(handler: (entries: ReadonlyArray<AgentLedgerEntry>) => void): void {
			ledgerDeltaHandler = handler;
			while (pendingLedgerDeltas.length > 0) {
				const batch = pendingLedgerDeltas.shift();
				if (batch !== undefined) handler(batch);
			}
		},
		droppedLineCount(): number {
			return droppedLines;
		},
		onChannelClose(handler: () => void): void {
			channelCloseHandler = handler;
			if (channelClosedAfterSpec) deliverChannelClose();
		},
	};
}
