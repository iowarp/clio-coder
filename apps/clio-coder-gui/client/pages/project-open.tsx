// Choosing a project and starting a conversation in it. Overview and the Sessions page share this, so
// a first visit reaches a conversation in two actions (choose a folder, Start conversation) from the
// front door, and a recent project's New conversation behaves the same on both pages.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { sessionBuffer } from "../api/sessions.js";
import { WorkspaceBrowser } from "./workspace-browser.js";

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
			client.call(routes.newSession, { params: { id: workspaceId }, query: {}, body: {} }),
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

export function ProjectOpenForm({ client, launch }: { client: Client; launch: ProjectLaunch }) {
	const [path, setPath] = useState("");
	const [browsing, setBrowsing] = useState(false);
	const pathId = useId();
	const pathField = useRef<HTMLInputElement>(null);
	const browseButton = useRef<HTMLButtonElement>(null);
	const { busy } = launch;
	return (
		<>
			<form
				className="project-open"
				onSubmit={(event) => {
					event.preventDefault();
					launch.open(path.trim(), true);
				}}
			>
				<label className="project-open__label" htmlFor={pathId}>
					Project folder
				</label>
				<div className="project-open__row">
					<input
						id={pathId}
						ref={pathField}
						value={path}
						onChange={(event) => setPath(event.target.value)}
						placeholder="/absolute/path/to/project"
						autoComplete="off"
						spellCheck={false}
						required
					/>
					<button ref={browseButton} type="button" disabled={busy} onClick={() => setBrowsing((current) => !current)}>
						{browsing ? "Hide folders" : "Browse folders"}
					</button>
					<button className="primary" type="submit" disabled={busy || path.trim() === ""}>
						{busy ? "Starting…" : "Start conversation"}
					</button>
				</div>
				<p className="project-open__more">
					<button
						type="button"
						className="text-button"
						disabled={busy || path.trim() === ""}
						onClick={() => launch.open(path.trim(), false)}
					>
						View saved sessions
					</button>{" "}
					for this folder instead of starting a new one.
				</p>
			</form>
			{browsing && (
				<WorkspaceBrowser
					client={client}
					initialPath={path}
					onStart={(selected) => {
						setPath(selected);
						setBrowsing(false);
						launch.open(selected, true);
					}}
					onClose={() => {
						setBrowsing(false);
						browseButton.current?.focus();
					}}
					onChoose={(selected) => {
						setPath(selected);
						setBrowsing(false);
						pathField.current?.focus();
					}}
				/>
			)}
		</>
	);
}
