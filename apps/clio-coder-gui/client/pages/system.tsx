import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { humanizeKey } from "../design/facts-model.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import {
	adapterText,
	interopSummary,
	orderedAgents,
	presenceMark,
	wiringMark,
	wiringSentence,
} from "./interop-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import "../design/facts.css";

function SystemTabs() {
	return (
		<nav className="settings-tabs" aria-label="System views">
			<Link to="/system">System health</Link>
			<Link to="/system/interop">Other coding agents</Link>
		</nav>
	);
}
export function SystemPage({ client }: { client: Client }) {
	const report = useQuery({ queryKey: ["system"], queryFn: () => client.call(routes.system, emptyInput) });
	const meta = useQuery({ queryKey: ["meta"], queryFn: () => client.call(routes.meta, emptyInput) });
	return (
		<section>
			<PanelHeading
				panel={PANELS.system}
				level={1}
				action={report.data ? <span className="count">Checked {formatTime(report.data.checkedAt)}</span> : null}
			/>
			<SystemTabs />
			<p>
				Check this installation and find the folders Clio uses. These checks inspect existing state without repairing or
				changing it.
			</p>
			<button type="button" disabled={report.isFetching} onClick={() => void report.refetch()}>
				Check again
			</button>
			{report.isPending && <p>Checking installation…</p>}
			{report.error && <p role="alert">{report.error.message}</p>}
			{meta.error && <p role="alert">{meta.error.message}</p>}
			{meta.data && (
				<>
					<h2>Versions</h2>
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
				</>
			)}
			{report.data && (
				<>
					<h2>Health checks · {report.data.findings.length}</h2>
					{!report.data.findings.length && <PanelEmpty>{emptyState.emptyStore("health finding")}</PanelEmpty>}
					<div className="config-entries">
						{report.data.findings.map((row) => (
							<article className="trace-panel" key={row.name}>
								<h3>{row.name}</h3>
								<StatusMark
									tone={row.level === "ok" ? "success" : row.level === "warn" ? "warn" : "fail"}
									label={row.level === "ok" ? "Ready" : row.level === "warn" ? "Note" : "Needs attention"}
								/>
								<p>{row.detail}</p>
								{row.detailRedacted && <small>Parser details withheld</small>}
								{row.name === "settings.yaml" && !row.ok && <Link to="/settings">Inspect settings</Link>}
							</article>
						))}
					</div>
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
					<Boundary panel={PANELS.system} />
				</>
			)}
		</section>
	);
}
export function InteropPage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const report = useQuery({
		queryKey: ["interop", selection.id],
		enabled: !!selection.id,
		queryFn: () => client.call(routes.interop, { ...emptyInput, params: { id: selection.id } }),
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
			<button type="button" disabled={!selection.id || report.isFetching} onClick={() => void report.refetch()}>
				{report.isFetching ? "Detecting agents…" : "Detect again"}
			</button>
			{!selection.id && !selection.workspaces.isPending && (
				<PanelEmpty>{emptyState.unread("external agent inventory")}</PanelEmpty>
			)}
			{selection.id && report.isPending && <p>Checking installed agents and their versions…</p>}
			{report.error && <p role="alert">{report.error.message}</p>}
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
					<div className="config-entries">
						{orderedAgents(report.data).map((agent) => {
							const presence = presenceMark(agent);
							const wiring = wiringMark(agent);
							return (
								<article className="trace-panel" key={agent.kind}>
									<h2>{agent.label}</h2>
									<p className="panel-marks">
										<StatusMark tone={presence.tone} label={presence.label} />
										<StatusMark tone={wiring.tone} label={wiring.label} />
									</p>
									<p>{wiringSentence(agent)}</p>
									<dl className="facts">
										<div className="fact">
											<dt>Version</dt>
											<dd data-tone={agent.version ? undefined : "absent"}>{agent.version ?? "Not reported"}</dd>
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
					<Boundary panel={PANELS.interop} />
				</>
			)}
		</section>
	);
}
