import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { type Input, routes } from "../../contracts/routes.js";
import { emptyInput } from "../api/client.js";
import { formatCost, formatTime } from "../api/clock.js";
import { listDestination } from "../pages/run-inspection-model.js";
import {
	InspectionNavigation,
	type InspectionNavigationProps,
	InspectionRecords,
	InspectionSelection,
	referenceRefused,
} from "./inspection-navigation.js";
import { toneForOutcome } from "./status.js";

export function TraceNavigation({ client, close, conversationPath }: InspectionNavigationProps) {
	const navigate = useNavigate();
	const queries = useQueryClient();
	const [search] = useSearchParams();
	const [localSearch, setLocalSearch] = useState(new URLSearchParams());
	const [selectedId, setSelectedId] = useState<string>();
	const activeSearch = conversationPath ? localSearch : search;
	const retainedList = activeSearch.get("list");
	const filters = retainedList?.startsWith("/traces?")
		? new URLSearchParams(retainedList.slice("/traces?".length))
		: activeSearch;
	const source = filters.get("source"),
		status = filters.get("status"),
		q = filters.get("q") ?? "";
	const filter: Input<typeof routes.traceRuns>["query"] = {
		...(source === "dispatch" || source === "session" ? { source } : {}),
		...(status === "queued" || status === "running" || status === "success" || status === "fail" ? { status } : {}),
		...(q ? { q } : {}),
	};
	const availability = useQuery({
		queryKey: ["trace-status"],
		queryFn: () => client.call(routes.traceStatus, emptyInput),
		refetchInterval: 5000,
	});
	const runs = useInfiniteQuery({
		queryKey: ["trace-runs", filter],
		initialPageParam: null as string | null,
		queryFn: ({ pageParam }) =>
			client.call(routes.traceRuns, {
				...emptyInput,
				query: { ...filter, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor,
		refetchInterval: 5000,
		enabled: availability.data?.available === true,
	});
	const destination = listDestination("/traces", filters, ["q", "source", "status"]);
	const rows =
		availability.data?.available === true
			? (runs.data?.pages ?? [])
					.flatMap((page) => page.runs)
					.map((run) => ({
						id: run.run_id,
						title: run.request || run.run_id,
						detail: `${run.source} · ${formatTime(run.started_at)} · ${formatCost(run.total_cost_usd)}`,
						status: run.status,
						tone: toneForOutcome(run.status === "fail" ? "failed" : run.status),
						href: `/traces/${encodeURIComponent(run.run_id)}?${new URLSearchParams({ list: destination })}`,
					}))
			: [];
	const selected = rows.find((row) => row.id === selectedId);
	const detail = useQuery({
		queryKey: ["trace-sidebar-run", selectedId],
		queryFn: () => client.call(routes.traceRun, { ...emptyInput, params: { runId: selectedId ?? "" } }),
		enabled: (query) => !!conversationPath && !!selected && !referenceRefused(query.state.error),
		retry: false,
		refetchInterval: selected ? 5000 : false,
	});
	return (
		<InspectionNavigation scope="Installation trace history · recorded session and dispatch runs">
			<form
				className="inspection-navigation__filters"
				key={destination}
				onSubmit={(event) => {
					event.preventDefault();
					const next = new URLSearchParams();
					for (const [key, value] of new FormData(event.currentTarget))
						if (String(value).trim()) next.set(key, String(value).trim());
					setSelectedId(undefined);
					if (conversationPath) setLocalSearch(next);
					else void navigate(`/traces${next.size ? `?${next}` : ""}`);
				}}
			>
				<label>
					Search runs
					<input name="q" defaultValue={q} maxLength={256} placeholder="Run, request, agent or model" />
				</label>
				<label>
					Source
					<select name="source" defaultValue={filter.source ?? ""}>
						<option value="">All sources</option>
						<option value="session">Session</option>
						<option value="dispatch">Dispatch</option>
					</select>
				</label>
				<label>
					Status
					<select name="status" defaultValue={filter.status ?? ""}>
						<option value="">All statuses</option>
						{["queued", "running", "success", "fail"].map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				<button type="submit">Filter runs</button>
			</form>
			{availability.error ? (
				<p className="inspection-navigation__note" role="alert">
					{availability.error.message}{" "}
					<button type="button" disabled={availability.isFetching} onClick={() => void availability.refetch()}>
						Retry database read
					</button>
				</p>
			) : null}
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll recorded runs independently. */}
			<section className="inspection-navigation__scroll" aria-label="Trace run list" tabIndex={0}>
				{conversationPath && selectedId ? (
					<InspectionSelection
						title="Selected trace"
						row={selected}
						live={!!selected && !referenceRefused(detail.error)}
						recover={() => {
							setSelectedId(undefined);
							void runs.refetch();
						}}
						recovering={runs.isFetching}
						viewerLabel="Open trace viewer"
						dismiss={() => setSelectedId(undefined)}
						close={close}
					>
						{detail.isPending && selected ? <p role="status">Reading trace…</p> : null}
						{detail.error ? (
							<p role="alert">
								{detail.error.message}{" "}
								<button
									type="button"
									disabled={!selected || detail.isFetching || referenceRefused(detail.error)}
									onClick={() => {
										if (selected && !referenceRefused(detail.error)) void detail.refetch();
									}}
								>
									Retry
								</button>
							</p>
						) : null}
						{detail.data ? (
							<dl>
								<dt>Status</dt>
								<dd>{detail.data.status}</dd>
								<dt>Source</dt>
								<dd>{detail.data.source}</dd>
								<dt>Agent</dt>
								<dd>{detail.data.agent}</dd>
								<dt>Model</dt>
								<dd>{detail.data.model}</dd>
								<dt>Reported cost</dt>
								<dd>{formatCost(detail.data.total_cost_usd)}</dd>
								<dt>Started</dt>
								<dd>{formatTime(detail.data.started_at)}</dd>
								<dt>Ended</dt>
								<dd>{detail.data.ended_at ? formatTime(detail.data.ended_at) : "No end recorded"}</dd>
							</dl>
						) : null}
					</InspectionSelection>
				) : null}
				<InspectionRecords
					title="Recorded runs"
					onSelect={
						conversationPath
							? (row) => {
									const key = ["trace-sidebar-run", row.id];
									if (referenceRefused(queries.getQueryState(key)?.error))
										void queries.resetQueries({ queryKey: key, exact: true });
									setSelectedId(row.id);
								}
							: undefined
					}
					selectedId={selectedId}
					rows={rows}
					query={runs}
					unavailable={availability.data?.available === false}
					close={close}
				/>
			</section>
		</InspectionNavigation>
	);
}
