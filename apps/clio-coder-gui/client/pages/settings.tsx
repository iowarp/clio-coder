import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import "./settings.css";

export function useWorkspaceSelection(client: Client) {
	const [search, setSearch] = useSearchParams();
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const id = search.get("workspace") || workspaces.data?.[0]?.id || "";
	return { workspaces, id, select: (workspace: string) => setSearch({ workspace }) };
}
export function WorkspacePicker({ selection }: { selection: ReturnType<typeof useWorkspaceSelection> }) {
	const { workspaces, id, select } = selection;
	if (workspaces.error) return <p role="alert">{workspaces.error.message}</p>;
	if (workspaces.isPending) return <p>Reading workspaces…</p>;
	if (!workspaces.data.length)
		return (
			<p>
				<Link to="/sessions">Open a workspace</Link> to inspect its configuration.
			</p>
		);
	return (
		<label className="workspace-picker">
			Workspace
			<select value={id} onChange={(event) => select(event.target.value)}>
				{workspaces.data.map((row) => (
					<option key={row.id} value={row.id}>
						{row.name} · {row.path}
					</option>
				))}
			</select>
		</label>
	);
}

export function SettingsPage({ client, view }: { client: Client; view: "settings" | "why" }) {
	const selection = useWorkspaceSelection(client);
	const { id } = selection;
	const [filter, setFilter] = useState("");
	const settings = useQuery({
		queryKey: ["workspace-settings", id],
		queryFn: () => client.call(routes.workspaceSettings, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "settings",
	});
	const graph = useQuery({
		queryKey: ["config-graph", id],
		queryFn: () => client.call(routes.configGraph, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "why",
	});
	return (
		<section>
			<p className="eyebrow">Configuration / {view === "settings" ? "Effective values" : "Sources and precedence"}</p>
			<h1>{view === "settings" ? "Effective settings" : "Why Clio behaves this way"}</h1>
			<WorkspacePicker selection={selection} />
			<ConfigurationTabs id={id} active={view} />
			{view === "settings" &&
				id &&
				(settings.isPending ? (
					<p>Reading effective settings…</p>
				) : settings.error ? (
					<p role="alert">{settings.error.message}</p>
				) : (
					<>
						<p>Values are read from Clio’s configuration layers. Sensitive values and executable arguments are hidden.</p>
						<details className="trace-panel">
							<summary>Configuration layers</summary>
							<ul>
								{settings.data.layers.map((layer) => (
									<li key={layer.origin}>
										<strong>{layer.origin}</strong> · {layer.present ? "present" : "absent"}
										<br />
										<code>{layer.path}</code>
									</li>
								))}
							</ul>
						</details>
						{settings.data.issues.length > 0 && (
							<details className="trace-panel">
								<summary>Source issues · {settings.data.issues.length}</summary>
								<ul>
									{settings.data.issues.map((issue) => (
										<li key={`${issue.origin}:${issue.path}:${issue.kind}`}>
											<strong>
												{issue.origin} · {issue.path}
											</strong>{" "}
											— {issue.message}
										</li>
									))}
								</ul>
							</details>
						)}
						<label className="settings-filter">
							Filter settings
							<input type="search" value={filter} onChange={(event) => setFilter(event.target.value)} />
						</label>
						<dl className="settings-list">
							{settings.data.rows
								.filter((row) => row.key.toLowerCase().includes(filter.toLowerCase()))
								.map((row) => (
									<div key={row.key}>
										<dt>
											<code>{row.key}</code>
										</dt>
										<dd>
											{typeof row.value === "string" ? row.value : JSON.stringify(row.value)}
											{row.redacted && <small> · sensitive content hidden</small>}
										</dd>
										<dd className="setting-source">{row.source}</dd>
									</div>
								))}
						</dl>
					</>
				))}
			{view === "why" &&
				id &&
				(graph.isPending ? (
					<p>Inspecting configuration sources…</p>
				) : graph.error ? (
					<p role="alert">{graph.error.message}</p>
				) : (
					<>
						<p>
							These are the sources Clio discovered for this workspace, including their precedence, trust and reload behavior.
						</p>
						{graph.data.issues.length > 0 && (
							<details className="trace-panel">
								<summary>Inspection issues · {graph.data.issues.length}</summary>
								<ul>
									{graph.data.issues.map((issue) => (
										<li key={issue.category}>
											{issue.category} ({issue.count}): {issue.message}
										</li>
									))}
								</ul>
							</details>
						)}
						{graph.data.categories.map((category) => (
							<section key={category} className="config-category">
								<h2>{category}</h2>
								<div className="config-entries">
									{graph.data.entries
										.filter((entry) => entry.category === category)
										.map((entry) => (
											<article
												key={`${entry.category}:${entry.id}:${entry.scope}:${entry.sourcePath ?? ""}`}
												className="trace-panel"
											>
												<h3>{entry.id}</h3>
												<p>
													{entry.scope} · {entry.precedence ?? "precedence unspecified"} · {entry.trust ?? "trust unspecified"}
												</p>
												{entry.sourcePath && <p className="config-path">{entry.sourcePath}</p>}
												<p>
													Reload: {entry.reloadClass}
													{entry.contextCostTokens !== undefined && ` · Context: ${entry.contextCostTokens} tokens`}
												</p>
												{entry.hash && (
													<p>
														Hash: <code>{entry.hash}</code>
													</p>
												)}
												<dl>
													{Object.entries(entry.facts).map(([key, value]) => (
														<div className="config-fact" key={key}>
															<dt>{key}</dt>
															<dd>{String(value)}</dd>
														</div>
													))}
												</dl>
											</article>
										))}
								</div>
							</section>
						))}
					</>
				))}
		</section>
	);
}

export function ConfigurationTabs({ id, active }: { id: string; active: "settings" | "why" | "targets" | "routing" }) {
	return (
		<nav className="settings-tabs" aria-label="Configuration views">
			{[
				{ key: "settings", label: "Settings", path: "/settings" },
				{ key: "why", label: "Why", path: "/settings/why" },
				{ key: "targets", label: "Targets", path: "/settings/targets" },
				{ key: "routing", label: "Routing", path: "/settings/routing" },
			].map((tab) => (
				<Link key={tab.key} aria-current={active === tab.key ? "page" : undefined} to={`${tab.path}?workspace=${id}`}>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}
