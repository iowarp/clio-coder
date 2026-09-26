import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { emptyInput } from "../api/client.js";
import { SETTING_SOURCE_LABELS } from "../pages/config-map-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "../pages/settings.js";
import { SettingsControlsView } from "../pages/settings-controls.js";
import type { AreaNavigationProps } from "./area-navigation-props.js";
import "./settings-navigation.css";

/** Uses the same typed controls and write operations as the full settings viewer. */
export function SettingsNavigation({ client, close, workspaceId }: AreaNavigationProps) {
	const selection = useWorkspaceSelection(client);
	const id = workspaceId ?? selection.id;
	const [inspectSources, setInspectSources] = useState(false);
	const settings = useQuery({
		queryKey: ["workspace-settings", id],
		queryFn: () => client.call(routes.workspaceSettings, { ...emptyInput, params: { id } }),
		enabled: !!id && inspectSources,
	});
	const workspace = selection.workspaces.data?.find((row) => row.id === id);
	return (
		<section className="sidebar-settings" aria-label="Workspace settings">
			<div className="sidebar-settings__toolbar">
				{workspaceId ? (
					<p className="sidebar-note">{workspace?.name ?? "Current project"}</p>
				) : (
					<WorkspacePicker selection={selection} />
				)}
				<Link to={`/settings?${new URLSearchParams({ workspace: id })}`} onClick={close}>
					Open Settings page
				</Link>
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll the settings editor independently. */}
			<section className="sidebar-settings__content" tabIndex={0} aria-label="Settings editor">
				{id ? (
					<SettingsControlsView key={id} client={client} workspaceId={id} compact />
				) : (
					<p className="sidebar-note">Open a project to inspect and edit its settings.</p>
				)}
				{id && (
					<details className="sidebar-settings__sources" onToggle={(event) => setInspectSources(event.currentTarget.open)}>
						<summary>Effective layers and sources</summary>
						{settings.isPending && inspectSources && <p role="status">Reading configuration sources…</p>}
						{settings.error && (
							<p role="alert">
								{settings.error.message}{" "}
								<button type="button" onClick={() => void settings.refetch()}>
									Retry
								</button>
							</p>
						)}
						{settings.data && (
							<ul>
								{settings.data.layers.map((layer) => (
									<li key={layer.origin}>
										<strong>{SETTING_SOURCE_LABELS[layer.origin]}</strong>
										<span>{layer.present ? "File present" : "No file"}</span>
										<code>{layer.path}</code>
									</li>
								))}
							</ul>
						)}
						<Link to={`/settings/effective?${new URLSearchParams({ workspace: id })}`} onClick={close}>
							Open effective values page
						</Link>
						<Link to={`/settings/why?${new URLSearchParams({ workspace: id })}`} onClick={close}>
							Open sources and timing page
						</Link>
					</details>
				)}
			</section>
		</section>
	);
}
