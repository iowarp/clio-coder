import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { routes } from "../../../contracts/routes.js";
import type { Client } from "../../api/client.js";
import { clock, formatTime } from "../../api/clock.js";
import { PanelEmpty } from "../../design/panel.js";
import { emptyState } from "../../design/panel-model.js";
import { InspectionError, InspectionTabs } from "../../design/run-inspection.js";
import { StatusMark } from "../../design/status.js";
import { Explained } from "../../telemetry/Explained.js";
import { listDestination } from "../run-inspection-model.js";
import "./trace-live.css";
import { CallWaterfall, Facts, ReceiptPanel, SpendPanel } from "./panels.js";
import "../run-inspection.css";
import { liveLabel, liveRefetchMs } from "./trace-live-model.js";
import { entryLabel, histogram, journalNote, runIsLive, runTone, runTotals } from "./trace-model.js";
import { TraceReplay } from "./trace-replay.js";
export function TraceRunPage({ client }: { client: Client }) {
	const { runId = "" } = useParams();
	return <Run key={runId} client={client} runId={runId} />;
}
function Run({ client, runId }: { client: Client; runId: string }) {
	const [search, setSearch] = useSearchParams();
	const requestedView = search.get("view");
	const view = requestedView === "execution" || requestedView === "checks" ? requestedView : "replay";
	const selectView = (value: "replay" | "execution" | "checks") => {
		const next = new URLSearchParams(search);
		next.set("view", value);
		setSearch(next);
	};
	const list = search.get("list") ?? "/traces";
	const back = listDestination("/traces", new URLSearchParams(list.startsWith("/traces?") ? list.slice(8) : ""), [
		"q",
		"status",
		"sort",
	]);
	const [full, setFull] = useState(false),
		[now, setNow] = useState(clock.now());
	const input = { params: { runId }, query: {}, body: {} };
	const run = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["trace-run", runId],
		queryFn: () => client.call(routes.traceRun, input),
		refetchInterval: (query) => liveRefetchMs(query.state.data?.status),
	});
	const status = run.data?.status;
	// A run the ledger knows but whose directory never existed has no journal to read; that is a state, not an error.
	const journaled = run.data !== undefined && run.data.writtenAt !== null;
	const detail = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", "run", runId],
		queryFn: () => client.call(routes.telemetryRun, input),
		enabled: journaled,
		refetchInterval: liveRefetchMs(status),
	});
	const timeline = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", "run-timeline", runId],
		queryFn: () => client.call(routes.telemetryRunTimeline, input),
		enabled: journaled,
		refetchInterval: liveRefetchMs(status),
	});
	const cost = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", "run-cost", runId],
		queryFn: () => client.call(routes.telemetryRunCost, input),
		enabled: journaled,
		refetchInterval: liveRefetchMs(status),
	});
	const receipt = useQuery({
		meta: { errorSurface: "inline" },
		placeholderData: (previous) => previous,
		queryKey: ["trace-receipt", runId, full],
		enabled: full,
		queryFn: () => client.call(routes.traceReceipt, { ...input, query: full ? { include: "full" } : {} }),
		refetchInterval: liveRefetchMs(status),
	});
	useEffect(() => {
		if (!runIsLive(status)) return;
		const interval = setInterval(() => setNow(clock.now()), 500);
		return () => clearInterval(interval);
	}, [status]);
	const retry = () => {
		void run.refetch();
		void detail.refetch();
		void timeline.refetch();
		void cost.refetch();
		void receipt.refetch();
	};
	const failure = run.error ?? detail.error ?? timeline.error ?? cost.error ?? receipt.error;
	if (!run.data)
		return (
			<section className="run-inspection">
				<Link to={back}>← Trace history</Link>
				{run.error ? (
					<>
						<h1>Trace unavailable</h1>
						<InspectionError title="Run could not be read" error={run.error as Error} busy={run.isFetching} retry={retry} />
					</>
				) : (
					<p role="status">Reading the run, its journal and saved receipt…</p>
				)}
			</section>
		);
	const trace = run.data;
	const entries = timeline.data?.entries ?? [];
	const kinds = histogram(entries.map((entry) => entryLabel(entry).kind));
	const calls = entries.filter((entry) => entry.kind === "call").length;
	const live = liveLabel(status);
	const note = journaled
		? journalNote(detail.data)
		: "No run journal was written for this run, so its calls and spend are unknown.";
	return (
		<section className="trace-run-detail run-inspection">
			<Link to={back}>← Trace history</Link>
			<p className="eyebrow">{trace.identity ? "dispatch" : "standalone"} execution record</p>
			<h1>{trace.identity?.task || trace.runId}</h1>
			<div className="trace-event-head">
				<StatusMark tone={runTone(trace.status)} label={trace.status} />
				{live ? (
					<span role="status" className="trace-live" data-state="live">
						{live}
					</span>
				) : null}
			</div>
			<p className="panel-note">Run journal record · receipt integrity is a separate check</p>
			{note ? <p className="trace-warning">{note}</p> : null}
			<ul className="trace-totals">
				{runTotals(trace, detail.data, now).map((total) => (
					<li key={total.label}>
						<span>{total.label}</span>
						<strong>
							<Explained client={client} {...total} />
						</strong>
					</li>
				))}
			</ul>
			<details className="trace-panel">
				<summary>Run identity & runtime</summary>
				<p className="inspection-id">{trace.runId}</p>
				{trace.identity ? null : <p className="panel-note">The dispatch ledger holds no row for this run.</p>}
				<Facts
					entries={[
						["Agent", trace.identity?.agentId],
						["Model", trace.identity?.model],
						["Target", trace.identity?.targetId],
						["Node", trace.identity?.node],
						["Session", trace.identity?.sessionId ?? trace.telemetry.sessionId],
						["Started", formatTime(trace.identity?.startedAt ?? trace.telemetry.firstAt)],
						["Settled", trace.telemetry.terminalReason?.replaceAll("_", " ")],
					]}
				/>
			</details>
			{failure && (
				<InspectionError
					title="Refresh failed; showing the last loaded record"
					error={failure as Error}
					busy={run.isFetching || detail.isFetching || timeline.isFetching || cost.isFetching || receipt.isFetching}
					retry={retry}
				/>
			)}
			<InspectionTabs
				label="Trace views"
				value={view}
				onChange={selectView}
				tabs={[
					{ id: "replay", label: `Replay · ${entries.length} entries` },
					{ id: "execution", label: `Execution · ${calls} ${calls === 1 ? "call" : "calls"}` },
					{ id: "checks", label: "Checks & receipt" },
				]}
			>
				{view === "replay" &&
					(timeline.data ? (
						<TraceReplay client={client} run={trace} timeline={entries} live={runIsLive(status)} />
					) : journaled ? (
						<p role="status">Reading the run timeline…</p>
					) : (
						<PanelEmpty>{emptyState.emptyStore("journal entry", "for this run")}</PanelEmpty>
					))}
				{view === "execution" && (
					<>
						{journaled ? <SpendPanel client={client} detail={detail.data} cost={cost.data} /> : null}
						<CallWaterfall client={client} run={trace} entries={entries} />
						<section className="trace-panel">
							<h2>Recorded activity</h2>
							{!kinds.rows.length && <PanelEmpty>{emptyState.emptyStore("journal entry", "for this run")}</PanelEmpty>}
							<ul className="trace-histogram">
								{kinds.rows.map((row) => (
									<li key={row.label}>
										<span>{row.label}</span>
										<span className="trace-histogram__track" aria-hidden="true">
											<i style={{ width: `${Math.round(row.share * 100)}%` }} />
										</span>
										<strong>{row.count.toLocaleString("en-US")}</strong>
									</li>
								))}
							</ul>
							{kinds.omitted && <p className="panel-note">{kinds.omitted}</p>}
						</section>
					</>
				)}
				{view === "checks" && (
					<>
						{full && receipt.isPlaceholderData && <p role="status">Reading the complete saved receipt…</p>}
						{trace ? (
							<ReceiptPanel
								data={{
									evidence: trace.evidence,
									record: full && !receipt.isPlaceholderData ? (receipt.data?.record ?? null) : null,
								}}
								full={full && !!receipt.data && !receipt.isPlaceholderData}
								loading={full && (receipt.isPending || receipt.isPlaceholderData)}
								loadFull={() => setFull(true)}
							/>
						) : (
							<p role="status">Reading the saved receipt…</p>
						)}
					</>
				)}
			</InspectionTabs>
		</section>
	);
}
