// One run of the configure child, from the browser's side: start it, read each step, send an answer,
// go back, cancel. The child and its prompts are the server's (server/services/setup.ts); this hook
// only drives them and never keeps a credential. A text answer to a masked prompt is cleared by the
// caller the moment it is sent.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { SetupAnswer, SetupState } from "../../contracts/setup.js";
import { type Client, emptyInput } from "../api/client.js";

/** Everything a saved connection can change on screen. */
const AFTER_SAVE = [
	"setup-status",
	"settings-controls",
	"workspace-settings",
	"config-graph",
	"targets",
	"routing",
	"target-runtimes",
] as const;

const ENDED: ReadonlySet<SetupState["status"]> = new Set(["saved", "cancelled", "failed"]);

export interface SetupSession {
	readonly state: SetupState | null;
	/** A request is in flight. */
	readonly busy: boolean;
	/** The last request failed before the child could answer. */
	readonly error: string | null;
	start(targetId?: string): void;
	answer(answer: SetupAnswer): void;
	cancel(): void;
	/** Forget an ended run so the next start is a fresh one. */
	reset(): void;
}

export function useSetupSession(client: Client): SetupSession {
	const queries = useQueryClient();
	const [id, setId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const owned = useRef<string | null>(null);
	const alive = useRef(true);
	const locked = useRef(false);
	const announced = useRef<string | null>(null);
	const state = useQuery({
		queryKey: ["setup", id],
		queryFn: () => client.call(routes.setupState, { ...emptyInput, params: { id: id ?? "" } }),
		enabled: id !== null,
		// A working child changes quickly; an open prompt only changes if the child dies or times out.
		refetchInterval: (query) =>
			query.state.data === undefined || ENDED.has(query.state.data.status)
				? false
				: query.state.data.status === "working"
					? 250
					: 2000,
		refetchIntervalInBackground: false,
	});
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			// Leaving the wizard ends the child. A sign-in that already completed stays stored.
			if (owned.current)
				void client.call(routes.setupCancel, { ...emptyInput, params: { id: owned.current } }).catch(() => {
					// The child may already have exited, which is the outcome being asked for.
				});
		};
	}, [client]);
	useEffect(() => {
		if (state.data?.status !== "saved" || announced.current === state.data.id) return;
		announced.current = state.data.id;
		owned.current = null;
		for (const key of AFTER_SAVE) void queries.invalidateQueries({ queryKey: [key] });
	}, [state.data, queries]);

	const request = useCallback(
		async (run: () => Promise<SetupState>) => {
			if (locked.current) return;
			locked.current = true;
			setBusy(true);
			setError(null);
			try {
				const next = await run();
				if (!alive.current) {
					if (!ENDED.has(next.status)) await client.call(routes.setupCancel, { ...emptyInput, params: { id: next.id } });
					return;
				}
				queries.setQueryData(["setup", next.id], next);
				owned.current = ENDED.has(next.status) ? null : next.id;
				setId(next.id);
			} catch (problem) {
				if (alive.current) setError(problem instanceof Error ? problem.message : "Setup is unavailable.");
			} finally {
				locked.current = false;
				if (alive.current) setBusy(false);
			}
		},
		[client, queries],
	);

	return {
		state: state.data ?? null,
		busy,
		error: error ?? (state.error ? state.error.message : null),
		start: useCallback(
			(targetId?: string) =>
				void request(() => client.call(routes.setupStart, { ...emptyInput, body: targetId ? { targetId } : {} })),
			[client, request],
		),
		answer: useCallback(
			(answer: SetupAnswer) => {
				if (id === null) return;
				void request(() => client.call(routes.setupAnswer, { ...emptyInput, params: { id }, body: answer }));
			},
			[client, request, id],
		),
		cancel: useCallback(() => {
			if (id === null) return;
			void request(() => client.call(routes.setupCancel, { ...emptyInput, params: { id } }));
		}, [client, request, id]),
		reset: useCallback(() => {
			owned.current = null;
			setId(null);
			setError(null);
		}, []),
	};
}
