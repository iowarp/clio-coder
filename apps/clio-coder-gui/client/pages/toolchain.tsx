import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark, toneForOutcome } from "../design/status.js";
import {
	matchesTool,
	operationUnsettled,
	requestOutcomeUnknown,
	TOOL_FILTER_LABELS,
	TOOL_FILTERS,
	type ToolFilter,
	toolActionEffect,
	toolAvailability,
	toolCandidateNote,
	toolResolution,
} from "./toolchain-model.js";
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
	const [search, setSearch] = useState("");
	const [availability, setAvailability] = useState<ToolFilter>("all");
	const actionLock = useRef(false);
	const tools = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["tools"],
		queryFn: () => client.call(routes.tools, emptyInput),
	});
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
	useEffect(() => {
		if (operationId && !operationUnsettled(operationId, operation.data?.status))
			void queries.invalidateQueries({ queryKey: ["tools"] });
	}, [operationId, operation.data?.status, queries]);
	const action = useMutation({
		meta: { errorSurface: "inline" },
		mutationFn: async ({ id, kind, key }: { id: string; kind: "install" | "remove"; key: string }) =>
			client.call(routes[kind], { params: { toolId: id }, query: {}, body: {} }, key),
		onSuccess: (result) => setOperationId(result.operationId),
		onSettled: () => {
			actionLock.current = false;
		},
	});
	const uncertainRequest =
		action.isError && requestOutcomeUnknown(action.error instanceof ApiProblem ? action.error.problem.status : undefined);
	const busy = action.isPending || uncertainRequest || operationUnsettled(operationId, operation.data?.status);
	const run = (id: string, kind: "install" | "remove") => {
		if (busy || actionLock.current) return;
		actionLock.current = true;
		setOperationId(null);
		action.mutate({ id, kind, key: crypto.randomUUID() });
	};
	const visibleTools = tools.data?.filter((tool) => matchesTool(tool, compact ? filter : search, availability));

	return (
		<>
			{!compact && (
				<>
					<PanelHeading
						panel={PANELS.toolchain}
						level={1}
						title="Toolchain"
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
			{!compact && tools.data && (
				<div className="toolchain-discovery">
					<label className="settings-filter">
						Find a tool
						<input
							type="search"
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="Search tools or capabilities"
						/>
					</label>
					<fieldset className="toolchain-filters">
						<legend>Availability</legend>
						{TOOL_FILTERS.map((value) => (
							<button key={value} type="button" aria-pressed={availability === value} onClick={() => setAvailability(value)}>
								{TOOL_FILTER_LABELS[value]} · {tools.data.filter((tool) => matchesTool(tool, "", value)).length}
							</button>
						))}
					</fieldset>
					<div className="toolchain-results">
						<span role="status">
							{visibleTools?.length} of {tools.data.length} tools
						</span>
						{(search || availability !== "all") && (
							<button
								type="button"
								onClick={() => {
									setSearch("");
									setAvailability("all");
								}}
							>
								Clear filters
							</button>
						)}
						<button type="button" disabled={tools.isFetching || busy} onClick={() => void tools.refetch()}>
							{tools.isFetching ? "Refreshing…" : "Refresh resolution"}
						</button>
					</div>
				</div>
			)}
			{tools.isPending && <p role="status">Resolving tools…</p>}
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
			{action.isPending && (
				<p role="status">
					Sending {action.variables?.kind} request for {action.variables?.id}…
				</p>
			)}
			{action.error && <Failure error={action.error} />}
			{uncertainRequest && (
				<>
					<p className="panel-note">
						The request outcome is unknown. Retry this same request to recover its result without starting a duplicate
						operation.
					</p>
					<button
						type="button"
						disabled={action.isPending}
						onClick={() => {
							if (action.variables && !actionLock.current) {
								actionLock.current = true;
								action.mutate(action.variables);
							}
						}}
					>
						Recover {action.variables?.kind} request · {action.variables?.id}
					</button>
				</>
			)}
			{operation.error && (
				<>
					<Failure error={operation.error} />
					<p className="panel-note">
						Progress could not be read. The accepted operation may still be running. Installation actions remain paused until
						its outcome is known.
					</p>
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
									<span className="tool-number">{String(index + 1).padStart(2, "0")}</span>
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
								<p>{toolAvailability(tool)}</p>
								<details className="tool-technical">
									<summary>Executable, versions and installation paths</summary>
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
										onClick={() => run(tool.id, "install")}
									>
										{tool.installed ? "Check installation" : "Install pinned version"} <span aria-hidden="true">↓</span>
									</button>
									{tool.installed && (
										<button type="button" className="secondary" disabled={busy} onClick={() => run(tool.id, "remove")}>
											Remove vendored copy
										</button>
									)}
								</div>
							</div>
						</ToolContainer>
					);
				})}
			</div>
		</>
	);
}
