import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { routes } from "../../contracts/runtime-routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { OperatorMetrics, useOperatorMetrics } from "./operator-metrics.js";
import "./usage.css";

export function MetricsPage({ client }: { client: Client }) {
	const [search, setSearch] = useSearchParams();
	const workspace = search.get("workspace") ?? "";
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const metrics = useOperatorMetrics(client, workspace);
	return (
		<section className="usage-page">
			<header>
				<p className="eyebrow">Recorded operations</p>
				<h1>Metrics & telemetry</h1>
			</header>
			<div className="usage-scope">
				<label>
					Scope{" "}
					<select
						value={workspace}
						onChange={(event) => setSearch(event.target.value ? { workspace: event.target.value } : {})}
					>
						<option value="">All projects</option>
						{workspace && !workspaces.data?.some((row) => row.id === workspace) ? (
							<option value={workspace}>Unavailable project</option>
						) : null}
						{workspaces.data?.map((row) => (
							<option key={row.id} value={row.id}>
								{row.name}
							</option>
						))}
					</select>
				</label>
				<button type="button" disabled={metrics.isFetching} onClick={() => void metrics.refetch()}>
					{metrics.isFetching ? "Refreshing…" : "Refresh metrics"}
				</button>
				<Link to={workspace ? `/usage?workspace=${workspace}` : "/usage"}>Usage & provenance</Link>
			</div>
			{workspaces.error ? <p role="alert">Project names unavailable: {workspaces.error.message}</p> : null}
			{metrics.isPending ? <p role="status">Reading retained journal measurements…</p> : null}
			{metrics.error ? (
				<p role="alert">
					{metrics.error.message} {metrics.data ? "Showing the last successful metrics." : ""}
				</p>
			) : null}
			{metrics.data ? (
				<>
					<p className="operator-note">
						30-day local window · {formatTime(metrics.data.from)} to {formatTime(metrics.data.to)} · no live provider probes
					</p>
					<OperatorMetrics client={client} {...metrics.data} />
				</>
			) : null}
		</section>
	);
}
