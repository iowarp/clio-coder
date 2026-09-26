import { useMemo, useSyncExternalStore } from "react";
import type { Client } from "../api/client.js";

type Drafts = Readonly<Record<string, string>>;
type DraftStore = ReturnType<typeof createDraftStore>;
const clients = new WeakMap<Client, Map<string, DraftStore>>();

function createDraftStore() {
	let drafts: Drafts = {};
	const listeners = new Set<() => void>();
	const update = (change: (current: Drafts) => Drafts) => {
		const next = change(drafts);
		if (next === drafts) return;
		drafts = next;
		for (const listener of listeners) listener();
	};
	return {
		read: () => drafts,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		update,
		set: (path: string, value: string | null, submittedValue?: string) => {
			update((current) => {
				// A completed save must not erase a newer edit made by a reopened editor.
				if (submittedValue !== undefined && current[path] !== submittedValue) return current;
				const next = { ...current };
				if (value === null) delete next[path];
				else next[path] = value;
				return next;
			});
		},
	};
}

/** Safe control text stays in memory across sidebar switches, isolated to its client and workspace. */
export function settingsDraftStore(client: Client, workspaceId: string) {
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
}

export function useSettingsDrafts(client: Client, workspaceId: string) {
	const store = useMemo(() => settingsDraftStore(client, workspaceId), [client, workspaceId]);
	return [useSyncExternalStore(store.subscribe, store.read, store.read), store.update, store.set] as const;
}
