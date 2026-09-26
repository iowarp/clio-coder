import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import {
	ARTIFACT_MAX_PAGES,
	ARTIFACT_PAGE_SIZE,
	admittedPages,
	retainedLinksLive,
} from "../pages/artifact-pagination.js";
import { listDestination, matchesText } from "../pages/run-inspection-model.js";
import {
	InspectionNavigation,
	type InspectionNavigationProps,
	InspectionRecords,
	InspectionSelection,
} from "./inspection-navigation.js";
import { toneForOutcome } from "./status.js";

export function FleetNavigation({ client, close, conversationPath }: InspectionNavigationProps) {
	const navigate = useNavigate();
	const [urlSearch] = useSearchParams();
	const [localSearch, setLocalSearch] = useState(new URLSearchParams());
	const search = conversationPath ? localSearch : urlSearch;
	const [selected, setSelected] = useState<{ id: string; dispatch: boolean }>();
	const q = search.get("q") ?? "",
		status = search.get("status") ?? "";
	const roots = useInfiniteQuery({
		queryKey: ["fleet-roots"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.fleetRoots, {
				...emptyInput,
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const dispatches = useInfiniteQuery({
		queryKey: ["fleet-dispatches"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.dispatchRuns, {
				...emptyInput,
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const matchesEnd = (end: string | null) => !status || (status === "active" ? !end : !!end);
	const executionRows = admittedPages(roots)
		.flatMap((page) => page.items)
		.filter((run) => matchesText(q, [run.id, run.fleet]) && matchesEnd(run.endedAt))
		.map((run) => ({
			id: run.id,
			title: run.fleet || run.id,
			detail: `${formatTime(run.startedAt)} · ${run.completedCount}/${run.stepCount} recorded steps`,
			status: run.endedAt ? "End recorded" : "No end recorded",
			tone: toneForOutcome(null),
			href: listDestination(`/fleet/${encodeURIComponent(run.id)}`, search, ["q", "status"]),
		}));
	const dispatchRows = admittedPages(dispatches)
		.flatMap((page) => page.items)
		.filter(
			(run) => matchesText(q, [run.id, run.agentId, run.task, run.targetId, run.wireModelId]) && matchesEnd(run.endedAt),
		)
		.map((run) => ({
			id: run.id,
			title: run.task || run.id,
			detail: `${run.agentId} · ${formatTime(run.startedAt)}`,
			status: run.outcome ?? run.status,
			tone: toneForOutcome(run.outcome ?? run.status),
			href: listDestination(`/fleet/dispatches/${encodeURIComponent(run.id)}`, search, ["q", "status"]),
		}));
	const selectedRow = (selected?.dispatch ? dispatchRows : executionRows).find((row) => row.id === selected?.id);
	const selectedLive = selected?.dispatch ? retainedLinksLive(dispatches) : retainedLinksLive(roots);
	const rootDetail = useQuery({
		queryKey: ["fleet-root", selected?.id ?? ""],
		queryFn: () => client.call(routes.fleetRoot, { ...emptyInput, params: { id: selected?.id ?? "" } }),
		enabled: !!conversationPath && !!selectedRow && !!selectedLive && selected?.dispatch === false,
		retry: false,
	});
	const dispatchDetail = useQuery({
		queryKey: ["fleet-dispatch", selected?.id ?? ""],
		queryFn: () => client.call(routes.dispatchRun, { ...emptyInput, params: { id: selected?.id ?? "" } }),
		enabled: !!conversationPath && !!selectedRow && !!selectedLive && selected?.dispatch === true,
		retry: false,
	});
	const detailQuery = selected?.dispatch ? dispatchDetail : rootDetail;
	return (
		<InspectionNavigation scope="Installation Fleet history · recorded executions and dispatched workers">
			<form
				className="inspection-navigation__filters"
				key={`${q}:${status}`}
				onSubmit={(event) => {
					event.preventDefault();
					const next = new URLSearchParams();
					for (const [key, value] of new FormData(event.currentTarget))
						if (String(value).trim()) next.set(key, String(value).trim());
					setSelected(undefined);
					if (conversationPath) setLocalSearch(next);
					else void navigate(`/fleet${next.size ? `?${next}` : ""}`);
				}}
			>
				<label>
					Search loaded history
					<input name="q" defaultValue={q} maxLength={256} placeholder="Fleet, task, agent, model or ID" />
				</label>
				<label>
					Recorded activity
					<select name="status" defaultValue={status}>
						<option value="">All records</option>
						<option value="active">No end recorded</option>
						<option value="ended">End recorded</option>
					</select>
				</label>
				<button type="submit">Filter history</button>
			</form>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll recorded Fleet history independently. */}
			<section className="inspection-navigation__scroll" aria-label="Fleet history list" tabIndex={0}>
				{conversationPath && selected ? (
					<InspectionSelection
						title="Selected Fleet record"
						row={selectedRow}
						live={selectedLive}
						viewerLabel="Open Fleet viewer"
						dismiss={() => setSelected(undefined)}
						close={close}
					>
						{detailQuery.isPending && selectedRow ? <p role="status">Reading record…</p> : null}
						{detailQuery.error ? (
							<p role="alert">
								{detailQuery.error.message}{" "}
								<button type="button" onClick={() => void detailQuery.refetch()}>
									Retry
								</button>
							</p>
						) : null}
						{selected.dispatch && dispatchDetail.data ? (
							<dl>
								<dt>Outcome</dt>
								<dd>{dispatchDetail.data.outcome ?? dispatchDetail.data.status}</dd>
								<dt>Agent</dt>
								<dd>{dispatchDetail.data.agentId}</dd>
								<dt>Model</dt>
								<dd>{dispatchDetail.data.wireModelId}</dd>
								<dt>Started</dt>
								<dd>{formatTime(dispatchDetail.data.startedAt)}</dd>
								<dt>Ended</dt>
								<dd>{dispatchDetail.data.endedAt ? formatTime(dispatchDetail.data.endedAt) : "No end recorded"}</dd>
								<dt>Recorded parent</dt>
								<dd>{dispatchDetail.data.parentRunId ?? "Not recorded"}</dd>
							</dl>
						) : null}
						{!selected.dispatch && rootDetail.data ? (
							<dl>
								<dt>Fleet</dt>
								<dd>{rootDetail.data.run.fleet}</dd>
								<dt>Recorded steps</dt>
								<dd>
									{rootDetail.data.run.completedCount} of {rootDetail.data.run.stepCount}
								</dd>
								<dt>Started</dt>
								<dd>{formatTime(rootDetail.data.run.startedAt)}</dd>
								<dt>Ended</dt>
								<dd>{rootDetail.data.run.endedAt ? formatTime(rootDetail.data.run.endedAt) : "No end recorded"}</dd>
							</dl>
						) : null}
					</InspectionSelection>
				) : null}
				<InspectionRecords
					title="Fleet executions"
					onSelect={conversationPath ? (row) => setSelected({ id: row.id, dispatch: false }) : undefined}
					selectedId={selected?.dispatch === false ? selected.id : undefined}
					rows={executionRows}
					query={roots}
					live={retainedLinksLive(roots)}
					absent={roots.data?.pages[0]?.present === false}
					close={close}
				/>
				<InspectionRecords
					title="Dispatched workers"
					onSelect={conversationPath ? (row) => setSelected({ id: row.id, dispatch: true }) : undefined}
					selectedId={selected?.dispatch === true ? selected.id : undefined}
					rows={dispatchRows}
					query={dispatches}
					live={retainedLinksLive(dispatches)}
					absent={dispatches.data?.pages[0]?.present === false}
					close={close}
				/>
			</section>
		</InspectionNavigation>
	);
}
