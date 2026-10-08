import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { routes } from "../../../contracts/routes.js";
import type { TraceEvent } from "../../../contracts/traces.js";
import type { Client } from "../../api/client.js";
import { clock, formatTime } from "../../api/clock.js";
import { PanelEmpty } from "../../design/panel.js";
import { emptyState } from "../../design/panel-model.js";
import { StatusMark } from "../../design/status.js";
import { listDestination } from "../run-inspection-model.js";
import "./trace-live.css";
import { CostPanel, EventRow, Facts, Gates, ReceiptPanel, Waterfall } from "./panels.js";
import "../run-inspection.css";
import { detailRefetchMs, liveLabel, mergeTraceEvents, runIsLive, type TraceLiveState } from "./trace-live-model.js";
import { histogram, orderedPhases, runTone, runTotals } from "./trace-model.js";
import { useTraceLive } from "./use-trace-live.js";
export function TraceRunPage({ client }: { client: Client }) {
	const { runId = "" } = useParams();
	return <Run key={runId} client={client} runId={runId} />;
}
function Run({ client, runId }: { client: Client; runId: string }) {
	const [search, setSearch] = useSearchParams();
	const selected = search.get("phase");
	const select = (id: string) => {
		const next = new URLSearchParams(search);
		next.set("phase", id);
		setSearch(next);
	};
	const list = search.get("list") ?? "/traces";
	const back = listDestination("/traces", new URLSearchParams(list.startsWith("/traces?") ? list.slice(8) : ""), [
		"q",
		"source",
		"status",
	]);
	const [full, setFull] = useState(false),
		[now, setNow] = useState(clock.now()),
		[tail, setTail] = useState<TraceLiveState>("idle");
	const input = { params: { runId }, query: {}, body: {} };
	const detail = useQuery({
		queryKey: ["trace-detail", runId, full],
		queryFn: async () => {
			const [run, phases, gates, processes, receipt] = await Promise.all([
				client.call(routes.traceRun, input),
				client.call(routes.tracePhases, input),
				client.call(routes.traceGates, input),
				client.call(routes.traceProcesses, input),
				client.call(routes.traceReceipt, { ...input, query: full ? { include: "full" } : {} }),
			]);
			return { run, phases, gates, processes, receipt };
		},
		// The live tail carries events; the header and phases only need a slow safety refresh while it holds.
		refetchInterval: (query) => detailRefetchMs(query.state.data?.run.status, tail),
	});
	const events = useQuery({
		queryKey: ["trace-events", runId],
		queryFn: async () => {
			let after = 0;
			let result: TraceEvent[] = [];
			while (true) {
				const page = await client.call(routes.traceEvents, { ...input, query: { after, limit: 500 } });
				result = mergeTraceEvents(result, page.events);
				after = page.cursor;
				if (!page.hasMore) return result;
			}
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
	const live = useTraceLive(client, runId, !!events.data && runIsLive(detail.data?.run.status));
	useEffect(() => setTail(live), [live]);
	useEffect(() => {
		if (detail.data?.run.status !== "running") return;
		const interval = setInterval(() => setNow(clock.now()), 500);
		return () => clearInterval(interval);
	}, [detail.data?.run.status]);
	if ((detail.error && !detail.data) || (events.error && !events.data))
		return (
			<div role="alert">
				<h1>Trace unavailable</h1>
				<p>{detail.error?.message ?? events.error?.message}</p>
				<Link to={back}>Back to traces</Link>
			</div>
		);
	if (!detail.data || !events.data) return <p>Loading run…</p>;
	const { run, gates, processes, receipt } = detail.data,
		phases = orderedPhases(detail.data.phases),
		phase = selected === "all" ? undefined : (phases.find((item) => item.phase_id === selected) ?? phases[0]),
		phaseEvents = events.data.filter((event) => !phase || event.phase_id === phase.phase_id),
		eventKinds = histogram(events.data.map((event) => event.type)),
		processKinds = histogram(processes.map((process) => process.kind));
	return (
		<section className="trace-run-detail run-inspection">
			<Link to={back}>← Trace history</Link>
			<p className="eyebrow">
				{run.source} / {run.run_id}
			</p>
			<h1>{run.request ?? run.run_id}</h1>
			<div className="trace-event-head">
				<StatusMark tone={runTone(run.status)} label={run.status} />
				<span role="status" className="trace-live" data-state={live}>
					{liveLabel[live]}
				</span>
			</div>
			<p className="panel-note">Durable run record · receipt integrity is a separate check</p>
			<ul className="trace-totals">
				{runTotals(run, now).map((total) => (
					<li key={total.label}>
						<span>{total.label}</span>
						<strong>{total.value}</strong>
					</li>
				))}
			</ul>
			<Facts
				entries={[
					["Agent", run.agent],
					["Model", run.model],
					["Target", run.target],
					["Node", run.node],
					["Started", formatTime(run.started_at)],
				]}
			/>
			{(detail.error || events.error) && (
				<p role="alert">
					Refresh failed: {detail.error?.message ?? events.error?.message}. Showing the last loaded record.
				</p>
			)}
			<div className="inspection-heading">
				<h2>Execution sequence</h2>
				<button type="button" aria-pressed={selected === "all"} onClick={() => select("all")}>
					All phases
				</button>
			</div>
			<Waterfall run={run} phases={phases} events={events.data} selected={phase?.phase_id ?? null} select={select} />
			{phase ? (
				<div className="inspection-phase">
					<section className="trace-panel">
						<h2>{phase.name}</h2>
						<Facts
							entries={[
								["Description", phase.description],
								["Status", phase.status],
								["Owner", phase.owner],
								["Attempt", phase.attempt],
								["Retries", phase.retries],
								["Error", phase.error],
							]}
						/>
					</section>
					<CostPanel phase={phase} />
				</div>
			) : null}
			<section className="trace-panel">
				<h2>Recorded activity</h2>
				<div className="trace-histograms">
					{[
						{ title: "Events", data: eventKinds, subject: "event" },
						{ title: "Processes", data: processKinds, subject: "process" },
					].map(({ title, data, subject }) => (
						<div key={title}>
							<h3>{title}</h3>
							{!data.rows.length && <PanelEmpty>{emptyState.emptyStore(subject, "for this run")}</PanelEmpty>}
							<ul className="trace-histogram">
								{data.rows.map((row) => (
									<li key={row.label}>
										<span>{row.label}</span>
										<span className="trace-histogram__track" aria-hidden="true">
											<i style={{ width: `${Math.round(row.share * 100)}%` }} />
										</span>
										<strong>{row.count.toLocaleString("en-US")}</strong>
									</li>
								))}
							</ul>
							{data.omitted && <p className="panel-note">{data.omitted}</p>}
						</div>
					))}
				</div>
			</section>
			<section className="trace-panel">
				<h2>
					{phase ? `${phase.name} · event log` : "Event log"} <small>({phaseEvents.length})</small>
				</h2>
				{/* biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded event log is a keyboard-scrollable region. */}
				<section className="inspection-log" tabIndex={0} aria-label={phase ? `${phase.name} events` : "All run events"}>
					{phaseEvents.map((event) => (
						<EventRow key={event.event_id} event={event} start={run.started_at} />
					))}
				</section>
				{!phaseEvents.length ? <PanelEmpty>{emptyState.emptyStore("event", "for this phase")}</PanelEmpty> : null}
			</section>
			<Gates gates={gates.filter((gate) => !phase || gate.phase_id === phase.phase_id)} />
			<details className="trace-panel">
				<summary>Processes · {processes.length} recorded</summary>
				{processes.map((process) => (
					<article className="trace-event" key={process.id}>
						<h3>
							{process.name} <span className="trace-badge">{process.ended_at ? "ended" : "no end recorded"}</span>
						</h3>
						<Facts
							entries={[
								["Kind", process.kind],
								["PID", process.pid],
								["Host", process.host],
								["Started", formatTime(process.started_at)],
								["Ended", process.ended_at ? formatTime(process.ended_at) : null],
								["Command", process.command],
							]}
						/>
					</article>
				))}
				{!processes.length ? <PanelEmpty>{emptyState.emptyStore("process", "for this run")}</PanelEmpty> : null}
			</details>
			<ReceiptPanel data={receipt} full={full} loadFull={() => setFull(true)} />
		</section>
	);
}
