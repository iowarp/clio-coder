import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router";
import type { UsagePerformance } from "../../contracts/reports.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { CostReportV1, Quantity } from "../../contracts/wire.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Explained } from "../telemetry/Explained.js";
import { explainable, quantityParts } from "../telemetry/quantity-model.js";
import { rankedMetricGroups, sparkline } from "./operator-metrics-model.js";
import "./operator-metrics.css";

type Metric = { display: string; ref?: string; fact: Quantity["fact"] };
type SessionMetric = UsagePerformance["sessions"][number];

export function useOperatorMetrics(client: Client, workspace = "") {
	return useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["operator-metrics", workspace],
		queryFn: ({ signal }) =>
			client.call(
				routes.telemetryMetrics,
				{ params: {}, query: workspace ? { workspace } : {}, body: {} },
				undefined,
				signal,
			),
	});
}

function Measure({ client, value, label }: { client: Client; value: Metric | undefined; label: string }) {
	return <Explained client={client} label={label} {...explainable(value, "not recorded")} />;
}

export function MetricSparkline({ values, label }: { values: readonly (number | null)[]; label: string }) {
	const segments = sparkline(values);
	return segments.length ? (
		<svg className="operator-sparkline" viewBox="0 0 160 30" role="img" aria-label={label}>
			<title>{label}. Gaps mean unrecorded timing; each chart scales to its largest measured value.</title>
			{segments.map((segment) => (
				<g key={segment[0]?.x}>
					{segment.length > 1 ? <polyline points={segment.map(({ x, y }) => `${x},${y}`).join(" ")} /> : null}
					{segment.map(({ x, y }) => (
						<circle key={x} cx={x} cy={y} r="1.8" />
					))}
				</g>
			))}
		</svg>
	) : (
		<span className="operator-missing">No measured timing</span>
	);
}

function Share({ value }: { value: Metric | undefined }) {
	const amount = value ? quantityParts(value).exact : null;
	return (
		<span className={`operator-share${amount === null ? " operator-share--unknown" : ""}`}>
			<span aria-hidden="true">
				<i style={{ width: `${amount === null ? 0 : Math.min(100, Math.max(0, amount))}%` }} />
			</span>
			<span>{value?.display ?? "not recorded"}</span>
		</span>
	);
}

function ModelMetrics({ client, cost }: { client: Client; cost: readonly CostReportV1[] }) {
	const [by, setBy] = useState<"model" | "target">("model");
	const [search, setSearch] = useState("");
	const id = useId();
	const rows = rankedMetricGroups(
		cost.find((report) => report.groupBy === by),
		search,
	);
	return (
		<section className="operator-section" aria-labelledby={`${id}-routes`}>
			<header className="operator-heading">
				<h2 id={`${id}-routes`}>Tokens, cost & cache</h2>
				<fieldset className="operator-switch">
					<legend className="sr-only">Group recorded usage</legend>
					<button type="button" aria-pressed={by === "model"} onClick={() => setBy("model")}>
						Per model
					</button>
					<button type="button" aria-pressed={by === "target"} onClick={() => setBy("target")}>
						Per target
					</button>
				</fieldset>
				<input
					type="search"
					aria-label="Find recorded model or target"
					placeholder="Model or target"
					value={search}
					maxLength={256}
					onChange={(event) => setSearch(event.target.value)}
				/>
			</header>
			{rows.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the dense table.
				<section className="operator-scroll" aria-label={`Recorded usage by ${by}`} tabIndex={0}>
					<table className="operator-table">
						<thead>
							<tr>
								<th scope="col">{by === "model" ? "Target / model" : "Target"}</th>
								<th scope="col">Calls</th>
								<th scope="col">Input</th>
								<th scope="col">Output</th>
								<th scope="col">Cache read</th>
								<th scope="col">Cache write</th>
								<th scope="col">Total tokens</th>
								<th scope="col">USD</th>
								<th scope="col">Cache / prompt</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.key}>
									<th scope="row">{row.key}</th>
									<td>
										<Measure client={client} value={row.calls} label={`${row.key} calls`} />
									</td>
									<td>
										<Measure client={client} value={row.tokenFields?.input} label={`${row.key} input tokens`} />
									</td>
									<td>
										<Measure client={client} value={row.tokenFields?.output} label={`${row.key} output tokens`} />
									</td>
									<td>
										<Measure client={client} value={row.tokenFields?.cacheRead} label={`${row.key} cache-read tokens`} />
									</td>
									<td>
										<Measure client={client} value={row.tokenFields?.cacheWrite} label={`${row.key} cache-write tokens`} />
									</td>
									<td>
										<Measure client={client} value={row.tokens} label={`${row.key} total tokens`} />
									</td>
									<td>
										<Measure client={client} value={row.usd} label={`${row.key} known USD`} />
									</td>
									<td>
										<Share value={row.cacheShare} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="panel-empty">
					{search ? "No recorded route matches this search." : "No model or target calls in these records."}
				</p>
			)}
			<p className="operator-note">
				Session + worker calls. Model is reported when recorded, requested otherwise. Cache share = measured cache-read /
				prompt tokens, not saved cost. Token fields overlap; unknown is not zero.
			</p>
		</section>
	);
}

export function SessionMetricFigures({ row }: { row: SessionMetric }) {
	return (
		<dl className="operator-session-figures">
			<div>
				<dt>Tokens</dt>
				<dd>{row.tokens.display}</dd>
			</div>
			<div>
				<dt>USD</dt>
				<dd>{row.usd.display}</dd>
			</div>
			<div>
				<dt>Cache / prompt</dt>
				<dd>{row.cacheShare.display}</dd>
			</div>
			<div>
				<dt>TTFT p50</dt>
				<dd>{row.ttft.p50.display}</dd>
			</div>
			<div>
				<dt>Tools / errors</dt>
				<dd>
					{row.toolCalls.display} / {row.toolErrors.display}
				</dd>
			</div>
			<div>
				<dt>Compactions</dt>
				<dd>{row.compactions.display}</dd>
			</div>
			<div className="operator-session-trend">
				<dt>Last 32 main attempts · TTFT</dt>
				<dd>
					<MetricSparkline values={row.trend} label="Recorded main-attempt TTFT, chronological" />
				</dd>
			</div>
		</dl>
	);
}

function SessionTrends({ client, performance }: { client: Client; performance: UsagePerformance }) {
	const id = useId();
	const rows = performance.sessions;
	return (
		<section className="operator-section" aria-labelledby={`${id}-sessions`}>
			<header className="operator-heading">
				<h2 id={`${id}-sessions`}>Latency over sessions</h2>
				<span>
					{rows.length} / {performance.sessionCount} most recent sessions
				</span>
			</header>
			<div className="operator-trends">
				<div>
					<span>Main TTFT · median per session</span>
					<MetricSparkline
						values={rows.map((row) => quantityParts(row.ttft.p50).exact)}
						label="Main TTFT median per session, chronological"
					/>
				</div>
				<div>
					<span>Main model span · median per session</span>
					<MetricSparkline
						values={rows.map((row) => quantityParts(row.modelTime.p50).exact)}
						label="Main model-span median per session, chronological"
					/>
				</div>
			</div>
			{rows.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the dense table.
				<section className="operator-scroll" aria-label="Recorded session measurements" tabIndex={0}>
					<table className="operator-table">
						<thead>
							<tr>
								<th scope="col">Session · first record</th>
								<th scope="col">Calls</th>
								<th scope="col">Tokens</th>
								<th scope="col">USD</th>
								<th scope="col">Cache / prompt</th>
								<th scope="col">Main TTFT p50 / p95</th>
								<th scope="col">Measured / missing</th>
								<th scope="col">Model span p50</th>
								<th scope="col">Tools / errors</th>
								<th scope="col">Compactions</th>
							</tr>
						</thead>
						<tbody>
							{[...rows].reverse().map((row) => (
								<tr key={row.sessionId}>
									<th scope="row">
										<Link to={`/sessions/${row.sessionId}`}>{row.sessionId.slice(0, 12)}</Link>
										<small>{row.startedAt ? formatTime(row.startedAt) : "No record time"}</small>
										{!row.journal.present || row.journal.gapRecords || row.journal.skipped || row.journal.damaged ? (
											<small>Incomplete journal</small>
										) : null}
									</th>
									<td>
										<Measure client={client} value={row.calls} label={`${row.sessionId} calls`} />
									</td>
									<td>
										<Measure client={client} value={row.tokens} label={`${row.sessionId} tokens`} />
									</td>
									<td>
										<Measure client={client} value={row.usd} label={`${row.sessionId} USD`} />
									</td>
									<td>
										<Share value={row.cacheShare} />
									</td>
									<td>
										{row.ttft.p50.display} / {row.ttft.p95.display}
									</td>
									<td>
										{row.ttft.measured.display} / {row.ttft.missing.display}
									</td>
									<td>{row.modelTime.p50.display}</td>
									<td>
										{row.toolCalls.display} / {row.toolErrors.display}
									</td>
									<td>{row.compactions.display}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="panel-empty">No session journals in this scope.</p>
			)}
			<p className="operator-note">
				Chronological measured main-call timings only; p95 uses nearest rank. Unknown attempts leave gaps, not zeroes.
				Session totals include workers; timings exclude them.
			</p>
		</section>
	);
}

function ToolMetrics({ performance }: { performance: UsagePerformance }) {
	const id = useId();
	return (
		<section className="operator-section" aria-labelledby={`${id}-tools`}>
			<header className="operator-heading">
				<h2 id={`${id}-tools`}>Tool reliability</h2>
				<span>Observed settlements · engine clock · approval waits excluded</span>
			</header>
			{performance.tools.length ? (
				// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the dense table.
				<section className="operator-scroll" aria-label="Recorded tool reliability" tabIndex={0}>
					<table className="operator-table operator-table--tools">
						<thead>
							<tr>
								<th scope="col">Tool</th>
								<th scope="col">Calls</th>
								<th scope="col">OK</th>
								<th scope="col">Errors</th>
								<th scope="col">Blocked</th>
								<th scope="col">OK / executed</th>
								<th scope="col">Duration p50</th>
								<th scope="col">p95</th>
								<th scope="col">Timed calls</th>
							</tr>
						</thead>
						<tbody>
							{performance.tools.map((row) => (
								<tr key={row.tool}>
									<th scope="row">{row.tool}</th>
									<td>{row.calls.display}</td>
									<td>{row.ok.display}</td>
									<td>{row.errors.display}</td>
									<td>{row.blocked.display}</td>
									<td>
										<Share value={row.success} />
									</td>
									<td>{row.latency.p50.display}</td>
									<td>{row.latency.p95.display}</td>
									<td>{row.latency.measured.display}</td>
								</tr>
							))}
						</tbody>
					</table>
				</section>
			) : (
				<p className="panel-empty">No tool settlements recorded. No reliability rate is inferred.</p>
			)}
			<p className="operator-note">
				OK / (OK + errors). Blocked calls are separate, not execution failures. Observations cover main and worker journals
				once each.
			</p>
		</section>
	);
}

function CompactionMetrics({ performance }: { performance: UsagePerformance }) {
	const id = useId();
	const outcomes = Object.entries(performance.compactionOutcomes);
	const total = quantityParts(performance.totals.compactions).exact;
	return (
		<section className="operator-section" aria-labelledby={`${id}-compactions`}>
			<header className="operator-heading">
				<h2 id={`${id}-compactions`}>Compactions</h2>
				<span>{performance.totals.compactions.display} observed settlements</span>
			</header>
			<div className="operator-compactions">
				{outcomes.map(([outcome, value]) => (
					<div key={outcome}>
						<span>{outcome}</span>
						<strong>{value.display}</strong>
						<span className="operator-compaction-bar" aria-hidden="true">
							<i style={{ width: `${total ? ((quantityParts(value).exact ?? 0) * 100) / total : 0}%` }} />
						</span>
					</div>
				))}
			</div>
			{performance.compactions.length ? (
				<details className="operator-records">
					<summary>Recent compaction records · {performance.compactions.length}</summary>
					<ol>
						{performance.compactions.map((row) => (
							<li key={row.recordId}>
								<time dateTime={row.at}>{formatTime(row.at)}</time>
								<strong>{row.outcome}</strong>
								{row.sessionId ? (
									<Link to={`/sessions/${row.sessionId}`}>{row.sessionId.slice(0, 12)}</Link>
								) : (
									<span>No session owner</span>
								)}
								{row.checkpointTurnId ? <small>Checkpoint {row.checkpointTurnId}</small> : null}
							</li>
						))}
					</ol>
				</details>
			) : null}
		</section>
	);
}

export function OperatorMetrics({
	client,
	performance,
	cost,
	compact = false,
}: {
	client: Client;
	performance: UsagePerformance;
	cost: readonly CostReportV1[];
	compact?: boolean;
}) {
	const sections = (
		<>
			<ModelMetrics client={client} cost={cost} />
			<SessionTrends client={client} performance={performance} />
			<ToolMetrics performance={performance} />
			<CompactionMetrics performance={performance} />
		</>
	);
	return (
		<div className="operator-metrics">
			<dl className="operator-counters">
				{(
					[
						["Observed tool calls", performance.totals.toolCalls],
						["Tool errors", performance.totals.toolErrors],
						["Blocked calls", performance.totals.toolBlocked],
						["Compactions", performance.totals.compactions],
					] as const
				).map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value.display}</dd>
					</div>
				))}
			</dl>
			{performance.coverage.unavailable || performance.coverage.gaps ? (
				<p className="operator-coverage" role="status">
					Incomplete coverage: {performance.coverage.unavailable} unreadable journals · {performance.coverage.gaps} skipped,
					damaged or gap records. Counters describe observed settlements, not missing activity.
				</p>
			) : null}
			{compact ? (
				<details className="operator-records">
					<summary>Recorded metrics · models, targets, session trends, tools & compactions</summary>
					{sections}
				</details>
			) : (
				sections
			)}
		</div>
	);
}

export function SessionDiagnostics({ client, sessionId }: { client: Client; sessionId: string }) {
	const query = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", sessionId, "metrics"],
		queryFn: ({ signal }) =>
			client.call(routes.telemetrySessionMetrics, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
	});
	return (
		<>
			{query.isPending ? <p role="status">Reading recorded session metrics…</p> : null}
			{query.error ? (
				<p role="alert">
					{query.error.message}{" "}
					<button type="button" disabled={query.isFetching} onClick={() => void query.refetch()}>
						Retry recorded metrics
					</button>
				</p>
			) : null}
			{query.data ? <OperatorMetrics client={client} {...query.data} /> : null}
		</>
	);
}
