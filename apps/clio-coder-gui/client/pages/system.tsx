import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
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
	type InteropAgent,
	interopSummary,
	orderedAgents,
	presenceMark,
	versionText,
	wiringMark,
	wiringSentence,
} from "./interop-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { findingAction, healthGroups } from "./system-model.js";
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
export function SystemPage({ client }: { client: Client }) {
	const report = useQuery({ queryKey: ["system"], queryFn: () => client.call(routes.system, emptyInput) });
	const meta = useQuery({ queryKey: ["meta"], queryFn: () => client.call(routes.meta, emptyInput) });
	const [search, setSearch] = useSearchParams();
	const filter = search.get("q") ?? "",
		attentionOnly = search.get("attention") === "true";
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
	const attention = report.data?.findings.filter((row) => row.level === "error" || row.level === "warn").length ?? 0;
	return (
		<section>
			<PanelHeading
				panel={PANELS.system}
				level={1}
				action={report.data ? <span className="count">Checked {formatTime(report.data.checkedAt)}</span> : null}
			/>
			<SystemTabs />
			<p>Installation diagnostics and local folders. Check again refreshes these observations without changing files.</p>
			<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
				Check again
			</button>
			{report.isPending && <p>Checking installation…</p>}
			{report.error && (
				<p role="alert">
					{report.error.message}
					{report.data && " Showing the last received observations."}
				</p>
			)}
			{meta.error && <p role="alert">{meta.error.message}</p>}

			{report.data && (
				<>
					<div className="system-health-heading">
						<h2>
							Health checks <span className="count">{report.data.findings.length}</span>
						</h2>
						<StatusMark
							tone={attention ? "warn" : report.data.findings.length ? "success" : "unverified"}
							label={
								attention
									? `${attention} to review`
									: report.data.findings.length
										? "No findings need attention"
										: "No findings reported"
							}
						/>
					</div>
					<div className="system-discovery">
						<label className="settings-filter">
							Find a diagnostic
							<input type="search" value={filter} onChange={(event) => discover("q", event.target.value, true)} />
						</label>
						<button
							type="button"
							aria-pressed={attentionOnly}
							onClick={() => discover("attention", attentionOnly ? null : "true")}
						>
							Needs review only · {attention}
						</button>
					</div>
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
								return (
									<article className="system-finding" key={row.name}>
										<div>
											<h4>{row.name}</h4>
											<StatusMark tone={group.tone} label={group.label} />
										</div>
										<div>
											<p>{row.detail}</p>
											{row.detailRedacted && (
												<small>
													Parser details withheld · inspect locally with <code>clio-coder doctor</code>
												</small>
											)}
											{action && <Link to={action.path}>{action.label}</Link>}
										</div>
									</article>
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
					{meta.data && (
						<details className="system-versions">
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
					<h2>Clio folders</h2>
					<dl className="settings-list">
						{Object.entries(report.data.paths).map(([role, path]) => (
							<div key={role}>
								<dt>{humanizeKey(role)}</dt>
								<dd>
									<code>{path}</code>
								</dd>
								<dd />
							</div>
						))}
					</dl>
				</>
			)}
		</section>
	);
}
/** The terminal review's `a` and `d` for one offered agent; the outcome stays until the page is read again. */
function InteropAnswer({ client, workspaceId, agent }: { client: Client; workspaceId: string; agent: InteropAgent }) {
	const queries = useQueryClient();
	const decide = useMutation({
		mutationFn: (decision: "accept" | "decline") =>
			client.call(
				routes.decideInterop,
				{ params: { id: workspaceId }, query: {}, body: { kind: agent.kind, decision } },
				crypto.randomUUID(),
			),
		onSuccess: () => void queries.invalidateQueries({ queryKey: ["interop", workspaceId] }),
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
	// Opening the page never runs a foreign executable. Only the button asks for the version probe,
	// and the flag is spent by the read it started so a background refetch goes back to files only.
	const probe = useRef(false);
	const report = useQuery({
		queryKey: ["interop", selection.id],
		enabled: !!selection.id,
		refetchOnWindowFocus: false,
		queryFn: () => {
			const query = probe.current ? { probe: "versions" as const } : {};
			probe.current = false;
			return client.call(routes.interop, { ...emptyInput, params: { id: selection.id }, query });
		},
	});
	return (
		<section>
			<PanelHeading panel={PANELS.interop} level={1} />
			<SystemTabs />
			<WorkspacePicker selection={selection} />
			<p>
				Which coding agents are on this machine, and how far each one is wired as a delegation peer. Presence does not grant
				an agent permission to work.
			</p>
			<button
				type="button"
				disabled={!selection.id || report.isFetching}
				onClick={() => {
					probe.current = true;
					void report.refetch();
				}}
			>
				{report.isFetching ? "Detecting agents…" : "Detect again and probe versions"}
			</button>
			{!selection.id && !selection.workspaces.isPending && (
				<PanelEmpty>{emptyState.unread("external agent inventory")}</PanelEmpty>
			)}
			{selection.id && report.isPending && <p>Reading installed agents…</p>}
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
					<div className="interop-agents">
						{orderedAgents(report.data).map((agent) => {
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
									{selection.id ? <InteropAnswer client={client} workspaceId={selection.id} agent={agent} /> : null}
									<dl className="facts">
										<div className="fact">
											<dt>Version</dt>
											<dd data-tone={agent.version ? undefined : "absent"}>{versionText(agent)}</dd>
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
