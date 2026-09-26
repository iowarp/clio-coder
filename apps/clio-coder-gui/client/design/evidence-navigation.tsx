import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
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
	referenceRefused,
} from "./inspection-navigation.js";
import type { StatusTone } from "./status.js";

const verdictTones: Record<string, StatusTone> = {
	compromised: "fail",
	unverified: "unverified",
	unknown: "unverified",
	grounded: "neutral",
	reviewed: "neutral",
};
export function EvidenceNavigation({ client, close, conversationPath }: InspectionNavigationProps) {
	const navigate = useNavigate();
	const queries = useQueryClient();
	const [urlSearch] = useSearchParams();
	const [localSearch, setLocalSearch] = useState(new URLSearchParams());
	const search = conversationPath ? localSearch : urlSearch;
	const [selectedId, setSelectedId] = useState<string>();
	const q = search.get("q") ?? "",
		verdict = search.get("verdict") ?? "";
	const inventory = useInfiniteQuery({
		queryKey: ["evidence"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.evidenceList, {
				...emptyInput,
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const rows = admittedPages(inventory)
		.flatMap((page) => page.items)
		.filter(
			(item) =>
				(!verdict || item.verdict === verdict) &&
				matchesText(q, [
					item.overview.evidenceId,
					...item.overview.tasks,
					...item.overview.runIds,
					...item.overview.agentIds,
					...item.overview.modelIds,
				]),
		)
		.map(({ overview, verdict: trust }) => ({
			id: overview.evidenceId,
			title: overview.tasks[0] || overview.evidenceId,
			detail: `Collected ${formatTime(overview.generatedAt)} · ${overview.totals.runs} runs`,
			status: trust,
			tone: verdictTones[trust] ?? "unverified",
			href: listDestination(`/evidence/${encodeURIComponent(overview.evidenceId)}`, search, ["q", "verdict"]),
		}));
	const selected = rows.find((row) => row.id === selectedId);
	const live = retainedLinksLive(inventory);
	const detail = useQuery({
		queryKey: ["evidence-detail", selectedId ?? ""],
		queryFn: () => client.call(routes.evidenceDetail, { ...emptyInput, params: { id: selectedId ?? "" } }),
		enabled: (query) => !!conversationPath && !!selected && live && !referenceRefused(query.state.error),
		retry: false,
	});
	return (
		<InspectionNavigation scope="Collected evidence · installation history · verdicts are recorded summaries">
			<form
				className="inspection-navigation__filters"
				key={`${q}:${verdict}`}
				onSubmit={(event) => {
					event.preventDefault();
					const next = new URLSearchParams();
					for (const [key, value] of new FormData(event.currentTarget))
						if (String(value).trim()) next.set(key, String(value).trim());
					setSelectedId(undefined);
					if (conversationPath) setLocalSearch(next);
					else void navigate(`/evidence${next.size ? `?${next}` : ""}`);
				}}
			>
				<label>
					Search loaded bundles
					<input name="q" defaultValue={q} maxLength={256} placeholder="Task, run, agent, model or ID" />
				</label>
				<label>
					Trust verdict
					<select name="verdict" defaultValue={verdict}>
						<option value="">All verdicts</option>
						{Object.keys(verdictTones).map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				<button type="submit">Filter bundles</button>
			</form>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll collected evidence independently. */}
			<section className="inspection-navigation__scroll" aria-label="Evidence bundle list" tabIndex={0}>
				{conversationPath && selectedId ? (
					<InspectionSelection
						title="Selected evidence"
						row={selected}
						live={live && !referenceRefused(detail.error)}
						recover={() => {
							setSelectedId(undefined);
							void inventory.refetch();
						}}
						recovering={inventory.isFetching}
						viewerLabel="Open evidence viewer"
						dismiss={() => setSelectedId(undefined)}
						close={close}
					>
						{detail.isPending && selected ? <p role="status">Reading evidence…</p> : null}
						{detail.error ? (
							<p role="alert">
								{detail.error.message}{" "}
								<button
									type="button"
									disabled={!selected || !live || detail.isFetching || referenceRefused(detail.error)}
									onClick={() => {
										if (selected && live && !referenceRefused(detail.error)) void detail.refetch();
									}}
								>
									Retry
								</button>
							</p>
						) : null}
						{detail.data ? (
							<dl>
								<dt>Recorded verdict</dt>
								<dd>{detail.data.verdict}</dd>
								<dt>Collected</dt>
								<dd>{formatTime(detail.data.overview.generatedAt)}</dd>
								<dt>Runs</dt>
								<dd>{detail.data.overview.totals.runs}</dd>
								<dt>Findings</dt>
								<dd>{detail.data.findings.length}</dd>
								<dt>Projection</dt>
								<dd>{detail.data.projection}</dd>
							</dl>
						) : null}
					</InspectionSelection>
				) : null}
				<InspectionRecords
					title="Collected bundles"
					onSelect={
						conversationPath
							? (row) => {
									const key = ["evidence-detail", row.id];
									if (referenceRefused(queries.getQueryState(key)?.error))
										void queries.resetQueries({ queryKey: key, exact: true });
									setSelectedId(row.id);
								}
							: undefined
					}
					selectedId={selectedId}
					rows={rows}
					query={inventory}
					live={retainedLinksLive(inventory)}
					absent={inventory.data?.pages[0]?.present === false}
					close={close}
				/>
			</section>
		</InspectionNavigation>
	);
}
