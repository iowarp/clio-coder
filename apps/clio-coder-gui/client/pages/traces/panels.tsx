import { Fragment } from "react";
import type { Static } from "typebox";
import type { TraceEvent, TraceGate, TracePhase, TraceReceipt, TraceRun } from "../../../contracts/traces.js";
import { clock, formatCost, formatDuration, formatTime, formatTokens } from "../../api/clock.js";
export function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
export function parseJson(value: string | null) {
	try {
		return value ? (JSON.parse(value) as unknown) : null;
	} catch {
		return value;
	}
}
export function Json({ value }: { value: unknown }) {
	return <pre className="trace-json">{JSON.stringify(value, null, 2)}</pre>;
}
export function Facts({ entries }: { entries: [string, unknown][] }) {
	return (
		<dl className="trace-facts">
			{entries
				.filter(([, value]) => value != null && value !== "")
				.map(([key, value]) => (
					<Fragment key={key}>
						<dt>{key}</dt>
						<dd>{typeof value === "object" ? JSON.stringify(value) : String(value)}</dd>
					</Fragment>
				))}
		</dl>
	);
}
export function Waterfall({
	run,
	phases,
	events,
	selected,
	select,
}: {
	run: TraceRun;
	phases: TracePhase[];
	events: TraceEvent[];
	selected: string | null;
	select: (id: string) => void;
}) {
	const start = Date.parse(run.started_at),
		end = run.ended_at ? Date.parse(run.ended_at) : clock.now(),
		duration = Math.max(1, end - start);
	return (
		<section className="trace-panel">
			<div className="page-heading">
				<h2>Phase waterfall</h2>
				<small>{formatDuration(duration)}</small>
			</div>
			<div className="trace-waterfall">
				{phases.map((phase) => {
					const left = Math.max(0, ((Date.parse(phase.started_at ?? run.started_at) - start) / duration) * 100),
						width = Math.min(
							100 - left,
							Math.max(
								0.5,
								(((phase.ended_at ? Date.parse(phase.ended_at) : end) - Date.parse(phase.started_at ?? run.started_at)) /
									duration) *
									100,
							),
						);
					return (
						<div className="trace-lane" key={phase.phase_id}>
							<button type="button" aria-pressed={selected === phase.phase_id} onClick={() => select(phase.phase_id)}>
								{phase.name}
								<small>
									{phase.kind} · {phase.owner}
								</small>
							</button>
							<div className="trace-track">
								<button
									className={`trace-bar ${phase.status}`}
									type="button"
									aria-label={`Select phase ${phase.name}`}
									title={`${phase.name}: ${phase.status}`}
									style={{ left: `${left}%`, width: `${width}%` }}
									onClick={() => select(phase.phase_id)}
								/>
								{events
									.filter((event) => event.phase_id === phase.phase_id && event.type === "tool_call")
									.map((event) => (
										<i
											key={event.rowid}
											className="trace-tool-span"
											title={`${event.name} · ${event.ended_at ? formatDuration(Date.parse(event.ended_at) - Date.parse(event.started_at)) : "live"}`}
											style={{
												left: `${Math.max(0, Math.min(99, ((Date.parse(event.started_at) - start) / duration) * 100))}%`,
												width: `${Math.max(0.4, Math.min(100, (((event.ended_at ? Date.parse(event.ended_at) : end) - Date.parse(event.started_at)) / duration) * 100))}%`,
											}}
										/>
									))}
							</div>
						</div>
					);
				})}
			</div>
			{phases.length === 0 ? <p>No phases recorded.</p> : null}
		</section>
	);
}
export function CostPanel({ phase }: { phase: TracePhase }) {
	return (
		<section className="trace-panel">
			<h2>Tokens & spend</h2>
			<div className="table-scroll">
				<table className="trace-table">
					<thead>
						<tr>
							<th>Usage</th>
							<th>Tokens</th>
							<th>Cost</th>
						</tr>
					</thead>
					<tbody>
						{[
							["Input", phase.input_tokens, phase.input_cost_usd],
							["Output", phase.output_tokens, phase.output_cost_usd],
							["Cache read", phase.cache_read_tokens, phase.cache_read_cost_usd],
							["Cache write", phase.cache_write_tokens, phase.cache_write_cost_usd],
							["Cache write (1h)", phase.cache_write_1h_tokens, null],
							["Reasoning", phase.reasoning_tokens, null],
							["Total", phase.total_tokens, phase.total_cost_usd],
						].map(([label, tokens, cost]) => (
							<tr key={String(label)}>
								<th>{label}</th>
								<td>{formatTokens(tokens as number | null)}</td>
								<td>{formatCost(cost as number | null)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<p>
				Context: {formatTokens(phase.context_tokens)} / {formatTokens(phase.context_window)}
			</p>
		</section>
	);
}
export function EventRow({ event, start }: { event: TraceEvent; start: string }) {
	const payload = parseJson(event.payload_json),
		record = object(payload);
	return (
		<article className="trace-event">
			<div className="trace-event-head">
				<span className={`trace-badge ${record.ok === false || event.type === "error" ? "fail" : ""}`}>{event.type}</span>
				<strong>{event.name}</strong>
				<small>
					+{formatDuration(Date.parse(event.started_at) - Date.parse(start))}
					{event.ended_at ? ` · ${formatDuration(Date.parse(event.ended_at) - Date.parse(event.started_at))}` : " · live"}
					{event.tokens == null ? "" : ` · ${formatTokens(event.tokens)} tokens`}
				</small>
			</div>
			{record.truncated === true ? <p className="trace-warning">Payload exceeded the trace limit; snippet only.</p> : null}
			<Facts
				entries={Object.entries(record).map(([key, value]) => [
					key,
					typeof value === "string" && value.length > 400 ? `${value.slice(0, 400)}… (see payload)` : value,
				])}
			/>
			<details>
				<summary>Event payload</summary>
				<Json value={payload} />
			</details>
		</article>
	);
}
export function Gates({ gates }: { gates: Static<typeof TraceGate>[] }) {
	return (
		<section className="trace-panel">
			<h2>Gate evidence</h2>
			{gates.map((gate) => (
				<article className="trace-event" key={gate.id}>
					<h3>
						{gate.gate}{" "}
						<span className={`trace-badge ${gate.passed ? "success" : "fail"}`}>{gate.passed ? "passed" : "failed"}</span>
					</h3>
					<p>
						Attempt {gate.attempt} · {formatTime(gate.created_at)}
					</p>
					<h4>Checks</h4>
					<Json value={parseJson(gate.checks_json)} />
					<h4>Violations</h4>
					<Json value={parseJson(gate.violations_json)} />
				</article>
			))}
			{!gates.length ? <p>No gates recorded.</p> : null}
		</section>
	);
}
export function ReceiptPanel({
	data,
	loadFull,
	full,
}: {
	data: Static<typeof TraceReceipt>;
	loadFull: () => void;
	full: boolean;
}) {
	const r = data.receipt;
	return (
		<section className="trace-panel">
			<div className="page-heading">
				<h2>Receipt</h2>
				{r && !full ? (
					<button type="button" onClick={loadFull}>
						Load full receipt
					</button>
				) : null}
			</div>
			{!r ? (
				<p>No sealed receipt was found for this run.</p>
			) : (
				<div className="trace-receipt-grid">
					<div>
						<h3>Outcome</h3>
						<Facts
							entries={["outcome", "outcomeCode", "outcomeDetail", "exitCode", "failureMessage"].map((key) => [key, r[key]])}
						/>
					</div>
					<div>
						<h3>Verification</h3>
						<Facts entries={Object.entries(object(r.verification))} />
					</div>
					<div>
						<h3>Spend</h3>
						<Facts
							entries={[
								["cost", formatCost(typeof r.costUsd === "number" ? r.costUsd : null)],
								...[
									"costProvenance",
									"tokenCount",
									"inputTokenCount",
									"outputTokenCount",
									"cacheReadTokenCount",
									"cacheWriteTokenCount",
									"reasoningTokenCount",
								].map((key) => [key, r[key]] as [string, unknown]),
							]}
						/>
					</div>
					<div>
						<h3>Tools</h3>
						{Array.isArray(r.toolStats) ? (
							<div className="table-scroll">
								<table className="trace-table">
									<thead>
										<tr>
											{["Tool", "Calls", "OK", "Errors", "Blocked", "Time"].map((label) => (
												<th key={label}>{label}</th>
											))}
										</tr>
									</thead>
									<tbody>
										{r.toolStats.map((value, index) => {
											const stat = object(value);
											return (
												<tr key={String(stat.tool ?? index)}>
													{["tool", "count", "ok", "errors", "blocked"].map((key) => (
														<td key={key}>{String(stat[key] ?? "not recorded")}</td>
													))}
													<td>{typeof stat.totalDurationMs === "number" ? formatDuration(stat.totalDurationMs) : "not recorded"}</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						) : null}
						<Facts entries={Object.entries(object(r.toolActivity))} />
					</div>
					<div>
						<h3>Safety</h3>
						<Facts entries={Object.entries(object(r.safety))} />
					</div>
					<div>
						<h3>Provenance</h3>
						<Facts
							entries={[
								"clioVersion",
								"platform",
								"nodeVersion",
								"runtimeKind",
								"skillActivations",
								"integrity",
								"lineage",
								"node",
								"gate",
								"plan",
								"pipeline",
								"reroutes",
							].map((key) => [key, r[key]])}
						/>
					</div>
				</div>
			)}
			<h3>Findings</h3>
			{r?.findingsSummary ? (
				<>
					<p>Receipt findings</p>
					<Facts entries={Object.entries(object(r.findingsSummary))} />
				</>
			) : null}
			{data.evidence ? (
				<>
					<p>Evidence findings</p>
					<Facts entries={Object.entries(data.evidence)} />
				</>
			) : (
				<p>No evidence sidecar recorded.</p>
			)}
			{r &&
			data.evidence &&
			object(r.findingsSummary).firstPassSuccess !== undefined &&
			object(r.findingsSummary).firstPassSuccess !== data.evidence.firstPassSuccess ? (
				<p className="trace-warning">Receipt and evidence disagree on first-pass success; both are shown above.</p>
			) : null}
			{r ? (
				<details>
					<summary>{full ? "Full receipt payload" : "Receipt summary payload"}</summary>
					<Json value={r} />
				</details>
			) : null}
		</section>
	);
}
