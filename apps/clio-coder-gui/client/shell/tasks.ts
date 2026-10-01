// The verbs behind the sidebar: start a task, resume a saved one, close a running one, and remember
// which project the operator was last in. Every call goes through a route the old Sessions pages
// already used, so this adds no server surface.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { clock } from "../api/clock.js";
import { sessionBuffer } from "../api/sessions.js";
import { type ProjectLaunch, useProjectLaunch } from "../pages/project-open.js";
import { withRoom } from "./capacity.js";
import { isUntouched, sessionIdFromPath } from "./shell-model.js";

const WORKSPACE_KEY = "clio-coder-gui-workspace";

/** Per-session caches that a freshly loaded ledger can invalidate (it may bind a new ACP child). */
const SESSION_CACHES = [
	"session-capabilities",
	"session-commands",
	"session-queue",
	"session-settings",
	"session-targets",
	"session-autonomy",
] as const;

export function rememberedWorkspace(): string | null {
	try {
		return localStorage.getItem(WORKSPACE_KEY);
	} catch {
		return null;
	}
}

export function rememberWorkspace(id: string): void {
	try {
		localStorage.setItem(WORKSPACE_KEY, id);
	} catch {
		// The choice holds for this tab; the next visit falls back to the most recent project.
	}
}

export interface TaskActions {
	readonly launch: ProjectLaunch;
	/** Start a task in a project, or return to its untouched draft instead of spawning a second child. */
	newTask(workspaceId: string): void;
	resume(sessionId: string, workspaceId: string): void;
	readonly resuming: string | null;
	close(sessionId: string): void;
	readonly closing: string | null;
	readonly error: Error | null;
}

export function useTaskActions(client: Client, afterNavigate?: () => void): TaskActions {
	const navigate = useNavigate();
	const queries = useQueryClient();
	const launch = useProjectLaunch(client);
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const resume = useMutation({
		mutationFn: ({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) =>
			withRoom(client, queries, () =>
				client.call(routes.loadSession, { params: { id: sessionId }, query: {}, body: { workspaceId } }),
			),
		onSuccess: (session) => {
			for (const key of SESSION_CACHES) queries.removeQueries({ queryKey: [key, session.id] });
			queries.setQueryData(["session", session.id], sessionBuffer(session.id).snapshot(session) ?? session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			afterNavigate?.();
			void navigate(`/sessions/${session.id}`);
		},
	});
	const close = useMutation({
		mutationFn: (sessionId: string) =>
			client.call(routes.closeSession, { params: { id: sessionId }, query: {}, body: {} }),
		onSuccess: (snapshot) => {
			queries.setQueryData(["session", snapshot.id], sessionBuffer(snapshot.id).snapshot(snapshot) ?? snapshot);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void queries.invalidateQueries({ queryKey: ["session-history", snapshot.workspaceId] });
		},
	});
	const newTask = useCallback(
		(workspaceId: string) => {
			rememberWorkspace(workspaceId);
			const draft = sessions.data?.find((session) => session.workspaceId === workspaceId && isUntouched(session));
			afterNavigate?.();
			if (draft) void navigate(`/sessions/${draft.id}`);
			else launch.start(workspaceId);
		},
		[sessions.data, navigate, launch, afterNavigate],
	);
	return {
		launch,
		newTask,
		resume: (sessionId, workspaceId) => resume.mutate({ sessionId, workspaceId }),
		resuming: resume.isPending ? (resume.variables?.sessionId ?? null) : null,
		close: (sessionId) => close.mutate(sessionId),
		closing: close.isPending ? (close.variables ?? null) : null,
		error: resume.error ?? close.error ?? launch.error,
	};
}

/** Save a task's name. An empty label clears it, and the task is named by its first request again. */
export function useRenameTask(client: Client) {
	const queries = useQueryClient();
	return useMutation({
		mutationFn: async ({ sessionId, workspaceId, label }: { sessionId: string; workspaceId: string; label: string }) => {
			try {
				return await client.call(routes.labelSession, {
					params: { id: sessionId },
					query: {},
					body: { label, workspaceId },
				});
			} catch (error) {
				// A task joins the saved history once Clio has answered in it, and only saved tasks can be named.
				if (error instanceof ApiProblem && error.problem.status === 404)
					throw new Error("This task is not saved yet. Rename it after Clio has answered once.");
				throw error;
			}
		},
		onSuccess: (_result, { sessionId, workspaceId }) => {
			void queries.invalidateQueries({ queryKey: ["session", sessionId] });
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void queries.invalidateQueries({ queryKey: ["session-history", workspaceId] });
		},
	});
}

/** Delete a saved task for good. The caller asks first; leaving the deleted task's own page is handled here. */
export function useDeleteTask(client: Client) {
	const queries = useQueryClient();
	const navigate = useNavigate();
	const location = useLocation();
	return useMutation({
		mutationFn: ({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }) =>
			client.call(routes.deleteSession, { params: { id: sessionId }, query: {}, body: { workspaceId } }),
		onSuccess: (_result, { sessionId, workspaceId }) => {
			// The composer's draft store is part of the task screen's code, which the shell does not load up front.
			void import("../chat/composer-model.js").then((composer) => composer.discardDraftStore(sessionId));
			queries.removeQueries({ queryKey: ["session", sessionId] });
			void queries.invalidateQueries({ queryKey: ["session-history", workspaceId] });
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			if (sessionIdFromPath(location.pathname) === sessionId) void navigate("/");
		},
	});
}

/** A minute-resolution clock for relative ages, so a list of "5m" labels does not freeze. */
export function useMinuteClock(): number {
	const [now, setNow] = useState(() => clock.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(clock.now()), 30_000);
		return () => clearInterval(timer);
	}, []);
	return now;
}
