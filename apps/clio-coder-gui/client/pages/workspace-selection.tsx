import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useShell } from "../shell/shell-context.js";
import { settingsWorkspace } from "./config-map-model.js";
import "./workspace-selection.css";

export function useWorkspaceSelection(client: Client) {
	const [search, setSearch] = useSearchParams();
	const workspaces = useQuery({
		queryKey: ["workspaces"],
		queryFn: ({ signal }) => client.call(routes.workspaces, emptyInput, undefined, signal),
	});
	const shell = useShell();
	const requested = search.get("workspace");
	const id = settingsWorkspace(requested, shell?.activeWorkspaceId, workspaces.data ?? []);
	return {
		workspaces,
		id,
		missing: !!requested && !!workspaces.data && !id,
		select: (workspace: string) =>
			setSearch((current) => {
				const next = new URLSearchParams(current);
				next.set("workspace", workspace);
				return next;
			}),
	};
}

export function WorkspacePicker({
	selection,
	purpose = "inspection",
}: {
	selection: ReturnType<typeof useWorkspaceSelection>;
	purpose?: "settings" | "inspection";
}) {
	const { workspaces, id, select } = selection;
	const shell = useShell();
	if (workspaces.error)
		return (
			<div role="alert">
				<p>Projects could not be read: {workspaces.error.message}</p>
				<button type="button" disabled={workspaces.isFetching} onClick={() => void workspaces.refetch()}>
					Retry projects
				</button>
			</div>
		);
	if (workspaces.isPending) return <p role="status">Reading workspaces…</p>;
	if (!workspaces.data.length)
		return (
			<p>
				{shell ? (
					<button type="button" className="wb-link" onClick={shell.openWorkspace}>
						Open a workspace
					</button>
				) : (
					<Link to="/">Open a workspace</Link>
				)}{" "}
				to {purpose === "settings" ? "inspect its configuration" : "inspect its records"}.
			</p>
		);
	return (
		<label className="workspace-picker">
			<span className="workspace-picker__label">
				Project context
				<small>
					{purpose === "settings"
						? "Resolve values and overrides for this folder; saves go to your user settings"
						: "Choose the project to inspect"}
				</small>
			</span>
			<select value={id} onChange={(event) => select(event.target.value)}>
				{!id && (
					<option value="" disabled>
						Choose an open project
					</option>
				)}
				{workspaces.data.map((row) => (
					<option key={row.id} value={row.id}>
						{row.name} · {row.path}
					</option>
				))}
			</select>
			{selection.missing && (
				<small role="alert">The linked project is no longer open. Choose a project to continue.</small>
			)}
		</label>
	);
}
