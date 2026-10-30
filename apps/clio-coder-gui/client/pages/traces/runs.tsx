import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import type { Input } from "../../../contracts/routes.js";
import { routes } from "../../../contracts/routes.js";
import type { Client } from "../../api/client.js";
import { formatTime } from "../../api/clock.js";
import { tokensText } from "../../chat/session-usage-model.js";
import { PanelEmpty } from "../../design/panel.js";
import { InspectionError, InspectionSummary } from "../../design/run-inspection.js";
import { quantityText } from "../../telemetry/quantity-model.js";
import { inspectionSort, listDestination, sortInspectionRecords } from "../run-inspection-model.js";
import "../run-inspection.css";
import { emptyState } from "../../design/panel-model.js";

const STATUSES = ["queued", "running", "success", "fail", "unknown"] as const;
export function TraceRuns({ client }: { client: Client }) {
	const [search, setSearch] = useSearchParams();
	const status = STATUSES.find((value) => value === search.get("status")) ?? null,
		q = search.get("q") ?? "";
	const sort = inspectionSort(search.get("sort"));
	const filter: Input<typeof routes.traceRuns>["query"] = { ...(status ? { status } : {}), ...(q ? { q } : {}) };
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
	});
	const loaded = runs.data?.pages.flatMap((page) => page.runs) ?? [];
	const ordered = sortInspectionRecords(loaded, sort, (run) => ({
		name: run.identity?.task || run.runId,
		date: run.identity?.startedAt ?? run.telemetry.firstAt ?? run.writtenAt ?? "",
		id: run.runId,
	}));
	return (
		<section className="run-inspection">
			<p className="eyebrow">Execution history</p>
			<h1>Traces</h1>
			<p className="intro">Follow a run from its first decision to its final evidence.</p>
			<p className="panel-note">
				Each run's journal, newest write first, named from the dispatch ledger. Runs from before run journals are listed
				under Fleet.
			</p>
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
					Status
					<select name="status" defaultValue={status ?? ""}>
						<option value="">All statuses</option>
						{STATUSES.map((value) => (
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
			{runs.isPending ? <p>Loading trace history…</p> : null}
			<div className="inspection-heading">
				<h2>Recorded runs</h2>
				<span className="panel-note">Installation history · refreshes every 5 seconds</span>
				<button
					type="button"
					disabled={runs.isFetching}
					onClick={() => {
						void runs.refetch();
					}}
				>
					Refresh traces
				</button>
			</div>
			{(q || status || sort !== "newest") && <Link to="/traces">Reset view</Link>}
			{runs.data && (
				<InspectionSummary
					figures={[
						{ label: "Runs loaded", value: loaded.length },
						{ label: "Running · loaded", value: loaded.filter((run) => run.status === "running").length },
						{ label: "Failed · loaded", value: loaded.filter((run) => run.status === "fail").length },
					]}
				/>
			)}
			{ordered.map((run) => (
				<Link
					className="trace-run-card"
					key={run.runId}
					to={`/traces/${encodeURIComponent(run.runId)}?${new URLSearchParams({ list: listDestination("/traces", search, ["q", "status", "sort"]) })}`}
				>
					<div>
						<span className={`trace-badge ${run.status}`}>{run.status === "running" ? "● running" : run.status}</span>{" "}
						<span className="trace-badge">{run.identity ? "dispatch" : "standalone"}</span>
						<h2>{run.identity?.task || run.runId}</h2>
						<p>{run.identity ? `${run.identity.agentId} · ${run.identity.model}` : "Not in the dispatch ledger"}</p>
						<small>
							{run.runId} · {formatTime(run.identity?.startedAt ?? run.telemetry.firstAt ?? run.writtenAt)}
						</small>
					</div>
					<div className="trace-spend">
						<strong>{quantityText(run.telemetry.usd)}</strong>
						<small>{tokensText(quantityText(run.telemetry.tokens))}</small>
					</div>
				</Link>
			))}
			{runs.data?.pages[0]?.runs.length === 0 ? (
				<PanelEmpty>
					{q || status
						? "No run matches these filters. Reset the view to return to all retained runs."
						: "No run journal has been recorded. Dispatch work from a conversation to create one."}
				</PanelEmpty>
			) : null}
			{runs.hasNextPage ? <PanelEmpty>{emptyState.bounded("runs")}</PanelEmpty> : null}
			{runs.hasNextPage ? (
				<button type="button" onClick={() => void runs.fetchNextPage()} disabled={runs.isFetching}>
					{runs.isFetchingNextPage ? "Loading runs…" : "Load older runs"}
				</button>
			) : null}
		</section>
	);
}
