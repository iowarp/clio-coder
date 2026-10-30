import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import type { SessionControlRequest, SessionControlTarget } from "./session-control-model.js";
import { createSessionControlStore, observedControlOutcome } from "./session-control-model.js";

const clients = new WeakMap<Client, ReturnType<typeof createSessionControlStore>>();
export function useSessionControls(client: Client) {
	const queries = useQueryClient();
	const [notice, setNotice] = useState<string | null>(null);
	const store = useMemo(() => {
		let value = clients.get(client);
		if (!value) {
			value = createSessionControlStore();
			clients.set(client, value);
		}
		return value;
	}, [client]);
	const records = useSyncExternalStore(store.subscribe, store.read, store.read);
	const currentEpoch = () => client.currentEpoch() ?? queries.getQueryData<{ epoch: string }>(["meta"])?.epoch ?? null;
	const refreshLists = () => {
		for (const key of ["session-overview", "sessions", "session-history"])
			void queries.invalidateQueries({ queryKey: [key] });
	};
	const send = async (original: SessionControlRequest) => {
		store.patch(original.key, { stage: "sending", message: "Sending the original control request…" });
		try {
			const meta = await client.call(routes.meta, emptyInput);
			queries.setQueryData(["meta"], meta);
			if (original.epoch !== null && original.epoch !== meta.epoch) {
				store.patch(original.key, { restarted: true });
				throw new Error(
					"Clio restarted. This request will not be replayed. Refresh the recorded session state before continuing.",
				);
			}
			store.patch(original.key, { epoch: meta.epoch });
			if (original.action === "close") {
				const snapshot = await client.call(
					routes.closeSession,
					{ ...emptyInput, params: { id: original.sessionId } },
					original.key,
					undefined,
					meta.epoch,
				);
				const accepted = sessionBuffer(snapshot.id).snapshot(snapshot) ?? snapshot;
				queries.setQueryData(["session", snapshot.id], accepted);
				const closed = observedControlOutcome(original, accepted);
				store.patch(original.key, {
					stage: closed ? "complete" : "unresolved",
					message: closed
						? "This session is closed. Its recorded conversation remains available."
						: "Clio returned a session whose closure is unconfirmed. Refresh its recorded state before starting another control.",
				});
			} else {
				await client.call(
					routes.cancelTurn,
					{ ...emptyInput, params: { id: original.sessionId, turnId: original.turnId ?? "" } },
					original.key,
					undefined,
					meta.epoch,
				);
				store.patch(original.key, {
					stage: "complete",
					message:
						"Clio accepted the stop request for the original turn. Refresh or open the session to inspect its outcome.",
				});
			}
			refreshLists();
			void queries.invalidateQueries({ queryKey: ["session", original.sessionId] });
		} catch (error) {
			store.patch(original.key, { stage: "unresolved", message: error instanceof Error ? error.message : String(error) });
		}
	};
	return {
		records,
		notice,
		currentEpoch,
		start: (item: SessionControlTarget, action: "stop" | "close", expectedEpoch: string | null = currentEpoch()) => {
			if (action === "stop" && !item.currentTurnId) return;
			const request: SessionControlRequest = {
				sessionId: item.id,
				workspaceId: item.workspaceId,
				title: item.title,
				action,
				turnId: action === "stop" ? item.currentTurnId : null,
				key: crypto.randomUUID(),
				epoch: expectedEpoch,
				stage: "sending",
				message: "Checking Clio before submitting…",
				restarted: false,
			};
			try {
				if (store.begin(request)) {
					setNotice(null);
					void send(request);
				}
			} catch (error) {
				setNotice(error instanceof Error ? error.message : String(error));
			}
		},
		retry: (key: string) => {
			const request = store.read().find((row) => row.key === key);
			if (request?.stage === "unresolved" && !request.restarted) void send(request);
		},
		inspect: async (key: string) => {
			const request = store.read().find((row) => row.key === key);
			if (!request || request.stage === "sending") return;
			store.patch(key, { stage: "sending", message: "Reading the original session's recorded state…" });
			try {
				const snapshot = await client.call(routes.session, { ...emptyInput, params: { id: request.sessionId } });
				const accepted = sessionBuffer(snapshot.id).snapshot(snapshot) ?? snapshot;
				queries.setQueryData(["session", snapshot.id], accepted);
				const outcome = observedControlOutcome(request, accepted);
				store.patch(key, {
					stage: outcome ? "complete" : "unresolved",
					message: outcome ?? "The original action is not confirmed by this snapshot. Review the session before retrying.",
				});
				refreshLists();
			} catch (error) {
				store.patch(key, { stage: "unresolved", message: error instanceof Error ? error.message : String(error) });
			}
		},
		dismiss: (key: string) => {
			if (store.read().find((row) => row.key === key)?.stage === "complete") store.remove(key);
		},
		forget: (key: string) => {
			if (store.read().find((row) => row.key === key)?.stage === "unresolved") store.remove(key);
		},
		clearNotice: () => setNotice(null),
	};
}
export type SessionControls = ReturnType<typeof useSessionControls>;
