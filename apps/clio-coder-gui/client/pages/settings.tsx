import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { humanizeKey, scalarText } from "../design/facts-model.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { useShell } from "../shell/shell-context.js";
import {
	configMap,
	entrySource,
	matchesConfigEntry,
	RELOAD_PRESENTATION,
	SETTING_SOURCE_LABELS,
	settingFamilies,
	settingsWorkspace,
	settingValue,
} from "./config-map-model.js";
import { SettingsControlsView } from "./settings-controls.js";
import { ConnectionSetup } from "./target-onboarding.js";
import "../design/facts.css";
import "./settings.css";

export function useWorkspaceSelection(client: Client) {
	const [search, setSearch] = useSearchParams();
	const workspaces = useQuery({
		queryKey: ["workspaces"],
		queryFn: () => client.call(routes.workspaces, emptyInput),
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
export function WorkspacePicker({ selection }: { selection: ReturnType<typeof useWorkspaceSelection> }) {
	const { workspaces, id, select } = selection;
	if (workspaces.error)
		return (
			<div role="alert">
				<p>Projects could not be read: {workspaces.error.message}</p>
				<button type="button" onClick={() => void workspaces.refetch()}>
					Retry projects
				</button>
			</div>
		);
	if (workspaces.isPending) return <p>Reading workspaces…</p>;
	if (!workspaces.data.length)
		return (
			<p>
				<Link to="/sessions">Open a workspace</Link> to inspect its configuration.
			</p>
		);
	return (
		<label className="workspace-picker">
			<span className="workspace-picker__label">
				Project context <small>Resolve values and overrides for this folder; saves go to your user settings</small>
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

export function SettingsPage({ client, view }: { client: Client; view: "settings" | "effective" | "why" }) {
	const selection = useWorkspaceSelection(client);
	const { id } = selection;
	const [search, setSearch] = useSearchParams();
	const filter = search.get("q") ?? "";
	const setFilter = (query: string) =>
		setSearch(
			(current) => {
				const next = new URLSearchParams(current);
				if (query) next.set("q", query);
				else next.delete("q");
				return next;
			},
			{ replace: true },
		);
	const settings = useQuery({
		queryKey: ["workspace-settings", id],
		meta: { errorSurface: "inline" },
		queryFn: () => client.call(routes.workspaceSettings, { ...emptyInput, params: { id } }),
		// The map's first figure and its source counts are read from the same effective values.
		enabled: !!id && view !== "settings",
	});
	const graph = useQuery({
		queryKey: ["config-graph", id],
		meta: { errorSurface: "inline" },
		queryFn: () => client.call(routes.configGraph, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "why",
	});
	const panel =
		view === "settings" ? PANELS.settings : view === "effective" ? PANELS.settingsEffective : PANELS.configMap;
	const families = settings.data ? settingFamilies(settings.data.rows, filter) : [];
	const map = graph.data ? configMap(graph.data, settings.data ?? null) : null;
	return (
		<section className="settings-inspection">
			<PanelHeading panel={panel} level={1} />
			<WorkspacePicker selection={selection} />
			{view !== "settings" && <ConfigurationTabs id={id} active={view} />}
			{!id && view === "settings" && <ConnectionSetup />}
			{!id && view !== "settings" && !selection.workspaces.isPending && (
				<PanelEmpty>{emptyState.unread("configuration of a workspace")}</PanelEmpty>
			)}
			{view === "settings" && id && <SettingsControlsView key={id} client={client} workspaceId={id} />}
			{view === "effective" &&
				id &&
				(settings.isPending ? (
					<p>Reading effective settings…</p>
				) : settings.error ? (
					<div className="settings-refresh" role="alert">
						<span>{settings.error.message}</span>
						<button type="button" disabled={settings.isFetching} onClick={() => void settings.refetch()}>
							Retry settings
						</button>
					</div>
				) : (
					<>
						<p>Effective values for this workspace. Sensitive values stay hidden.</p>
						<ol className="settings-precedence" aria-label="Setting precedence, lowest to highest">
							{Object.values(SETTING_SOURCE_LABELS).map((label) => (
								<li key={label}>{label}</li>
							))}
						</ol>
						<p className="panel-note">Later layers override earlier ones. GUI edits save to the user layer.</p>
						<details className="trace-panel">
							<summary>Configuration layers · {settings.data.layers.length}</summary>
							<ul className="config-layers">
								{settings.data.layers.map((layer) => (
									<li key={layer.origin}>
										<strong>{SETTING_SOURCE_LABELS[layer.origin]}</strong>{" "}
										<StatusMark tone={layer.present ? "success" : "neutral"} label={layer.present ? "File present" : "No file"} />
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
												{SETTING_SOURCE_LABELS[issue.origin]} · {issue.path}
											</strong>
											<br />
											{issue.message}
										</li>
									))}
								</ul>
							</details>
						)}
						<label className="settings-filter">
							Filter settings
							<input
								type="search"
								placeholder="Search by key, value or source"
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
							/>
							<span className="settings-filter__count" role="status">
								{families.reduce((count, family) => count + family.rows.length, 0)} of {settings.data.rows.length} settings
								shown
							</span>
						</label>
						{!settings.data.rows.length && (
							<PanelEmpty>{emptyState.emptyStore("effective setting", "for this workspace")}</PanelEmpty>
						)}
						{!!settings.data.rows.length && !families.length && (
							<div className="settings-empty">
								<p>No settings match “{filter}”.</p>
								<button type="button" onClick={() => setFilter("")}>
									Clear search
								</button>
							</div>
						)}
						{families.map(({ family, rows }) => (
							<details
								className="setting-family"
								key={family}
								open={!!filter.trim() || family === "chat" || family === "safety" || family === families[0]?.family}
							>
								<summary>
									<code>{family}</code>
									<span className="count">{rows.length}</span>
								</summary>
								<dl className="settings-list">
									{rows.map((row) => (
										<div key={row.key}>
											<dt>
												<code className="setting-key">{row.key}</code>
											</dt>
											<dd>
												{settingValue(row)}
												{row.redacted && <small>Sensitive content hidden</small>}
											</dd>
											<dd className="setting-source">
												{SETTING_SOURCE_LABELS[row.source]}
												<Link to={`/settings?${new URLSearchParams({ workspace: id, q: row.key })}`}>Find control</Link>
											</dd>
										</div>
									))}
								</dl>
							</details>
						))}
						<Boundary panel={panel} />
					</>
				))}
			{view === "why" &&
				id &&
				(graph.isPending ? (
					<p>Inspecting configuration sources…</p>
				) : graph.error ? (
					<div className="settings-refresh" role="alert">
						<span>{graph.error.message}</span>
						<button type="button" disabled={graph.isFetching} onClick={() => void graph.refetch()}>
							Retry sources
						</button>
					</div>
				) : map ? (
					<>
						<p>
							A snapshot of the layers Clio Coder says it loaded for this workspace, where they came from, and when a change to
							each one takes effect.
						</p>
						{settings.error && (
							<div className="settings-refresh" role="alert">
								<span>{settings.error.message}</span>
								<button type="button" disabled={settings.isFetching} onClick={() => void settings.refetch()}>
									Retry settings
								</button>
							</div>
						)}
						<div className="panel-figures">
							{map.figures.map((figure) => (
								<article className="trace-panel" key={figure.label}>
									<h2>{figure.label}</h2>
									<p className="panel-figure">{figure.value}</p>
									<small>{figure.note}</small>
								</article>
							))}
						</div>
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
						<h2>From source to behavior</h2>
						<ol className="influence-path">
							<li>
								<span className="influence-path__index">01</span>
								<h3>Sources</h3>
								<p>Scopes and setting layers Clio Coder inspected.</p>
								<ul>
									{map.sources.map((source) => (
										<li key={source.label}>
											<span>{source.label}</span>
											<strong>{source.count.toLocaleString("en-US")}</strong>
										</li>
									))}
								</ul>
								{map.sourcesOmitted > 0 && <PanelEmpty>{emptyState.bounded("rarer sources", "Later")}</PanelEmpty>}
							</li>
							<li>
								<span className="influence-path__index">02</span>
								<h3>Loaded layers</h3>
								<p>Surfaces in the effective graph, by category.</p>
								<ul>
									{map.layers.map((layer) => (
										<li key={layer.category}>
											<span>
												<code>{layer.short}</code> {layer.label}
											</span>
											<strong>{layer.count.toLocaleString("en-US")}</strong>
										</li>
									))}
								</ul>
							</li>
							<li>
								<span className="influence-path__index">03</span>
								<h3>Behavior</h3>
								<p>When Clio Coder says each surface can change what it does.</p>
								<ul>
									{map.timing.map((row) => (
										<li key={row.label}>
											<span>
												{row.label}
												<small>{row.description}</small>
											</span>
											<strong>{row.count.toLocaleString("en-US")}</strong>
										</li>
									))}
								</ul>
							</li>
						</ol>
						{!map.layers.length && (
							<PanelEmpty>{emptyState.emptyStore("customization surface", "for this workspace")}</PanelEmpty>
						)}
						<label className="settings-filter">
							Find a configuration source
							<input
								type="search"
								placeholder="Search by source, path, trust or timing"
								value={filter}
								onChange={(event) => setFilter(event.target.value)}
							/>
						</label>
						{filter && !map.layers.some((layer) => layer.entries.some((entry) => matchesConfigEntry(entry, filter))) && (
							<div className="settings-empty">
								<p>No sources match “{filter}”.</p>
								<button type="button" onClick={() => setFilter("")}>
									Clear search
								</button>
							</div>
						)}
						{map.layers
							.filter((layer) => layer.entries.some((entry) => matchesConfigEntry(entry, filter)))
							.map((layer, index) => (
								<details key={layer.category} className="config-category" open={!!filter.trim() || index === 0}>
									<summary>
										<h2>
											<code>{layer.short}</code> {layer.label} · {layer.count}
										</h2>
									</summary>
									<p className="panel-note">{layer.description}</p>
									<div className="config-entries">
										{layer.entries
											.filter((entry) => matchesConfigEntry(entry, filter))
											.map((entry) => (
												<article
													key={`${entry.category}:${entry.id}:${entry.scope}:${entry.sourcePath ?? ""}`}
													className="trace-panel"
												>
													<h3>{entry.id}</h3>
													<p className="config-path">{entrySource(entry)}</p>
													<ul className="fact__chips">
														<li title={RELOAD_PRESENTATION[entry.reloadClass].description}>
															{RELOAD_PRESENTATION[entry.reloadClass].label}
														</li>
														{entry.trust && entry.trust !== "n/a" && <li>{entry.trust}</li>}
														{entry.precedence && <li>{entry.precedence}</li>}
														{entry.contextCostTokens !== undefined && (
															<li>~{entry.contextCostTokens.toLocaleString("en-US")} context tokens</li>
														)}
													</ul>
													{entry.hash && (
														<p>
															Content fingerprint <code>{entry.hash}</code>
														</p>
													)}
													{!!Object.keys(entry.facts).length && (
														<dl className="facts">
															{Object.entries(entry.facts).map(([key, value]) => (
																<div className="fact" key={key}>
																	<dt>{humanizeKey(key)}</dt>
																	<dd>{scalarText(key, value).text}</dd>
																</div>
															))}
														</dl>
													)}
												</article>
											))}
									</div>
								</details>
							))}
						<Boundary panel={panel} />
					</>
				) : null)}
			{view === "settings" && id && <Boundary panel={panel} />}
		</section>
	);
}

export function ConfigurationTabs({
	id,
	active,
}: {
	id: string;
	active: "settings" | "effective" | "why" | "targets" | "routing";
}) {
	return (
		<nav className="settings-tabs" aria-label="Configuration views">
			{[
				{ key: "settings", label: "Model settings", path: "/settings/models" },
				{ key: "targets", label: "Connections", path: "/settings/targets" },
				{ key: "routing", label: "Fleet routes", path: "/settings/routing" },
				{ key: "effective", label: "Effective values", path: "/settings/effective" },
				{ key: "why", label: "Sources & timing", path: "/settings/why" },
			].map((tab) => (
				<Link
					key={tab.key}
					aria-current={active === tab.key ? "page" : undefined}
					to={id ? `${tab.path}?${new URLSearchParams({ workspace: id })}` : tab.path}
				>
					{tab.label}
				</Link>
			))}
		</nav>
	);
}
