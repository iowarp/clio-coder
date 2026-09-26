import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark, toneForOutcome } from "../design/status.js";
import { toolActionEffect, toolCandidateNote, toolResolution } from "./toolchain-model.js";
import "./toolchain.css";

function Failure({ error }: { error: Error }) {
	return (
		<div className="problem" role="alert">
			<strong>{error.message}</strong>
			{error instanceof ApiProblem && (
				<small>
					{error.problem.code} · {error.problem.instance}
				</small>
			)}
		</div>
	);
}
export function Toolchain({
	client,
	compact = false,
	filter = "",
}: {
	client: Client;
	compact?: boolean;
	filter?: string;
}) {
	const queries = useQueryClient();
	const tools = useQuery({ queryKey: ["tools"], queryFn: () => client.call(routes.tools, emptyInput) });
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
	useEffect(() => {
		if (operation.data?.status === "succeeded" || operation.data?.status === "failed")
			void queries.invalidateQueries({ queryKey: ["tools"] });
	}, [operation.data?.status, queries]);
	const action = useMutation({
		mutationFn: async ({ id, kind }: { id: string; kind: "install" | "remove" }) =>
			client.call(routes[kind], { params: { toolId: id }, query: {}, body: {} }),
		onSuccess: (result) => setOperationId(result.operationId),
	});
	const busy =
		action.isPending ||
		(!!operationId && operation.isPending) ||
		operation.data?.status === "running" ||
		operation.data?.status === "queued";
	const needle = filter.trim().toLocaleLowerCase();
	const visibleTools = tools.data?.filter((tool) =>
		`${tool.id} ${tool.summary} ${tool.version} ${toolResolution(tool).label}`.toLocaleLowerCase().includes(needle),
	);
	return (
		<>
			{!compact && (
				<>
					<PanelHeading
						panel={PANELS.toolchain}
						level={1}
						title={
							<>
								Toolchain<span className="period">.</span>
							</>
						}
						action={<span className="count">{tools.data?.length ?? "—"} pinned tools</span>}
					/>
					<p className="intro">Inspect the executable Clio resolves and manage its pinned, vendored copy.</p>
					<p className="panel-note">
						A compatible PATH installation may take precedence over the pinned copy. Removing a vendored copy leaves PATH
						installations intact.
					</p>
					<div className="section-rule">
						<span>TOOL / PINNED VERSION</span>
						<span>RESOLUTION & INSTALLATION</span>
					</div>
				</>
			)}
			{tools.isPending && <p>Resolving tools…</p>}
			{tools.error && (
				<>
					<Failure error={tools.error} />
					<button type="button" disabled={tools.isFetching} onClick={() => void tools.refetch()}>
						Refresh resolution
					</button>
				</>
			)}
			{tools.data && !tools.data.length && <PanelEmpty>{emptyState.emptyStore("pinned tool")}</PanelEmpty>}
			{!!tools.data?.length && !visibleTools?.length && <PanelEmpty>No pinned tools match this filter.</PanelEmpty>}
			<div className="tools">
				{visibleTools?.map((tool, index) => {
					const candidate = toolCandidateNote(tool);
					const ToolContainer = compact ? "details" : "article";
					return (
						<ToolContainer className="tool" key={tool.id} aria-label={tool.id}>
							{compact && (
								<summary>
									<span className="tool-compact-identity">
										<strong>{tool.id}</strong>
										<span>{tool.version}</span>
									</span>
									<StatusMark {...toolResolution(tool)} />
								</summary>
							)}
							{!compact && (
								<div className="tool-identity">
									<span className="tool-number">0{index + 1}</span>
									<div>
										<h2>
											{tool.id}
											<span className="version">{tool.version}</span>
										</h2>
										<p>{tool.summary}</p>
										<small>
											{tool.license} · {tool.platform ?? "Unsupported platform"}
										</small>
									</div>
								</div>
							)}
							<div className="tool-resolution">
								{!compact && <StatusMark {...toolResolution(tool)} />}
								<p>{tool.resolution.description}</p>
								<dl className="tool-facts">
									<div>
										<dt>Resolved version</dt>
										<dd>{tool.resolution.version ?? "Not reported"}</dd>
									</div>
									<div>
										<dt>Executable</dt>
										<dd>{tool.resolution.binaryPath ? <code>{tool.resolution.binaryPath}</code> : "No executable resolved"}</dd>
									</div>
									<div>
										<dt>Vendored copy</dt>
										<dd>
											{tool.installed ? "Installed" : "Not installed"}
											{tool.resolution.vendoredPath && <code>{tool.resolution.vendoredPath}</code>}
										</dd>
									</div>
								</dl>
								{candidate && <p className="panel-note">{candidate}</p>}
								<details>
									<summary>Install destination & PATH candidate</summary>
									<dl className="tool-facts">
										<div>
											<dt>Pinned destination</dt>
											<dd>
												<code>{tool.installDir}</code>
											</dd>
										</div>
										<div>
											<dt>PATH candidate</dt>
											<dd>
												{tool.resolution.pathCandidate ? (
													<>
														<code>{tool.resolution.pathCandidate.path}</code>
														<span>
															{tool.resolution.pathCandidate.version ?? "Version not reported"} ·{" "}
															{tool.resolution.pathCandidate.satisfiesMinimum ? "Meets minimum" : "Below minimum"}
														</span>
													</>
												) : (
													"No candidate reported"
												)}
											</dd>
										</div>
									</dl>
								</details>
								<p className="tool-action-effect">{toolActionEffect(tool)}</p>
								<div className="actions">
									<button
										type="button"
										className="primary"
										disabled={busy || !tool.supported}
										onClick={() => action.mutate({ id: tool.id, kind: "install" })}
									>
										{tool.installed ? "Check installation" : "Install pinned version"} <span aria-hidden="true">↓</span>
									</button>
									{tool.installed && (
										<button
											type="button"
											className="secondary"
											disabled={busy}
											onClick={() => action.mutate({ id: tool.id, kind: "remove" })}
										>
											Remove vendored copy
										</button>
									)}
								</div>
							</div>
						</ToolContainer>
					);
				})}
			</div>
			{action.error && <Failure error={action.error} />}
			{operation.error && (
				<>
					<Failure error={operation.error} />
					<p className="panel-note">Progress could not be read. The accepted operation may still be running.</p>
					<button type="button" onClick={() => void operation.refetch()}>
						Read operation again
					</button>
				</>
			)}
			{operation.data && (
				<section className="operation" aria-label="Operation progress">
					<div className="operation-heading">
						<h2>
							{operation.data.kind === "toolchain.install" ? "Installation" : "Removal"}
							{action.variables && ` · ${action.variables.id}`}
						</h2>
						<span role="status">
							<StatusMark
								tone={toneForOutcome(
									operation.data.status === "succeeded"
										? "success"
										: operation.data.status === "queued"
											? "running"
											: operation.data.status,
								)}
								label={operation.data.status}
							/>
						</span>
					</div>
					<ol aria-live="polite" aria-relevant="additions">
						{operation.data.progress.map((line) => (
							<li key={`${line.at}-${line.message}`}>
								<time>{new Date(line.at).toLocaleTimeString()}</time>
								{line.message}
							</li>
						))}
					</ol>
					{operation.data.status === "succeeded" && <p className="result">{operation.data.result.message}</p>}
					{operation.data.status === "failed" && (
						<>
							<Failure error={new ApiProblem(operation.data.problem)} />
							<p className="panel-note">
								Refresh resolution to inspect the remaining installation, then retry the action. An install failure does not
								remove an existing PATH copy.
							</p>
						</>
					)}
					{operation.data.status === "cancelled" && (
						<p role="status">The operation stopped. Refresh resolution before choosing another action.</p>
					)}
					{operation.data.status !== "running" && operation.data.status !== "queued" && (
						<button type="button" disabled={tools.isFetching} onClick={() => void tools.refetch()}>
							Refresh resolution
						</button>
					)}
				</section>
			)}
		</>
	);
}
