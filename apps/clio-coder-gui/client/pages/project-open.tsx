// Opening a project and starting a task in it, one launch at a time. The rail, the project task list
// and the Open workspace dialog all start tasks through this hook.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import { withRoom } from "../shell/capacity.js";

export interface ProjectLaunch {
	/** Open a folder as a project, then start a conversation there or show its saved ones. */
	open(projectPath: string, startConversation: boolean): void;
	/** Start a new conversation in a project already opened here. */
	start(workspaceId: string): void;
	readonly busy: boolean;
	/** The project a conversation is starting in, for its button's "Starting…". */
	readonly starting: string | null;
	readonly error: Error | null;
}

/** One launch at a time, however many buttons are pressed, so a double press opens one conversation. */
export function useProjectLaunch(client: Client): ProjectLaunch {
	const navigate = useNavigate(),
		queries = useQueryClient();
	const inFlight = useRef(false);
	const start = useMutation({
		mutationFn: (workspaceId: string) =>
			withRoom(client, queries, () =>
				client.call(routes.newSession, { params: { id: workspaceId }, query: {}, body: {} }),
			),
		onSuccess: (session) => {
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/sessions/${session.id}`);
		},
		onSettled: () => {
			inFlight.current = false;
		},
	});
	const open = useMutation({
		mutationFn: ({ projectPath }: { projectPath: string; startConversation: boolean }) =>
			client.call(routes.openWorkspace, { ...emptyInput, body: { path: projectPath } }),
		onSuccess: (workspace, request) => {
			void queries.invalidateQueries({ queryKey: ["workspaces"] });
			if (request.startConversation) start.mutate(workspace.id);
			else {
				inFlight.current = false;
				void navigate(`/workspaces/${workspace.id}/sessions`);
			}
		},
		onError: () => {
			inFlight.current = false;
		},
	});
	return {
		open: (projectPath, startConversation) => {
			if (inFlight.current) return;
			inFlight.current = true;
			open.mutate({ projectPath, startConversation });
		},
		start: (workspaceId) => {
			if (inFlight.current) return;
			inFlight.current = true;
			start.mutate(workspaceId);
		},
		busy: open.isPending || start.isPending,
		starting: start.isPending ? start.variables : null,
		error: open.error ?? start.error,
	};
}
