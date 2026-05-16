import { isToolApprovalResponse, type ToolApprovalResponsePayload } from "../engine/worker-events.js";
import { parseWorkerSpec, type WorkerSpec } from "./spec-contract.js";

interface PendingApproval {
	resolve: (response: ToolApprovalResponsePayload) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout> | null;
}

export interface WorkerStdinDemux {
	feed(chunk: string): void;
	eof(): void;
	readSpec(): Promise<WorkerSpec>;
	awaitApproval(requestId: string, timeoutMs?: number): Promise<ToolApprovalResponsePayload>;
}

const DEFAULT_APPROVAL_TIMEOUT_MS = Number(process.env.CLIO_SDK_APPROVAL_TIMEOUT_MS ?? 60000);

export function createWorkerStdinDemux(): WorkerStdinDemux {
	let buffer = "";
	let specResolve: ((spec: WorkerSpec) => void) | null = null;
	let specReject: ((err: Error) => void) | null = null;
	let specValue: WorkerSpec | null = null;
	let specError: Error | null = null;
	let specReceived = false;
	let closed = false;
	const pending = new Map<string, PendingApproval>();

	function failPending(err: Error): void {
		for (const [, item] of pending) {
			if (item.timer) clearTimeout(item.timer);
			item.reject(err);
		}
		pending.clear();
	}

	function resolveSpec(spec: WorkerSpec): void {
		specValue = spec;
		specResolve?.(spec);
	}

	function rejectSpec(err: Error): void {
		specError = err;
		specReject?.(err);
	}

	function processLine(line: string): void {
		if (line.length === 0) return;
		if (!specReceived) {
			specReceived = true;
			try {
				resolveSpec(parseWorkerSpec(JSON.parse(line)));
			} catch (err) {
				rejectSpec(err instanceof Error ? err : new Error(String(err)));
			}
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isToolApprovalResponse(parsed)) return;
		const slot = pending.get(parsed.payload.requestId);
		if (!slot) return;
		if (slot.timer) clearTimeout(slot.timer);
		pending.delete(parsed.payload.requestId);
		slot.resolve(parsed.payload);
	}

	return {
		feed(chunk: string): void {
			if (closed) return;
			buffer += chunk;
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				processLine(line);
				idx = buffer.indexOf("\n");
			}
		},
		eof(): void {
			if (closed) return;
			closed = true;
			if (buffer.length > 0) {
				processLine(buffer);
				buffer = "";
			}
			if (!specReceived) rejectSpec(new Error("worker stdin closed before spec received"));
			failPending(new Error("worker stdin closed before approval response"));
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
		awaitApproval(requestId, timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS): Promise<ToolApprovalResponsePayload> {
			if (closed) return Promise.reject(new Error("worker stdin closed; cannot await approval"));
			return new Promise((resolve, reject) => {
				const timer =
					timeoutMs > 0
						? setTimeout(() => {
								pending.delete(requestId);
								reject(new Error(`approval ${requestId} timed out after ${timeoutMs}ms`));
							}, timeoutMs)
						: null;
				pending.set(requestId, { resolve, reject, timer });
			});
		},
	};
}
