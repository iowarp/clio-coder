import { WORKER_STDIN_FRAME_MAX_BYTES, withinFrameBudget } from "./protocol.js";
import { parseWorkerSpec, type WorkerSpec } from "./spec-contract.js";

export interface WorkerStdinDemux {
	feed(chunk: string): void;
	eof(): void;
	readSpec(): Promise<WorkerSpec>;
	/**
	 * Register the handler for post-spec steer lines
	 * (`{"type":"steer","text":"..."}`). Steers that arrive before
	 * registration are buffered in order and flushed to the handler.
	 * Single handler; a second registration replaces the first.
	 */
	onSteer(handler: (text: string) => void): void;
	/**
	 * Register the handler for post-spec permission-decision lines
	 * (`{"type":"permission_decision","requestId":"...","decision":"approve"|"deny"}`).
	 * Decisions that arrive before registration are buffered in order and
	 * flushed. Single handler; a second registration replaces the first.
	 */
	onPermissionDecision(handler: (decision: { requestId: string; decision: "approve" | "deny" }) => void): void;
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

export function createWorkerStdinDemux(): WorkerStdinDemux {
	let buffer = "";
	let specResolve: ((spec: WorkerSpec) => void) | null = null;
	let specReject: ((err: Error) => void) | null = null;
	let specValue: WorkerSpec | null = null;
	let specError: Error | null = null;
	let specReceived = false;
	let closed = false;
	let steerHandler: ((text: string) => void) | null = null;
	const pendingSteers: string[] = [];
	let permissionHandler: ((decision: { requestId: string; decision: "approve" | "deny" }) => void) | null = null;
	const pendingPermissionDecisions: Array<{ requestId: string; decision: "approve" | "deny" }> = [];
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

	function deliverSteer(text: string): void {
		if (steerHandler) {
			steerHandler(text);
			return;
		}
		pendingSteers.push(text);
	}

	function deliverPermissionDecision(requestId: string, decision: "approve" | "deny"): void {
		if (permissionHandler) {
			permissionHandler({ requestId, decision });
			return;
		}
		pendingPermissionDecisions.push({ requestId, decision });
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
			(value as { text: string }).text.trim().length > 0
		) {
			deliverSteer((value as { text: string }).text);
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
			deliverPermissionDecision(
				(value as { requestId: string }).requestId,
				(value as { decision: "approve" | "deny" }).decision,
			);
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
		onSteer(handler: (text: string) => void): void {
			steerHandler = handler;
			while (pendingSteers.length > 0) {
				const text = pendingSteers.shift();
				if (text !== undefined) handler(text);
			}
		},
		onPermissionDecision(handler: (decision: { requestId: string; decision: "approve" | "deny" }) => void): void {
			permissionHandler = handler;
			while (pendingPermissionDecisions.length > 0) {
				const entry = pendingPermissionDecisions.shift();
				if (entry !== undefined) handler(entry);
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
