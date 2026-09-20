import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { type Input, routes } from "../../../contracts/routes.js";
import type { Client } from "../../api/client.js";
import { formatCost, formatTime, formatTokens } from "../../api/clock.js";
export function TraceRuns({ client }: { client: Client }) {
	const [search, setSearch] = useSearchParams();
	const source = search.get("source"),
		status = search.get("status"),
		q = search.get("q") ?? "";
	const filter: Input<typeof routes.traceRuns>["query"] = {
		...(source === "dispatch" || source === "session" ? { source } : {}),
		...(status === "queued" || status === "running" || status === "success" || status === "fail" ? { status } : {}),
		...(q ? { q } : {}),
	};
	const availability = useQuery({
		queryKey: ["trace-status"],
		queryFn: () => client.call(routes.traceStatus, { params: {}, query: {}, body: {} }),
		refetchInterval: 5000,
	});
	const runs = useInfiniteQuery({
		queryKey: ["trace-runs", filter],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			client.call(routes.traceRuns, {
				params: {},
				body: {},
				query: { ...filter, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor,
		refetchInterval: 5000,
		enabled: availability.data?.available === true,
	});
	return (
		<section>
			<p className="eyebrow">Execution history</p>
			<h1>
				Traces<span className="period">.</span>
			</h1>
			<p className="intro">Follow a run from its first decision to its final evidence.</p>
			<form
				className="trace-filters"
				onSubmit={(event) => {
					event.preventDefault();
					const data = new FormData(event.currentTarget);
					const next = new URLSearchParams();
					for (const [key, value] of data) if (String(value)) next.set(key, String(value));
					setSearch(next);
				}}
			>
				<label>
					Search runs
					<input name="q" defaultValue={q} placeholder="Run, agent, model or request" />
				</label>
				<label>
					Source
					<select name="source" defaultValue={source ?? ""}>
						<option value="">All sources</option>
						<option value="session">Session</option>
						<option value="dispatch">Dispatch</option>
					</select>
				</label>
				<label>
					Status
					<select name="status" defaultValue={status ?? ""}>
						<option value="">All statuses</option>
						{["queued", "running", "success", "fail"].map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				<button type="submit" className="primary">
					Filter
				</button>
			</form>
			{availability.error || runs.error ? <p role="alert">{availability.error?.message ?? runs.error?.message}</p> : null}
			{availability.data?.available === false ? (
				<div className="trace-panel">
					<h2>No trace database available</h2>
					<p>
						Run a Clio session or dispatch to record execution history. An existing database must use the supported schema and
						WAL mode.
					</p>
				</div>
			) : null}
			{availability.isPending || (availability.data?.available && runs.isPending) ? <p>Loading trace history…</p> : null}
			{runs.data?.pages.map((page) =>
				page.runs.map((run) => (
					<Link className="trace-run-card" key={run.run_id} to={`/traces/${encodeURIComponent(run.run_id)}`}>
						<div>
							<span className={`trace-badge ${run.status}`}>{run.status === "running" ? "● running" : run.status}</span>{" "}
							<span className="trace-badge">{run.source}</span>
							<h2>{run.request ?? run.run_id}</h2>
							<p>
								{run.agent} · {run.model}
							</p>
							<small>
								{run.run_id} · {formatTime(run.started_at)}
							</small>
						</div>
						<div className="trace-spend">
							<strong>{formatCost(run.total_cost_usd)}</strong>
							<small>{formatTokens(run.total_tokens)} tokens</small>
						</div>
					</Link>
				)),
			)}
			{runs.data?.pages[0]?.runs.length === 0 ? <p>No runs match these filters.</p> : null}
			{runs.hasNextPage ? (
				<button type="button" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetchingNextPage}>
					Load more runs
				</button>
			) : null}
			{availability.data ? (
				<p className="trace-note">
					Retention: {availability.data.retentionPolicy.maxAgeDays} days ·{" "}
					{Math.round(availability.data.retentionPolicy.maxBytes / 1024 / 1024)} MiB. History refreshes every five seconds.
				</p>
			) : null}
		</section>
	);
}
