import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { routes } from "../../contracts/routes.js";
import { ApiProblem, type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";

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
export function Toolchain({ client }: { client: Client }) {
	const tools = useQuery({ queryKey: ["tools"], queryFn: () => client.call(routes.tools, emptyInput) });
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
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
	return (
		<>
			<div className="page-heading">
				<div>
					<p className="eyebrow">Environment / 02</p>
					<h1>
						Toolchain<span className="period">.</span>
					</h1>
				</div>
				<span className="count">{tools.data?.length ?? "—"} pinned tools</span>
			</div>
			<p className="intro">Know what runs. Keep the tools you need close at hand.</p>
			<div className="section-rule">
				<span>TOOL / PINNED VERSION</span>
				<span>RESOLUTION & INSTALLATION</span>
			</div>
			{tools.isPending && <p>Resolving tools…</p>}
			{tools.error && <Failure error={tools.error} />}
			<div className="tools">
				{tools.data?.map((tool, index) => (
					<article className="tool" key={tool.id} aria-label={tool.id}>
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
						<div className="tool-resolution">
							<span className={`badge ${tool.resolution.source === "none" ? "absent" : "ready"}`}>
								{tool.resolution.source === "none"
									? "Not resolved"
									: tool.resolution.source === "path"
										? "On PATH"
										: "Vendored"}
							</span>
							<p>{tool.resolution.description}</p>
							<details>
								<summary>Installation path</summary>
								<code>{tool.installDir}</code>
							</details>
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
					</article>
				))}
			</div>
			{action.error && <Failure error={action.error} />}
			{operation.error && <Failure error={operation.error} />}
			{operation.data && (
				<section className="operation" aria-label="Operation progress">
					<div className="operation-heading">
						<h2>{operation.data.kind === "toolchain.install" ? "Installation" : "Removal"}</h2>
						<span className="badge" role="status">
							{operation.data.status}
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
					{operation.data.status === "failed" && <Failure error={new ApiProblem(operation.data.problem)} />}
				</section>
			)}
			<p className="footnote">
				Clio uses a compatible PATH copy first, then the vendored pin. Removing a vendored copy leaves your PATH
				installation in place.
			</p>
		</>
	);
}
