import { useMemo, useSyncExternalStore } from "react";
import type { Client } from "../api/client.js";

type Drafts = Readonly<Record<string, string>>;
type DraftStore = ReturnType<typeof createDraftStore>;
const clients = new WeakMap<Client, Map<string, DraftStore>>();

function createDraftStore() {
	let drafts: Drafts = {};
	const listeners = new Set<() => void>();
	return {
		read: () => drafts,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		update: (change: (current: Drafts) => Drafts) => {
			const next = change(drafts);
			if (next === drafts) return;
			drafts = next;
			for (const listener of listeners) listener();
		},
	};
}

/** Safe control text stays in memory across sidebar switches, isolated to its client and workspace. */
export function useSettingsDrafts(client: Client, workspaceId: string) {
	const store = useMemo(() => {
		let workspaces = clients.get(client);
		if (!workspaces) {
			workspaces = new Map();
			clients.set(client, workspaces);
		}
		let drafts = workspaces.get(workspaceId);
		if (!drafts) {
			drafts = createDraftStore();
			workspaces.set(workspaceId, drafts);
		}
		return drafts;
	}, [client, workspaceId]);
	return [useSyncExternalStore(store.subscribe, store.read, store.read), store.update] as const;
}
