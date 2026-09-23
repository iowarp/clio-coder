import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { TargetAdd } from "../../contracts/targets-cli.js";
import { type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { humanizeKey, reportedCount } from "../design/facts-model.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { ConfigurationTabs, useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { AddConnection } from "./target-onboarding.js";

export function TargetsPage({ client, view }: { client: Client; view: "targets" | "routing" }) {
	const queries = useQueryClient();
	const selection = useWorkspaceSelection(client),
		{ id } = selection;
	const targets = useQuery({
		queryKey: ["targets", id],
		queryFn: () => client.call(routes.targetsList, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "targets",
	});
	const routing = useQuery({
		queryKey: ["routing", id],
		queryFn: () => client.call(routes.routing, { ...emptyInput, params: { id } }),
		enabled: !!id && view === "routing",
	});
	const [operationScope, setOperationScope] = useState<{ id: string; workspaceId: string } | null>(null);
	const operationId = operationScope?.workspaceId === id ? operationScope.id : null;
	const operation = useOperation(client, operationId);
	const mutate = useMutation({
		mutationFn: ({
			workspaceId,
			targetId,
			action,
		}: {
			workspaceId: string;
			targetId: string;
			action: "probe" | "use" | "remove";
		}) =>
			client.call(action === "probe" ? routes.targetsProbe : action === "use" ? routes.targetsUse : routes.targetsRemove, {
				...emptyInput,
				params: { id: workspaceId, targetId },
			}),
		onSuccess: (value, variables) => setOperationScope({ id: value.operationId, workspaceId: variables.workspaceId }),
	});
	const add = useMutation({
		mutationFn: ({ workspaceId, body }: { workspaceId: string; body: TargetAdd }) =>
			client.call(routes.targetsAdd, { params: { id: workspaceId }, query: {}, body }),
		onSuccess: (value, variables) => setOperationScope({ id: value.operationId, workspaceId: variables.workspaceId }),
	});
	const cancel = useMutation({
		mutationFn: () => client.call(routes.cancel, { ...emptyInput, params: { id: operationId ?? "" } }),
	});
	const completedId = operation.data?.status === "succeeded" ? operation.data.id : undefined;
	useEffect(() => {
		const result = operation.data?.status === "succeeded" ? operation.data.result : null;
		if (!result || !("targets" in result) || !operationScope) return;
		queries.setQueryData(["targets", operationScope.workspaceId], result.targets);
		for (const key of ["routing", "workspace-settings", "config-graph", "target-runtimes", "settings-controls"])
			void queries.invalidateQueries({ queryKey: [key] });
	}, [operation.data, operationScope, queries]);
	const busy =
		mutate.isPending ||
		add.isPending ||
		(!!operationId && operation.isPending) ||
		operation.data?.status === "queued" ||
		operation.data?.status === "running";
	return (
		<section>
			<PanelHeading panel={view === "targets" ? PANELS.targets : PANELS.routing} level={1} />
			<WorkspacePicker selection={selection} />
			<ConfigurationTabs id={id} active={view} />
			{view === "targets" ? (
				<>
					<p>Use a target for chat and fleet, inspect its current health, or add a new connection.</p>
					<p>Clio’s probe checks all configured endpoints before returning the selected target’s result.</p>
					{targets.isPending && id && <p>Reading targets…</p>}
					{targets.error && <p role="alert">{targets.error.message}</p>}
					{targets.data?.truncated && <PanelEmpty>{emptyState.bounded("targets", "Later")}</PanelEmpty>}
					{targets.data && !targets.data.targets.length && (
						<PanelEmpty>No model target is configured yet. Add a connection to start a conversation.</PanelEmpty>
					)}
					{targets.data && (
						<AddConnection
							client={client}
							taken={targets.data.targets.map((target) => target.id)}
							busy={busy || add.isPending}
							completedId={add.data?.operationId === completedId ? completedId : undefined}
							onSubmit={(body) => add.mutate({ workspaceId: id, body })}
						/>
					)}
					{add.error && <p role="alert">{add.error.message}</p>}
					{(add.isPending || mutate.isPending) && <p role="status">Sending target request…</p>}
					{operationId && operation.isPending && !add.isPending && !mutate.isPending && (
						<p role="status">Checking target operation…</p>
					)}
					{operation.error && !add.isPending && !mutate.isPending && (
						<p role="alert">Could not read the target operation: {operation.error.message}</p>
					)}
					{operation.data && !add.isPending && !mutate.isPending && (
						<section className="trace-panel" aria-label="Target operation">
							<h2 role="status">
								{operation.data.kind.replace("targets.", "Target ")} · {operation.data.status}
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
							{busy && operation.data.cancellable && (
								<button type="button" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
									{cancel.isPending ? "Cancelling…" : "Cancel probe"}
								</button>
							)}
							{cancel.error && <p role="alert">{cancel.error.message}</p>}
						</section>
					)}
					<div className="config-entries">
						{targets.data?.targets.map((target) => (
							<article className="trace-panel" key={target.id} aria-label={target.id}>
								<h2>{target.id}</h2>
								<p>
									{target.runtime} · {target.tier}
								</p>
								<p className="panel-marks">
									<StatusMark
										tone={target.available ? "success" : "warn"}
										label={target.available ? "Available" : "Unavailable"}
									/>
									<span>Health {humanizeKey(target.health).toLowerCase()}</span>
								</p>
								<p className="config-path">{target.url ?? "Runtime default endpoint"}</p>
								<p>Default model: {target.defaultModel ?? "Not configured"}</p>
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
										<PanelEmpty>{emptyState.emptyStore("model", "for this target")}</PanelEmpty>
									)}
								</details>
								<div className="actions">
									<button
										type="button"
										disabled={busy}
										onClick={() => mutate.mutate({ workspaceId: id, targetId: target.id, action: "probe" })}
									>
										Probe
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => mutate.mutate({ workspaceId: id, targetId: target.id, action: "use" })}
									>
										Use for chat &amp; fleet
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => {
											if (window.confirm(`Remove target ${target.id} and its routing references from user settings?`))
												mutate.mutate({ workspaceId: id, targetId: target.id, action: "remove" });
										}}
									>
										Remove target
									</button>
								</div>
							</article>
						))}
					</div>
				</>
			) : (
				<>
					<p>Model inventory is read offline. Live reachability is not implied by a cached model or routing profile.</p>
					{routing.isPending && id && <p>Reading routing inventory…</p>}
					{routing.error && <p role="alert">{routing.error.message}</p>}
					{routing.data && (
						<>
							{routing.data.truncated && <PanelEmpty>{emptyState.bounded("rows", "Later")}</PanelEmpty>}
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
											<code>{row.capabilities}</code> · {row.state}
											<br />
											Context: {reportedCount(row.context)} · Output: {reportedCount(row.maxOutputTokens)}
										</dd>
										<dd />
									</div>
								))}
							</dl>
							<h2>Profiles · {routing.data.profiles.length}</h2>
							{!routing.data.profiles.length && <PanelEmpty>{emptyState.emptyStore("fleet profile")}</PanelEmpty>}
							<dl className="settings-list">
								{routing.data.profiles.map((row) => (
									<div key={row.name}>
										<dt>{row.name}</dt>
										<dd>
											{row.target ?? "No target"} · {row.model ?? "No model"}
										</dd>
										<dd>{row.thinkingLevel}</dd>
									</div>
								))}
							</dl>
							<h2>Agent bindings · {routing.data.bindings.length}</h2>
							{!routing.data.bindings.length && <PanelEmpty>{emptyState.emptyStore("agent binding")}</PanelEmpty>}
							<dl className="settings-list">
								{routing.data.bindings.map((row) => (
									<div key={row.agentId}>
										<dt>{row.agentId}</dt>
										<dd>
											{row.profile} · {row.target ?? "No target"}
										</dd>
										<dd>{row.resolved ? "Resolved" : "Missing profile"}</dd>
									</div>
								))}
							</dl>
							<Boundary panel={PANELS.routing} />
						</>
					)}
				</>
			)}
			{mutate.error && <p role="alert">{mutate.error.message}</p>}
		</section>
	);
}
