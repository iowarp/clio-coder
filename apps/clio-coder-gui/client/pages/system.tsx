import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Link, NavLink, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { humanizeKey } from "../design/facts-model.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import {
	adapterText,
	decisionOffer,
	decisionOutcome,
	INTEROP_FILTER_LABELS,
	INTEROP_FILTERS,
	type InteropAgent,
	interopSummary,
	matchesAgent,
	orderedAgents,
	presenceMark,
	versionText,
	wiringMark,
	wiringSentence,
} from "./interop-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { findingAction, findingCollapsed, healthGroups, healthOverview, SYSTEM_FOLDERS } from "./system-model.js";
import "../design/facts.css";
import "./system.css";

function SystemTabs() {
	return (
		<nav className="settings-tabs" aria-label="System views">
			<NavLink end to="/system">
				System health
			</NavLink>
			<NavLink to="/system/interop">Other coding agents</NavLink>
		</nav>
	);
}
export function SystemPage({
	client,
	compact = false,
	filter: sidebarFilter = "",
}: {
	client: Client;
	compact?: boolean;
	filter?: string;
}) {
	const report = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["system"],
		queryFn: () => client.call(routes.system, emptyInput),
	});
	const meta = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
	});
	const [search, setSearch] = useSearchParams();
	const [sidebarAttention, setSidebarAttention] = useState(false);
	const filter = compact ? sidebarFilter : (search.get("q") ?? ""),
		attentionOnly = compact ? sidebarAttention : search.get("attention") === "true";
	const discover = (key: string, value: string | null, replace = false) =>
		setSearch(
			(current) => {
				const next = new URLSearchParams(current);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace },
		);
	const groups = healthGroups(report.data?.findings ?? [], filter, attentionOnly);
	const overview = healthOverview(report.data?.findings ?? []);
	const attention = overview.errors + overview.warnings;
	return (
		<section className="system-page">
			{!compact && (
				<>
					<PanelHeading
						panel={PANELS.system}
						level={1}
						action={report.data ? <span className="count">Checked {formatTime(report.data.checkedAt)}</span> : null}
					/>
					<SystemTabs />
					<p>Installation diagnostics and local folders. Check again refreshes these observations without changing files.</p>
				</>
			)}
			<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
				{compact ? "Refresh diagnostics" : "Check again"}
			</button>
			{report.isPending && <p role="status">Checking installation…</p>}
			{report.error && (
				<p role="alert">
					{report.error.message}
					{report.data && " Showing the last received observations."}
				</p>
			)}
			{meta.error && (
				<p role="alert">
					Runtime versions could not be read. {meta.error.message}{" "}
					<button type="button" disabled={meta.isFetching} onClick={() => void meta.refetch()}>
						Retry runtime details
					</button>
				</p>
			)}

			{report.data && (
				<>
					{!compact && (
						<>
							<nav className="system-sections" aria-label="On this page">
								<a href="#system-checks">Health checks</a>
								<a href="#system-runtime">Runtime versions</a>
								<a href="#system-folders">Clio folders</a>
							</nav>
							<dl className="facts panel-summary" aria-label="Diagnostic summary">
								{[
									{ label: "Issues", value: overview.errors },
									{ label: "Warnings", value: overview.warnings },
									{ label: "Ready", value: overview.ready },
									{ label: "Information", value: overview.information },
								].map((item) => (
									<div className="fact" key={item.label}>
										<dt>{item.label}</dt>
										<dd>{item.value}</dd>
									</div>
								))}
							</dl>
						</>
					)}
					<div className="system-health-heading" id={compact ? undefined : "system-checks"}>
						<h2>
							Health checks <span className="count">{report.data.findings.length}</span>
						</h2>
						<StatusMark tone={overview.tone} label={overview.label} />
					</div>
					<div className="system-discovery">
						{!compact && (
							<label className="settings-filter">
								Find a diagnostic
								<input type="search" value={filter} onChange={(event) => discover("q", event.target.value, true)} />
							</label>
						)}
						<button
							type="button"
							aria-pressed={attentionOnly}
							onClick={() =>
								compact ? setSidebarAttention(!attentionOnly) : discover("attention", attentionOnly ? null : "true")
							}
						>
							Needs review only · {attention}
						</button>
						{!compact && (filter || attentionOnly) && (
							<button
								type="button"
								onClick={() =>
									setSearch((current) => {
										const next = new URLSearchParams(current);
										next.delete("q");
										next.delete("attention");
										return next;
									})
								}
							>
								Clear filters
							</button>
						)}
					</div>
					<p className="panel-note" role="status">
						{groups.reduce((count, group) => count + group.findings.length, 0)} of {report.data.findings.length} diagnostics
						shown{attentionOnly ? " · needs review" : ""}
					</p>
					{!report.data.findings.length && <PanelEmpty>{emptyState.emptyStore("health finding")}</PanelEmpty>}
					{!!report.data.findings.length && !groups.length && (
						<PanelEmpty>
							{attentionOnly && !filter ? "No findings need review." : "No diagnostics match these filters."}
						</PanelEmpty>
					)}
					{groups.map((group) => (
						<section className="system-health-group" key={group.level} aria-label={group.label}>
							<h3>
								{group.label} · {group.findings.length}
							</h3>
							{group.findings.map((row) => {
								const action = findingAction(row);
								const collapsed = findingCollapsed(row, compact);
								const FindingContainer = collapsed ? "details" : "article";
								return (
									<FindingContainer className="system-finding" key={row.name}>
										{collapsed && <summary>{row.name}</summary>}
										{!collapsed && (
											<div>
												<h4>{row.name}</h4>
												<StatusMark tone={group.tone} label={group.label} />
											</div>
										)}
										<div>
											<p>{row.detail}</p>
											{row.detailRedacted && (
												<small>
													Parser details withheld · inspect locally with <code>clio-coder doctor</code>
												</small>
											)}
											{action && <Link to={action.path}>{action.label}</Link>}
										</div>
									</FindingContainer>
								);
							})}
						</section>
					))}
					{attention > 0 && (
						<p className="panel-note">
							For local diagnostic details, run <code>clio-coder doctor</code>. Review the reported remedy before making
							changes.
						</p>
					)}
				</>
			)}
			{meta.data && (
				<details className="system-versions" id={compact ? undefined : "system-runtime"}>
					<summary>Runtime versions · {meta.data.clio}</summary>
					<dl className="settings-list">
						{Object.entries({
							"Clio Coder": meta.data.clio,
							"Web application": meta.data.app,
							Node: meta.data.node,
							Platform: meta.data.platform,
							"Pi agent core": meta.data.piAgentCore,
							"Pi AI": meta.data.piAi,
							"Pi TUI": meta.data.piTui,
						}).map(([name, value]) => (
							<div key={name}>
								<dt>{name}</dt>
								<dd>{value ?? "Not installed"}</dd>
								<dd />
							</div>
						))}
					</dl>
				</details>
			)}
			{report.data && (
				<details className="system-compact-paths" id={compact ? undefined : "system-folders"}>
					<summary>Clio folders · settings, data, state and cache</summary>
					<p className="panel-note">
						These folders belong to the connected Clio runtime. They can differ from this browser’s machine.
					</p>
					<dl className="settings-list">
						{Object.entries(report.data.paths).map(([role, path]) => (
							<div key={role}>
								<dt>
									{humanizeKey(role)}
									<small>{SYSTEM_FOLDERS[role]}</small>
								</dt>
								<dd>
									<code>{path}</code>
								</dd>
							</div>
						))}
					</dl>
				</details>
			)}
		</section>
	);
}
/** The terminal review's `a` and `d` for one offered agent; the outcome stays until the page is read again. */
function InteropAnswer({ client, workspaceId, agent }: { client: Client; workspaceId: string; agent: InteropAgent }) {
	const queries = useQueryClient();
	const decisionKeys = useRef({ accept: crypto.randomUUID(), decline: crypto.randomUUID() });
	const decide = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: (decision: "accept" | "decline") =>
			client.call(
				routes.decideInterop,
				{ params: { id: workspaceId }, query: {}, body: { kind: agent.kind, decision } },
				decisionKeys.current[decision],
			),
		onSuccess: async () => {
			await queries.invalidateQueries({ queryKey: ["interop", workspaceId] });
			decisionKeys.current = { accept: crypto.randomUUID(), decline: crypto.randomUUID() };
		},
	});
	const offer = decisionOffer(agent);
	const outcome = decide.data && decide.variables ? decisionOutcome(decide.data, decide.variables) : null;
	if (!offer && !outcome && !decide.error) return null;
	return (
		<div className="interop-answer">
			{offer ? (
				<>
					<p className="interop-answer__consequence">{offer.consequence}</p>
					<span className="interop-answer__actions">
						<button type="button" disabled={decide.isPending} onClick={() => decide.mutate("accept")}>
							{decide.isPending && decide.variables === "accept" ? "Wiring…" : offer.accept}
						</button>
						<button type="button" disabled={decide.isPending} onClick={() => decide.mutate("decline")}>
							{offer.decline}
						</button>
					</span>
				</>
			) : null}
			{outcome ? (
				<p role="status">
					<StatusMark tone={outcome.tone} label={outcome.tone === "warn" ? "Not changed" : "Recorded"} />
					{outcome.text}
				</p>
			) : null}
			{decide.error ? <p role="alert">{decide.error.message}</p> : null}
		</div>
	);
}

export function InteropPage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const [search, setSearch] = useSearchParams();
	const filter = INTEROP_FILTERS.find((value) => value === search.get("show")) ?? "all";
	const query = search.get("q") ?? "";
	const discover = (key: string, value: string) =>
		setSearch(
			(current) => {
				const next = new URLSearchParams(current);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true },
		);
	// Opening the page never runs a foreign executable. Only the button asks for the version probe,
	// and the flag is spent by the read it started so a background refetch goes back to files only.
	const probe = useRef(false);
	const report = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["interop", selection.id],
		enabled: !!selection.id,
		refetchOnWindowFocus: false,
		retry: false,
		queryFn: () => {
			const query = probe.current ? { probe: "versions" as const } : {};
			probe.current = false;
			return client.call(routes.interop, { ...emptyInput, params: { id: selection.id }, query });
		},
	});
	const agents = report.data ? orderedAgents(report.data).filter((agent) => matchesAgent(agent, query, filter)) : [];
	return (
		<section className="interop-page">
			<PanelHeading panel={PANELS.interop} level={1} />
			<SystemTabs />
			<WorkspacePicker selection={selection} />
			<p>
				Which coding agents are on this machine, and how far each one is wired as a delegation peer. Presence does not grant
				an agent permission to work.
			</p>
			<div className="system-discovery">
				<button type="button" disabled={!selection.id || report.isFetching} onClick={() => void report.refetch()}>
					{report.isFetching ? "Reading agents…" : "Refresh inventory"}
				</button>
				<button
					type="button"
					disabled={!selection.id || report.isFetching}
					onClick={() => {
						probe.current = true;
						void report.refetch();
					}}
				>
					Detect again and probe versions
				</button>
			</div>
			{!selection.id && !selection.workspaces.isPending && (
				<PanelEmpty>{emptyState.unread("external agent inventory")}</PanelEmpty>
			)}
			{selection.id && report.isPending && <p role="status">Reading installed agents…</p>}
			{report.error && (
				<p role="alert">
					{report.error.message}
					{report.data && " Showing the last received observations."}
				</p>
			)}
			{report.data && (
				<>
					<dl className="facts panel-summary" aria-label="Detected agent summary">
						{interopSummary(report.data).map((figure) => (
							<div className="fact" key={figure.label}>
								<dt>{figure.label}</dt>
								<dd>{figure.value}</dd>
							</div>
						))}
					</dl>
					<p className="panel-note">
						Versions are recorded observations until you explicitly probe them. Probing runs each installed executable’s
						bounded <code>--version</code> command.
					</p>
					<div className="interop-discovery">
						<label className="settings-filter">
							Find an agent or resource
							<input type="search" value={query} onChange={(event) => discover("q", event.target.value)} />
						</label>
						<fieldset className="interop-filters">
							<legend>Show agents</legend>
							{INTEROP_FILTERS.map((value) => (
								<button
									type="button"
									key={value}
									aria-pressed={filter === value}
									onClick={() => discover("show", value === "all" ? "" : value)}
								>
									{INTEROP_FILTER_LABELS[value]} · {report.data.agents.filter((agent) => matchesAgent(agent, "", value)).length}
								</button>
							))}
						</fieldset>
						<p role="status" className="panel-note">
							{agents.length} of {report.data.agents.length} known kinds shown
						</p>
						{(query || filter !== "all") && (
							<button
								type="button"
								onClick={() =>
									setSearch((current) => {
										const next = new URLSearchParams(current);
										next.delete("q");
										next.delete("show");
										return next;
									})
								}
							>
								Clear filters
							</button>
						)}
					</div>
					{!agents.length && <PanelEmpty>No agents match these filters. Clear filters to see every known kind.</PanelEmpty>}
					<div className="interop-agents">
						{agents.map((agent) => {
							const presence = presenceMark(agent);
							const wiring = wiringMark(agent);
							return (
								<article className="interop-agent" key={agent.kind}>
									<div className="interop-agent__heading">
										<h2>{agent.label}</h2>
										{agent.decisionStale && <StatusMark tone="warn" label="Previous answer is stale" />}
									</div>
									<p className="panel-marks">
										<StatusMark tone={presence.tone} label={presence.label} />
										<StatusMark tone={wiring.tone} label={wiring.label} />
									</p>
									<p>{wiringSentence(agent)}</p>
									{selection.id ? (
										<InteropAnswer
											key={`${selection.id}:${agent.kind}`}
											client={client}
											workspaceId={selection.id}
											agent={agent}
										/>
									) : null}
									<details className="interop-technical">
										<summary>Compatibility and observations</summary>
										<dl className="facts">
											<div className="fact">
												<dt>Version</dt>
												<dd data-tone={agent.version ? undefined : "absent"}>{versionText(agent, report.data.detectedAt)}</dd>
											</div>
											<div className="fact">
												<dt>ACP adapter</dt>
												<dd>{adapterText(agent.adapter)}</dd>
											</div>
											<div className="fact">
												<dt>Answered</dt>
												<dd data-tone={agent.decidedAt ? undefined : "absent"}>
													{agent.decidedAt ? formatTime(agent.decidedAt) : "Never"}
												</dd>
											</div>
											<div className="fact">
												<dt>Skills</dt>
												<dd>{agent.skillCount ?? "Not reported"}</dd>
											</div>
											<div className="fact">
												<dt>Workspace resources</dt>
												<dd>{agent.projectArtifacts ?? "Not reported"}</dd>
											</div>
										</dl>
									</details>
									{agent.inventory.status === "unknown" && (
										<PanelEmpty>The resource inventory is incomplete or unsupported for this agent.</PanelEmpty>
									)}
									<details>
										<summary>Resources and discovery details · {agent.inventory.items.length}</summary>
										{agent.binary && (
											<p className="config-path">
												Executable <code>{agent.binary}</code>
											</p>
										)}
										{agent.installDir && (
											<p className="config-path">
												Installation <code>{agent.installDir}</code>
											</p>
										)}
										{agent.inventory.items.length ? (
											<dl className="settings-list">
												{agent.inventory.items.map((item) => (
													<div key={`${item.scope}:${item.kind}:${item.path}:${item.name}`}>
														<dt>{item.name}</dt>
														<dd>
															{humanizeKey(item.kind)} · {item.scope === "user" ? "yours" : "this project"}
															<br />
															<code>{item.path}</code>
														</dd>
														<dd>{item.installation === "installed" ? "Installed" : "Installation not reported"}</dd>
													</div>
												))}
											</dl>
										) : (
											<PanelEmpty>{emptyState.emptyStore("resource entry", `for ${agent.label} on this machine`)}</PanelEmpty>
										)}
										{[...new Set(agent.inventory.diagnostics)].map((message) => (
											<p key={message}>{message}</p>
										))}
									</details>
								</article>
							);
						})}
					</div>
				</>
			)}
		</section>
	);
}
