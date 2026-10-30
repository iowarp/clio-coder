import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { Input } from "../../../contracts/routes.js";
import { routes } from "../../../contracts/routes.js";
import type { Client } from "../../api/client.js";
import { formatTime } from "../../api/clock.js";
import { PanelEmpty } from "../../design/panel.js";
import { InspectionError, InspectionSummary } from "../../design/run-inspection.js";
import { quantityText } from "../../telemetry/quantity-model.js";
import { inspectionSort, listDestination, sortInspectionRecords } from "../run-inspection-model.js";
import "../run-inspection.css";
import { emptyState } from "../../design/panel-model.js";
import { captureCoverageLabel } from "./trace-model.js";
export function TraceRuns({ client }: { client: Client }) {
	const [search, setSearch] = useSearchParams();
	const source = search.get("source"),
		status = search.get("status"),
		q = search.get("q") ?? "";
	const sort = inspectionSort(search.get("sort"));
	const filter: Input<typeof routes.traceRuns>["query"] = {
		...(source === "dispatch" || source === "session" ? { source } : {}),
		...(status === "queued" || status === "running" || status === "success" || status === "fail" ? { status } : {}),
		...(q ? { q } : {}),
	};
	const availability = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["trace-status"],
		queryFn: () => client.call(routes.traceStatus, { params: {}, query: {}, body: {} }),
		refetchInterval: 5000,
	});
	const runs = useInfiniteQuery({
		meta: { errorSurface: "inline" },
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
	const loaded = runs.data?.pages.flatMap((page) => page.runs) ?? [];
	const ordered = sortInspectionRecords(loaded, sort, (run) => ({
		name: run.request || run.run_id,
		date: run.started_at,
		id: run.run_id,
	}));
	return (
		<section className="run-inspection">
			<p className="eyebrow">Execution history</p>
			<h1>Traces</h1>
			<p className="intro">Follow a run from its first decision to its final evidence.</p>
			{availability.data && (
				<details className="inspection-record-meta">
					<summary>Capture coverage & retention</summary>
					<p className="trace-note">{captureCoverageLabel(availability.data.captureCoverage)}</p>
					<p className="trace-note">
						Retention: {availability.data.retentionPolicy.maxAgeDays} days ·{" "}
						{Math.round(availability.data.retentionPolicy.maxBytes / 1024 / 1024)} MiB.
					</p>
				</details>
			)}
			<form
				className="trace-filters"
				key={search.toString()}
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
					<input name="q" defaultValue={q} placeholder="Run, agent, model or request" maxLength={256} />
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
				<label>
					Sort loaded runs
					<select name="sort" defaultValue={sort}>
						<option value="newest">Newest first</option>
						<option value="oldest">Oldest first</option>
						<option value="name">Request name</option>
					</select>
				</label>
				<button type="submit">Apply</button>
			</form>
			{availability.error && (
				<InspectionError
					title="Trace service unavailable"
					error={availability.error}
					busy={availability.isFetching}
					retry={() => {
						void availability.refetch();
					}}
				/>
			)}
			{runs.error && (
				<InspectionError
					title="Run history could not refresh"
					error={runs.error}
					busy={runs.isFetching}
					retry={() => {
						void runs.refetch();
					}}
				/>
			)}
			{runs.error && runs.data && <p className="panel-note">Showing the last loaded history.</p>}
			{availability.data?.available === false ? (
				<div className="trace-panel">
					<h2>No trace database available</h2>
					<PanelEmpty>{emptyState.missingStore("execution trace")}</PanelEmpty>
					<p>
						Run a Clio session or dispatch to record execution history. An existing database must use the supported schema and
						WAL mode.
					</p>
				</div>
			) : null}
			{availability.isPending || (availability.data?.available && runs.isPending) ? <p>Loading trace history…</p> : null}
			<div className="inspection-heading">
				<h2>Recorded runs</h2>
				<span className="panel-note">Installation history · refreshes every 5 seconds</span>
				<button
					type="button"
					disabled={availability.isFetching || runs.isFetching}
					onClick={() => {
						void availability.refetch();
						if (availability.data?.available) void runs.refetch();
					}}
				>
					Refresh traces
				</button>
			</div>
			{(q || source || status || sort !== "newest") && <Link to="/traces">Reset view</Link>}
			{availability.data?.available && runs.data && (
				<InspectionSummary
					figures={[
						{ label: "Runs loaded", value: loaded.length },
						{ label: "Running · loaded", value: loaded.filter((run) => run.status === "running").length },
						{ label: "Failed · loaded", value: loaded.filter((run) => run.status === "fail").length },
					]}
				/>
			)}
			{availability.data?.available === true &&
				ordered.map((run) => (
					<Link
						className="trace-run-card"
						key={run.run_id}
						to={`/traces/${encodeURIComponent(run.run_id)}?${new URLSearchParams({ list: listDestination("/traces", search, ["q", "source", "status", "sort"]) })}`}
					>
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
							<strong>{quantityText(run.telemetry?.usd)}</strong>
							<small>{quantityText(run.telemetry?.tokens)} tokens</small>
						</div>
					</Link>
				))}
			{availability.data?.available === true && runs.data?.pages[0]?.runs.length === 0 ? (
				<PanelEmpty>
					{q || source || status
						? "No run matches these filters. Reset the view to return to all retained runs."
						: "No execution history has been recorded. Start work in a conversation to create a trace."}
				</PanelEmpty>
			) : null}
			{availability.data?.available === true && runs.hasNextPage ? (
				<PanelEmpty>{emptyState.bounded("runs")}</PanelEmpty>
			) : null}
			{availability.data?.available === true && runs.hasNextPage ? (
				<button type="button" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetching}>
					{runs.isFetchingNextPage ? "Loading runs…" : "Load older runs"}
				</button>
			) : null}
		</section>
	);
}
