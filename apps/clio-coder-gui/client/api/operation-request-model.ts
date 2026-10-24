import type { Operation } from "../../contracts/operations.js";

export type RequestIntent = Readonly<{
	workspaceId: string;
	resourceId: string;
	action: string;
}>;
export type TrackedRequest = RequestIntent &
	Readonly<{
		key: string;
		epoch: string | null;
		operationId: string | null;
		settled: boolean;
	}>;
export function terminalOperation(operation: Operation) {
	return operation.status !== "queued" && operation.status !== "running";
}
export function changedRequestEpoch(request: TrackedRequest | null, epoch: string | undefined) {
	return request?.epoch != null && epoch !== undefined && request.epoch !== epoch;
}
export function createRequestStore() {
	let state: { request: TrackedRequest | null; sending: boolean; error: string | null } = {
		request: null,
		sending: false,
		error: null,
	};
	const listeners = new Set<() => void>();
	const update = (next: typeof state) => {
		state = next;
		for (const listener of listeners) listener();
	};
	return {
		read: () => state,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		begin: (intent: RequestIntent, key: string) => {
			if (state.sending || (state.request && !state.request.settled)) return null;
			const request: TrackedRequest = { ...intent, key, epoch: null, operationId: null, settled: false };
			update({ request, sending: false, error: null });
			return request;
		},
		sending: (key: string) => {
			if (state.sending || state.request?.key !== key || state.request.operationId || state.request.settled) return false;
			update({ ...state, sending: true, error: null });
			return true;
		},
		patch: (key: string, patch: Partial<Pick<TrackedRequest, "epoch" | "operationId" | "settled">>) => {
			if (state.request?.key !== key) return;
			update({ ...state, request: { ...state.request, ...patch } });
		},
		finish: (key: string, error: string | null) => {
			if (state.request?.key !== key) return;
			update({ ...state, sending: false, error });
		},
		forget: () => {
			if (!state.sending) update({ request: null, sending: false, error: null });
		},
	};
}
