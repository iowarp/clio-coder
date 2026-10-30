import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "./client.js";
import {
	changedRequestEpoch,
	createRequestStore,
	type RequestIntent,
	type TrackedRequest,
	terminalOperation,
} from "./operation-request-model.js";

type Store = ReturnType<typeof createRequestStore>;
const clients = new WeakMap<Client, Map<string, Store>>();
function requestStore(client: Client, lane: string) {
	let lanes = clients.get(client);
	if (!lanes) {
		lanes = new Map();
		clients.set(client, lanes);
	}
	let store = lanes.get(lane);
	if (!store) {
		store = createRequestStore();
		lanes.set(lane, store);
	}
	return store;
}

/** Navigation may unmount the page while the server accepts its request. Retain that identity until resolved. */
export function useOperationRequest(
	client: Client,
	lane: "targets" | "evidence",
	submit: (request: TrackedRequest) => Promise<{ operationId: string }>,
) {
	const queries = useQueryClient();
	const store = useMemo(() => requestStore(client, lane), [client, lane]);
	const state = useSyncExternalStore(store.subscribe, store.read, store.read);
	const { request } = state;
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: ({ signal }) => client.call(routes.meta, emptyInput, undefined, signal),
		retry: false,
		refetchOnMount: "always",
		meta: { errorSurface: "inline" },
	});
	const epochChanged = changedRequestEpoch(request, meta.data?.epoch);
	const operation = useQuery<Operation>({
		queryKey: ["operation", request?.operationId ?? null],
		enabled: !!request?.operationId && !epochChanged,
		retry: false,
		refetchOnMount: "always",
		meta: { errorSurface: "inline" },
		refetchInterval: (query) => (query.state.error || epochChanged || store.read().request?.settled ? false : 1000),
		queryFn: async ({ signal }) => {
			if (!request?.operationId) throw new Error("No accepted operation to read.");
			const currentMeta = await client.call(routes.meta, emptyInput, undefined, signal);
			queries.setQueryData(["meta"], currentMeta);
			if (changedRequestEpoch(request, currentMeta.epoch))
				throw new Error("The server restarted. This operation belongs to the previous server.");
			const result = await client.call(
				routes.operation,
				{ ...emptyInput, params: { id: request.operationId } },
				undefined,
				signal,
			);
			const cached = queries.getQueryData<Operation>(["operation", request.operationId]);
			const latest = cached && cached.revision > result.revision ? cached : result;
			if (terminalOperation(latest)) store.patch(request.key, { settled: true });
			return latest;
		},
	});
	const send = async (sent: TrackedRequest) => {
		if (!store.sending(sent.key)) return;
		let error: string | null = null;
		try {
			const currentMeta = await client.call(routes.meta, emptyInput);
			queries.setQueryData(["meta"], currentMeta);
			if (changedRequestEpoch(sent, currentMeta.epoch))
				throw new Error("The server restarted. The original request cannot be replayed safely.");
			store.patch(sent.key, { epoch: currentMeta.epoch });
			const accepted = await submit({ ...sent, epoch: currentMeta.epoch });
			store.patch(sent.key, { operationId: accepted.operationId });
		} catch (cause) {
			error = cause instanceof Error ? cause.message : "Request outcome is unknown.";
		} finally {
			store.finish(sent.key, error);
		}
	};
	return {
		...state,
		meta,
		epochChanged,
		operation,
		busy: state.sending || (!!request && !request.settled) || (!!request?.operationId && operation.isError),
		start: (intent: RequestIntent) => {
			if (request?.operationId && operation.isError) return;
			const next = store.begin(intent, crypto.randomUUID());
			if (next) void send(next);
		},
		retry: () => {
			const original = store.read().request;
			if (original) void send(original);
		},
		forget: store.forget,
	};
}

/** Both consumers render recovery outside disabled submission controls. */
export function RequestRecovery({ tracking }: { tracking: ReturnType<typeof useOperationRequest> }) {
	const { request, operation, meta, epochChanged, sending, error } = tracking;
	if (!request)
		return meta.error ? (
			<p role="alert">
				Cannot read server status.{" "}
				<button type="button" onClick={() => void meta.refetch()}>
					Retry server status
				</button>
			</p>
		) : null;
	return (
		<section className="trace-panel" aria-label="Original request and recovery">
			<h2>Original request · {request.action}</h2>
			<p>
				Project <code>{request.workspaceId}</code> · Resource <code>{request.resourceId}</code>
			</p>
			{request.operationId && (
				<p>
					Accepted operation <code>{request.operationId}</code>
				</p>
			)}
			{sending && <p role="status">Sending original request…</p>}
			{error && <p role="alert">{error} The outcome remains unresolved until the original request is recovered.</p>}
			{epochChanged && (
				<p role="alert">
					The server restarted. This request belongs to the previous server and cannot be replayed. Review the project
					records before starting another action.
				</p>
			)}
			{meta.error && (
				<p role="alert">
					Server status unavailable: {meta.error.message}{" "}
					<button type="button" disabled={meta.isFetching} onClick={() => void meta.refetch()}>
						Retry server status
					</button>
				</p>
			)}
			{!request.operationId && !request.settled && (
				<button type="button" disabled={sending || epochChanged || meta.isPending || meta.isError} onClick={tracking.retry}>
					Retry original request
				</button>
			)}
			{request.operationId && !request.settled && !operation.error && !epochChanged && (
				<p role="status">Checking the accepted operation…</p>
			)}
			{operation.error && <p role="alert">Could not read the accepted operation: {operation.error.message}</p>}
			{request.operationId && (
				<button
					type="button"
					disabled={sending || operation.isFetching || epochChanged}
					onClick={() => void operation.refetch()}
				>
					Refresh operation status
				</button>
			)}
			{!sending && (error || operation.error || epochChanged) && (
				<details>
					<summary>Review forgetting this request</summary>
					<p>
						Forgetting only removes browser tracking. It does not cancel work or undo a completed action. Review this
						project's records first; submitting again with a new key may duplicate work.
					</p>
					<button type="button" onClick={tracking.forget}>
						I reviewed records; forget tracking
					</button>
				</details>
			)}
		</section>
	);
}
