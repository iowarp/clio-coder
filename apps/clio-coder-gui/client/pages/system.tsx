import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

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
			<p className="eyebrow">Installation / Health and paths</p>
			<h1>System</h1>
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
					<h2>Health checks</h2>
					<p>Checked {report.data.checkedAt}</p>
					<div className="config-entries">
						{report.data.findings.map((row) => (
							<article className="trace-panel" key={row.name}>
								<h3>{row.name}</h3>
								<p>{row.level === "ok" ? "Ready" : row.level === "warn" ? "Note" : "Needs attention"}</p>
								<p>{row.detail}</p>
								{row.name === "settings.yaml" && !row.ok && <Link to="/settings">Inspect settings</Link>}
							</article>
						))}
					</div>
					<h2>Clio folders</h2>
					<dl className="settings-list">
						{Object.entries(report.data.paths).map(([role, path]) => (
							<div key={role}>
								<dt>{role}</dt>
								<dd>{path}</dd>
								<dd />
							</div>
						))}
					</dl>
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
			<p className="eyebrow">Installation / Other coding agents</p>
			<h1>Other coding agents</h1>
			<SystemTabs />
			<WorkspacePicker selection={selection} />
			<p>
				See which coding agents and shared resources Clio can find. Presence does not grant an agent permission to work.
			</p>
			<button type="button" disabled={!selection.id || report.isFetching} onClick={() => void report.refetch()}>
				Check again
			</button>
			{selection.id && report.isPending && <p>Checking installed agents and their versions…</p>}
			{report.error && <p role="alert">{report.error.message}</p>}
			{report.data && (
				<>
					<p>Checked {report.data.detectedAt}</p>
					<div className="config-entries">
						{report.data.agents.map((agent) => (
							<article className="trace-panel" key={agent.kind}>
								<h2>{agent.label}</h2>
								<p>
									{!agent.hasExecutable
										? "Shared resource conventions"
										: agent.presence === "present"
											? "Found on this machine"
											: agent.presence === "absent"
												? "No executable found"
												: "Executable presence could not be established"}
								</p>
								<p>Version: {agent.version ?? "Not reported"}</p>
								{agent.decision && <p>Saved choice: {agent.decision}</p>}
								{agent.adapter && <p>Local ACP adapter: {agent.adapter}</p>}
								<p>
									{agent.skillCount ?? "Unreported"} skills · {agent.projectArtifacts ?? "Unreported"} workspace resources
								</p>
								{agent.inventory.status === "unknown" && (
									<p>The resource inventory is incomplete or unsupported for this agent.</p>
								)}
								<details>
									<summary>Resources and discovery details</summary>
									{agent.binary && <p>Executable: {agent.binary}</p>}
									{agent.installDir && <p>Installation: {agent.installDir}</p>}
									{agent.inventory.items.length ? (
										<dl className="settings-list">
											{agent.inventory.items.map((item) => (
												<div key={`${item.scope}:${item.kind}:${item.path}:${item.name}`}>
													<dt>{item.name}</dt>
													<dd>
														{item.kind} · {item.scope}
														<br />
														{item.path}
													</dd>
													<dd>{item.installation ?? "Installation unreported"}</dd>
												</div>
											))}
										</dl>
									) : (
										<p>No resource entries reported.</p>
									)}
									{[...new Set(agent.inventory.diagnostics)].map((message) => (
										<p key={message}>{message}</p>
									))}
								</details>
							</article>
						))}
					</div>
				</>
			)}
		</section>
	);
}
