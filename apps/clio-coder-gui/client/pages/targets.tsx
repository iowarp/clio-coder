import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { RequestRecovery, useOperationRequest } from "../api/operation-request.js";
import { humanizeKey, reportedCount } from "../design/facts-model.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { capabilityLabels } from "./model-picker-model.js";
import { ConfigurationTabs, useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { ConnectionSetup } from "./target-onboarding.js";

export function TargetsPage({ client, view }: { client: Client; view: "targets" | "routing" }) {
	const queries = useQueryClient();
	const [routingView, setRoutingView] = useState("profiles");
	const selection = useWorkspaceSelection(client),
		{ id } = selection;
	const targets = useQuery({
		queryKey: ["targets", id],
		meta: { errorSurface: "inline" },
		queryFn: () => client.call(routes.targetsList, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "targets",
	});
	const routing = useQuery({
		queryKey: ["routing", id],
		meta: { errorSurface: "inline" },
		queryFn: () => client.call(routes.routing, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "routing",
	});
	const tracking = useOperationRequest(client, "targets", (request) =>
		client.call(
			request.action === "probe"
				? routes.targetsProbe
				: request.action === "use"
					? routes.targetsUse
					: request.action === "signout"
						? routes.targetsSignOut
						: routes.targetsRemove,
			{ ...emptyInput, params: { id: request.workspaceId, targetId: request.resourceId } },
			request.key,
			undefined,
			request.epoch ?? undefined,
		),
	);
	const { operation, request, busy } = tracking;
	const operationId = request?.operationId;
	const cancel = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: async () => {
			const meta = await client.call(routes.meta, emptyInput);
			queries.setQueryData(["meta"], meta);
			if (!operationId || request?.epoch !== meta.epoch)
				throw new Error("The original operation belongs to another server. Refresh its status before continuing.");
			return client.call(routes.cancel, { ...emptyInput, params: { id: operationId } });
		},
	});
	useEffect(() => {
		const result = operation.data?.status === "succeeded" ? operation.data.result : null;
		if (!result || !("targets" in result) || !request?.settled || tracking.epochChanged) return;
		queries.setQueryData(["targets", request.workspaceId], result.targets);
		for (const key of ["routing", "workspace-settings", "config-graph", "settings-controls"])
			void queries.invalidateQueries({ queryKey: [key] });
	}, [operation.data, request, tracking.epochChanged, queries]);
	return (
		<section className="settings-connections">
			<PanelHeading panel={view === "targets" ? PANELS.targets : PANELS.routing} level={1} />
			<WorkspacePicker selection={selection} />
			<ConfigurationTabs id={id} active={view} />
			<RequestRecovery tracking={tracking} />
			{view === "targets" ? (
				<>
					<p>Use a connection for chat and fleet, inspect its current health, or add a new connection.</p>
					<p className="panel-note">
						Check a connection to read its current availability and model list. A listed model alone does not confirm
						reachability.
					</p>
					{targets.isPending && id && <p>Reading connections…</p>}
					{targets.error && (
						<div className="settings-refresh" role="alert">
							<span>{targets.error.message}</span>
							<button type="button" onClick={() => void targets.refetch()}>
								Retry connections
							</button>
						</div>
					)}
					{targets.data?.truncated && <PanelEmpty>{emptyState.bounded("connections", "Later")}</PanelEmpty>}
					{targets.data && !targets.data.targets.length && (
						<PanelEmpty>No model connection is configured yet. Add a connection to start a conversation.</PanelEmpty>
					)}
					<ConnectionSetup />
					{operation.data && !tracking.sending && !tracking.epochChanged && (
						<section className="trace-panel" aria-label="Connection operation">
							{/* aria-live, not role="status": a role on the h2 would replace its heading role. */}
							<h2 aria-live="polite">
								{operation.data.kind === "targets.signout"
									? "Sign out"
									: operation.data.kind.replace("targets.", "Connection ")}{" "}
								· {operation.data.status}
							</h2>
							{operation.data.progress.length > 0 && (
								<ul>
									{operation.data.progress.map((row) => (
										<li key={`${row.at}:${row.message}`}>{row.message}</li>
									))}
								</ul>
							)}
							{operation.data.status === "failed" && (
								<p role="alert">
									{operation.data.problem.detail}
									<br />
									{operation.data.problem.code} · Reference {operation.data.problem.instance}
								</p>
							)}
							{operation.data.status === "succeeded" && <p>{operation.data.result.message}</p>}
							{busy && !operation.error && operation.data.cancellable && (
								<button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
									{cancel.isPending ? "Cancelling…" : "Cancel probe"}
								</button>
							)}
							{cancel.error && <p role="alert">{cancel.error.message}</p>}
						</section>
					)}
					<div className="config-entries">
						{targets.data?.targets.map((target) => (
							<article className="trace-panel connection-card" key={target.id} aria-label={target.id}>
								<h2>{target.id}</h2>
								<p>
									{target.runtime} · {target.tier}
								</p>
								<p className="panel-marks">
									<StatusMark
										tone={target.health === "unknown" ? "unverified" : target.available ? "success" : "warn"}
										label={target.health === "unknown" ? "Availability unknown" : target.available ? "Available" : "Unavailable"}
									/>
									<span>Health {humanizeKey(target.health).toLowerCase()}</span>
								</p>
								<p className="config-path">{target.url ?? "Endpoint not reported"}</p>
								<dl className="connection-card__model">
									<dt>Default model</dt>
									<dd>{target.defaultModel ?? "Not reported"}</dd>
								</dl>
								<details>
									<summary>
										Known models · {target.models.length}
										{target.modelsTruncated ? "+" : ""}
									</summary>
									{target.models.length ? (
										<ul>
											{target.models.map((model) => (
												<li key={model}>{model}</li>
											))}
										</ul>
									) : (
										<PanelEmpty>{emptyState.emptyStore("model", "for this connection")}</PanelEmpty>
									)}
								</details>
								<ConnectionSetup targetId={target.id} />
								<div className="actions connection-card__actions">
									<button
										type="button"
										disabled={busy}
										onClick={() => tracking.start({ workspaceId: id, resourceId: target.id, action: "probe" })}
									>
										Check connection
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => tracking.start({ workspaceId: id, resourceId: target.id, action: "use" })}
									>
										Use for chat &amp; fleet
									</button>
								</div>
								<details className="connection-card__advanced">
									<summary>Credential & removal options</summary>
									<div className="actions">
										<button
											type="button"
											disabled={busy}
											title="Remove the API key or login Clio stored for this connection. The connection itself stays."
											onClick={() => {
												if (
													window.confirm(
														`Sign out of ${target.id}? Clio removes the credential it stored for this connection. The connection stays configured.`,
													)
												)
													tracking.start({ workspaceId: id, resourceId: target.id, action: "signout" });
											}}
										>
											Sign out
										</button>
										<button
											type="button"
											disabled={busy}
											onClick={() => {
												if (window.confirm(`Remove connection ${target.id} and its routing references from user settings?`))
													tracking.start({ workspaceId: id, resourceId: target.id, action: "remove" });
											}}
										>
											Remove connection
										</button>
									</div>
								</details>
							</article>
						))}
					</div>
				</>
			) : (
				<>
					<p>Model inventory is read offline. Live reachability is not implied by a cached model or routing profile.</p>
					{routing.isPending && id && <p>Reading routing inventory…</p>}
					{routing.error && (
						<div className="settings-refresh" role="alert">
							<span>{routing.error.message}</span>
							<button type="button" onClick={() => void routing.refetch()}>
								Retry routing
							</button>
						</div>
					)}
					{routing.data && (
						<>
							<div className="routing-guide">
								<strong>Agent → profile → connection & model</strong>
								<p>
									Profiles select a model. Agent bindings choose a profile. Inspect each step below or{" "}
									<Link to={`/settings/advanced?${new URLSearchParams({ workspace: id, q: "fleet" })}`}>
										edit fleet settings
									</Link>
									.
								</p>
							</div>
							<nav className="settings-tabs" aria-label="Routing inventory">
								{[
									{ id: "profiles", label: "Profiles", count: routing.data.profiles.length },
									{ id: "bindings", label: "Agent bindings", count: routing.data.bindings.length },
									{ id: "models", label: "Cached models", count: routing.data.models.length },
								].map((tab) => (
									<button
										key={tab.id}
										type="button"
										aria-pressed={routingView === tab.id}
										onClick={() => setRoutingView(tab.id)}
									>
										{tab.label} · {tab.count}
									</button>
								))}
							</nav>
							{routing.data.truncated && <PanelEmpty>{emptyState.bounded("rows", "Later")}</PanelEmpty>}
							<section hidden={routingView !== "models"}>
								<h2>Models · {routing.data.models.length}</h2>
								<p>Capability marks: C chat, T tools, R reasoning, V vision, E embeddings, K rerank, F fill in the middle.</p>
								{!routing.data.models.length && <PanelEmpty>{emptyState.emptyStore("cached model")}</PanelEmpty>}
								<dl className="settings-list">
									{routing.data.models.map((row) => (
										<div key={`${row.target}:${row.id}`}>
											<dt>
												{row.id ?? "No models reported"}
												<br />
												<small>
													{row.target} · {row.runtime}
												</small>
											</dt>
											<dd>
												<span className="routing-capabilities">
													<span className="sr-only">Reported capabilities: </span>
													{capabilityLabels(row.capabilities).map((label) => (
														<span className="routing-capabilities__chip" key={label}>
															{label}
														</span>
													))}
												</span>{" "}
												<small>Recorded state: {row.state}</small>
												<br />
												Context: {reportedCount(row.context)} · Output: {reportedCount(row.maxOutputTokens)}
											</dd>
											<dd />
										</div>
									))}
								</dl>
							</section>
							<section hidden={routingView !== "profiles"}>
								<h2>Profiles · {routing.data.profiles.length}</h2>
								{!routing.data.profiles.length && <PanelEmpty>{emptyState.emptyStore("fleet profile")}</PanelEmpty>}
								<dl className="settings-list">
									{routing.data.profiles.map((row) => (
										<div key={row.name}>
											<dt>{row.name}</dt>
											<dd>
												{row.target ?? "No connection"} · {row.model ?? "No model"}
											</dd>
											<dd>
												{row.thinkingLevel}
												{row.source ? <small> · {row.source} settings</small> : null}
											</dd>
										</div>
									))}
								</dl>
							</section>
							<section hidden={routingView !== "bindings"}>
								<h2>Agent bindings · {routing.data.bindings.length}</h2>
								{!routing.data.bindings.length && <PanelEmpty>{emptyState.emptyStore("agent binding")}</PanelEmpty>}
								<dl className="settings-list">
									{routing.data.bindings.map((row) => (
										<div key={row.agentId}>
											<dt>{row.agentId}</dt>
											<dd>
												{row.profile} → {row.target ?? "Connection not reported"}
												<small>{row.model ?? "Model not reported"}</small>
											</dd>
											<dd>{row.resolved ? "Resolved" : "Missing profile"}</dd>
										</div>
									))}
								</dl>
							</section>
							<Boundary panel={PANELS.routing} />
						</>
					)}
				</>
			)}
			{!id && !selection.workspaces.isPending && !selection.missing && !selection.workspaces.error && (
				<PanelEmpty>Open a project to inspect its connections and routing.</PanelEmpty>
			)}
		</section>
	);
}
