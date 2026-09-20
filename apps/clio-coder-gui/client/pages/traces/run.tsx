import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { routes } from "../../../contracts/routes.js";
import type { TraceEvent } from "../../../contracts/traces.js";
import type { Client } from "../../api/client.js";
import { clock, formatCost, formatDuration, formatTime, formatTokens } from "../../api/clock.js";
import { CostPanel, EventRow, Facts, Gates, Json, parseJson, ReceiptPanel, Waterfall } from "./panels.js";
export function TraceRunPage({ client }: { client: Client }) {
	const { runId = "" } = useParams();
	return <Run key={runId} client={client} runId={runId} />;
}
function Run({ client, runId }: { client: Client; runId: string }) {
	const queries = useQueryClient(),
		[selected, select] = useState<string | null>(null),
		[full, setFull] = useState(false),
		[live, setLive] = useState("Connecting to trace…"),
		[now, setNow] = useState(clock.now());
	const input = { params: { runId }, query: {}, body: {} };
	const detail = useQuery({
		queryKey: ["trace-detail", runId, full],
		queryFn: async () => {
			const [run, phases, gates, processes, envelopes, receipt] = await Promise.all([
				client.call(routes.traceRun, input),
				client.call(routes.tracePhases, input),
				client.call(routes.traceGates, input),
				client.call(routes.traceProcesses, input),
				client.call(routes.traceEnvelopes, input),
				client.call(routes.traceReceipt, { ...input, query: full ? { include: "full" } : {} }),
			]);
			return { run, phases, gates, processes, envelopes, receipt };
		},
		refetchInterval: (query) => (query.state.data?.run.status === "running" ? 5000 : false),
	});
	const events = useQuery({
		queryKey: ["trace-events", runId],
		queryFn: async () => {
			let after = 0;
			const result: TraceEvent[] = [];
			while (true) {
				const page = await client.call(routes.traceEvents, { ...input, query: { after, limit: 500 } });
				result.push(...page.events);
				after = page.cursor;
				if (!page.hasMore) return result;
			}
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
	const ready = !!events.data && !!detail.data;
	useEffect(() => {
		const interval = setInterval(() => setNow(clock.now()), 500);
		return () => clearInterval(interval);
	}, []);
	useEffect(() => {
		if (!ready) return;
		const rows = queries.getQueryData<TraceEvent[]>(["trace-events", runId]) ?? [];
		const source = new EventSource(
			`/api/traces/runs/${encodeURIComponent(runId)}/live?after=${rows.at(-1)?.rowid ?? 0}&token=${encodeURIComponent(client.token)}`,
		);
		source.addEventListener("ready", () => setLive("Live trace"));
		source.addEventListener("trace.event", (event) => {
			const row = JSON.parse(event.data) as TraceEvent;
			queries.setQueryData<TraceEvent[]>(["trace-events", runId], (previous) =>
				[...new Map([...(previous ?? []), row].map((item) => [item.rowid, item])).values()].sort(
					(a, b) => a.rowid - b.rowid,
				),
			);
		});
		source.addEventListener("finished", () => {
			setLive("Trace complete");
			source.close();
			void queries.invalidateQueries({ queryKey: ["trace-detail", runId] });
		});
		source.addEventListener("problem", (event) => {
			setLive(`Trace unavailable: ${String(JSON.parse(event.data).detail)}`);
			source.close();
		});
		source.onerror = () => setLive("Reconnecting to trace…");
		return () => source.close();
	}, [client, queries, ready, runId]);
	if (detail.error || events.error)
		return (
			<div role="alert">
				<h1>Trace unavailable</h1>
				<p>{detail.error?.message ?? events.error?.message}</p>
				<Link to="/traces">Back to traces</Link>
			</div>
		);
	if (!detail.data || !events.data) return <p>Loading run…</p>;
	const { run, phases, gates, processes, envelopes, receipt } = detail.data,
		phase = phases.find((item) => item.phase_id === selected) ?? phases[0],
		phaseEvents = events.data.filter((event) => !phase || event.phase_id === phase.phase_id);
	return (
		<section className="trace-run-detail">
			<Link to="/traces">← Trace history</Link>
			<p className="eyebrow">
				{run.source} / {run.run_id}
			</p>
			<h1>{run.request ?? run.run_id}</h1>
			<div className="trace-event-head">
				<span className={`trace-badge ${run.status}`}>{run.status}</span>
				<span role="status">{live}</span>
			</div>
			<Facts
				entries={[
					["Agent", run.agent],
					["Model", run.model],
					["Target", run.target],
					["Runtime", run.runtime],
					["Node", run.node],
					["Started", formatTime(run.started_at)],
					["Duration", formatDuration((run.ended_at ? Date.parse(run.ended_at) : now) - Date.parse(run.started_at))],
					["Tokens", formatTokens(run.total_tokens)],
					["Spend", formatCost(run.total_cost_usd)],
				]}
			/>
			<Waterfall run={run} phases={phases} events={events.data} selected={phase?.phase_id ?? null} select={select} />
			{phase ? (
				<>
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
				</>
			) : null}
			<section className="trace-panel">
				<h2>
					Event log <small>({phaseEvents.length})</small>
				</h2>
				{phaseEvents.map((event) => (
					<EventRow key={event.rowid} event={event} start={run.started_at} />
				))}
				{!phaseEvents.length ? <p>No events recorded for this phase.</p> : null}
			</section>
			<Gates gates={gates.filter((gate) => !phase || gate.phase_id === phase.phase_id)} />
			<section className="trace-panel">
				<h2>
					Processes <small>({processes.length})</small>
				</h2>
				{processes.map((process) => (
					<article className="trace-event" key={process.id}>
						<h3>
							{process.name} <span className="trace-badge">{process.ended_at ? "ended" : "live"}</span>
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
				{!processes.length ? <p>No processes recorded.</p> : null}
			</section>
			<section className="trace-panel">
				<h2>Envelopes</h2>
				{envelopes.map((envelope) => (
					<details key={envelope.envelope_id}>
						<summary>
							{envelope.agent} · {envelope.output_type} · {envelope.valid ? "valid" : "invalid"}
						</summary>
						<Json value={parseJson(envelope.payload_json)} />
					</details>
				))}
				{!envelopes.length ? <p>No envelopes recorded.</p> : null}
			</section>
			<ReceiptPanel data={receipt} full={full} loadFull={() => setFull(true)} />
		</section>
	);
}
