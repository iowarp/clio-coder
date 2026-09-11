import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { ConfigurationTabs, useWorkspaceSelection, WorkspacePicker } from "./settings.js";

export function TargetsPage({ client, view }: { client: Client; view: "targets" | "routing" }) {
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
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
	const mutate = useMutation({
		mutationFn: ({ targetId, action }: { targetId: string; action: "probe" | "use" | "remove" }) =>
			client.call(action === "probe" ? routes.targetsProbe : action === "use" ? routes.targetsUse : routes.targetsRemove, {
				...emptyInput,
				params: { id, targetId },
			}),
		onSuccess: (value) => setOperationId(value.operationId),
	});
	const cancel = useMutation({
		mutationFn: () => client.call(routes.cancel, { ...emptyInput, params: { id: operationId ?? "" } }),
	});
	const busy =
		mutate.isPending ||
		(!!operationId && operation.isPending) ||
		operation.data?.status === "queued" ||
		operation.data?.status === "running";
	return (
		<section>
			<p className="eyebrow">Configuration / {view === "targets" ? "Model endpoints" : "Offline inventories"}</p>
			<h1>{view === "targets" ? "Targets" : "Models and routing"}</h1>
			<WorkspacePicker selection={selection} />
			<ConfigurationTabs id={id} active={view} />
			{view === "targets" ? (
				<>
					<p>
						Use a target for chat and fleet, or inspect its current health. To add a target, run{" "}
						<code>clio-coder configure</code>.
					</p>
					<p>Clio’s probe checks all configured endpoints before returning the selected target’s result.</p>
					{targets.isPending && id && <p>Reading targets…</p>}
					{targets.error && <p role="alert">{targets.error.message}</p>}
					{targets.data?.truncated && <p>The inventory exceeds 200 targets; the first 200 are shown.</p>}
					{targets.data && !targets.data.targets.length && <p>No model targets configured.</p>}
					<div className="config-entries">
						{targets.data?.targets.map((target) => (
							<article className="trace-panel" key={target.id} aria-label={target.id}>
								<h2>{target.id}</h2>
								<p>
									{target.runtime} · {target.tier}
								</p>
								<p>
									{target.available ? "Available" : "Unavailable"} · Health: {target.health}
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
										<p>No model inventory reported.</p>
									)}
								</details>
								<div className="actions">
									<button type="button" disabled={busy} onClick={() => mutate.mutate({ targetId: target.id, action: "probe" })}>
										Probe
									</button>
									<button type="button" disabled={busy} onClick={() => mutate.mutate({ targetId: target.id, action: "use" })}>
										Use for chat &amp; fleet
									</button>
									<button
										type="button"
										disabled={busy}
										onClick={() => {
											if (window.confirm(`Remove target ${target.id} and its routing references from user settings?`))
												mutate.mutate({ targetId: target.id, action: "remove" });
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
							{routing.data.truncated && <p>A collection exceeds 2,000 rows; its first 2,000 are shown.</p>}
							<h2>Models · {routing.data.models.length}</h2>
							<p>Capability marks: C chat, T tools, R reasoning, V vision, E embeddings, K rerank, F fill in the middle.</p>
							{!routing.data.models.length && <p>No cached models.</p>}
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
											Context: {row.context ?? "unreported"} · Output: {row.maxOutputTokens ?? "unreported"}
										</dd>
										<dd />
									</div>
								))}
							</dl>
							<h2>Profiles · {routing.data.profiles.length}</h2>
							{!routing.data.profiles.length && <p>No fleet profiles configured.</p>}
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
							{!routing.data.bindings.length && <p>No agent bindings configured.</p>}
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
						</>
					)}
				</>
			)}
			{mutate.error && <p role="alert">{mutate.error.message}</p>}
			{operation.data && (
				<section className="trace-panel" aria-label="Target operation">
					<h2>Target operation · {operation.data.status}</h2>
					<p>{operation.data.kind}</p>
					<ul>
						{operation.data.progress.map((row) => (
							<li key={`${row.at}:${row.message}`}>{row.message}</li>
						))}
					</ul>
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
							Cancel probe
						</button>
					)}
				</section>
			)}
		</section>
	);
}
