import type { ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { Client } from "../api/client.js";
import { useShell } from "../shell/shell-context.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import type { SettingsScopeId } from "./settings-control-model.js";
import { SettingsControlsView } from "./settings-controls.js";
import { setupLink } from "./target-onboarding.js";
import "./general.css";

/**
 * One calm page of Settings. The controls are the runtime registry's own, taken by section and group
 * (settings-control-model.ts), written to the user layer through the same adapters as ever. Each shows
 * where its value comes from and when it takes effect, quietly, in the engine's words.
 */
function SettingsPageFrame({
	client,
	scope,
	title,
	lede,
	before,
	after,
}: {
	client: Client;
	scope: SettingsScopeId;
	title: string;
	lede: string;
	before?: ReactNode;
	after?: ReactNode;
}) {
	const shell = useShell();
	const [search] = useSearchParams();
	const selection = useWorkspaceSelection(client);
	const id = search.get("workspace") || shell?.activeWorkspaceId || selection.id;
	return (
		<section className="general settings-page">
			<div className="panel-heading">
				<div>
					<h1>{title}</h1>
					<p className="settings-page__lede">{lede}</p>
				</div>
			</div>
			{before}
			{(selection.workspaces.data?.length ?? 0) > 1 ? <WorkspacePicker selection={selection} /> : null}
			{id ? (
				<SettingsControlsView key={`${id}:${scope}`} client={client} workspaceId={id} scope={scope} />
			) : selection.workspaces.isPending ? (
				<p>Reading settings…</p>
			) : (
				<p className="settings-page__note">
					Settings are read for a project.{" "}
					<button type="button" className="wb-link" onClick={() => shell?.openWorkspace()}>
						Open a workspace
					</button>{" "}
					to see them.
				</p>
			)}
			{after}
		</section>
	);
}

export function ModelsSettings({ client }: { client: Client }) {
	return (
		<SettingsPageFrame
			client={client}
			scope="models"
			title="Models"
			lede="Which model answers, and how it answers. Connections and sign-in are set up in the guided setup."
			before={
				<ul className="settings-page__links">
					<li>
						<Link to={setupLink()} state={{ from: "/settings/models" }}>
							Add a connection <span aria-hidden="true">→</span>
						</Link>
						<small>Guided setup for an app, a server, a subscription or an API account.</small>
					</li>
					<li>
						<Link to="/settings/targets">
							Connections <span aria-hidden="true">→</span>
						</Link>
						<small>Check each connection, choose the one that answers, repair or remove one.</small>
					</li>
					<li>
						<Link to="/settings/routing">
							Routing <span aria-hidden="true">→</span>
						</Link>
						<small>Which model each profile and agent uses.</small>
					</li>
				</ul>
			}
		/>
	);
}

export function SafetySettings({ client }: { client: Client }) {
	return (
		<SettingsPageFrame
			client={client}
			scope="safety"
			title="Safety"
			lede="What Clio may do without asking, and the limits on spending, tools and workers."
		/>
	);
}

export function ContextSettings({ client }: { client: Client }) {
	return (
		<SettingsPageFrame
			client={client}
			scope="context"
			title="Context and memory"
			lede="How Clio keeps a long conversation useful, and what it remembers between sessions."
		/>
	);
}

export function AdvancedSettings({ client }: { client: Client }) {
	return (
		<SettingsPageFrame
			client={client}
			scope="advanced"
			title="All settings"
			lede="Every other setting the runtime offers, with search. Each one is saved to your user settings."
			before={
				<ul className="settings-page__links">
					<li>
						<Link to="/settings/effective">
							Effective values <span aria-hidden="true">→</span>
						</Link>
						<small>What is in force right now, and which layer set it.</small>
					</li>
					<li>
						<Link to="/settings/why">
							Sources and timing <span aria-hidden="true">→</span>
						</Link>
						<small>How the layers combine and when each change takes effect.</small>
					</li>
				</ul>
			}
		/>
	);
}
