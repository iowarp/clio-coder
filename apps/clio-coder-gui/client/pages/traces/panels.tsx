import { Fragment } from "react";
import { Link } from "react-router";
import type { Static } from "typebox";
import type { TraceEvent, TraceGate, TracePhase, TraceReceipt, TraceRun } from "../../../contracts/traces.js";
import { clock, formatCost, formatDuration, formatTime, formatTokens } from "../../api/clock.js";
import { Facts as RecordFacts } from "../../design/facts.js";
import { humanizeKey } from "../../design/facts-model.js";
import { StatusMark } from "../../design/status.js";
import { ReceiptChecks } from "./receipt-checks.js";
import { phasePosition, provenanceFacts } from "./trace-model.js";
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
	return <RecordFacts value={value} empty="Nothing was recorded for this field." />;
}
/** Keys reach this from the wire as often as from a caller's own words, so both read as words. */
export function Facts({ entries }: { entries: [string, unknown][] }) {
	return (
		<dl className="trace-facts">
			{entries
				.filter(([, value]) => value != null && value !== "")
				.map(([key, value]) => (
					<Fragment key={key}>
						<dt>{humanizeKey(key)}</dt>
						<dd>{typeof value === "object" ? <RecordFacts value={value} /> : String(value)}</dd>
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
		end = run.ended_at ? Date.parse(run.ended_at) : run.status === "running" ? clock.now() : Number.NaN,
		knownDuration = Number.isFinite(end - start) && end >= start,
		duration = knownDuration ? Math.max(1, end - start) : 1;
	return (
		<section className="trace-panel">
			<div className="page-heading">
				<h2>Phase waterfall</h2>
				<small>{knownDuration ? formatDuration(end - start) : "Run timing not recorded"}</small>
			</div>
			<p className="panel-note">
				Select a phase to inspect its events, checks and accounting. Bars use recorded timestamps; they do not imply
				causality.
			</p>
			<div className="trace-waterfall">
				{phases.map((phase) => {
					const position = phasePosition(phase, run, clock.now());
					return (
						<div className="trace-lane" key={phase.phase_id}>
							<button type="button" aria-pressed={selected === phase.phase_id} onClick={() => select(phase.phase_id)}>
								{phase.name}
								<small>
									{phase.status} · {position ? formatDuration(position.duration) : "Timing not recorded"}
								</small>
							</button>
							<div className="trace-track">
								{position ? (
									<button
										className={`trace-bar ${phase.status}`}
										type="button"
										aria-label={`Select phase ${phase.name}`}
										title={`${phase.name}: ${phase.status}`}
										aria-pressed={selected === phase.phase_id}
										style={{ left: `${position.left}%`, width: `${Math.max(0.5, position.width)}%` }}
										onClick={() => select(phase.phase_id)}
									/>
								) : (
									<span className="trace-timing-missing">No recorded timing</span>
								)}
								{events
									.filter(
										(event) =>
											knownDuration &&
											event.phase_id === phase.phase_id &&
											event.type === "tool_call" &&
											Number.isFinite(Date.parse(event.started_at)),
									)
									.map((event) => (
										<i
											key={event.rowid}
											className="trace-tool-span"
											title={`${event.name} · ${event.ended_at ? formatDuration(Date.parse(event.ended_at) - Date.parse(event.started_at)) : "end not recorded"}`}
											style={{
												left: `${Math.max(0, Math.min(99, ((Date.parse(event.started_at) - start) / duration) * 100))}%`,
												width: `${Math.max(0.4, Math.min(100, ((event.ended_at ? Math.max(0, Date.parse(event.ended_at) - Date.parse(event.started_at)) : 0) / duration) * 100))}%`,
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
	// The trace records one dollar figure per phase, its total. Per-kind costs were never written,
	// so the table carries tokens only and the total cost sits beside the context line.
	return (
		<section className="trace-panel">
			<h2>Tokens & spend</h2>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: A table wider than its column scrolls, and a scrolling region must take focus so the keyboard can move it. */}
			<section className="table-scroll" tabIndex={0} aria-label="Tokens table">
				<table className="trace-table">
					<thead>
						<tr>
							<th>Usage</th>
							<th>Tokens</th>
						</tr>
					</thead>
					<tbody>
						{[
							["Input", phase.input_tokens],
							["Output", phase.output_tokens],
							["Cache read", phase.cache_read_tokens],
							["Cache write", phase.cache_write_tokens],
							["Cache write (1h)", phase.cache_write_1h_tokens ?? null],
							["Reasoning", phase.reasoning_tokens],
							["Total", phase.total_tokens],
						].map(([label, tokens]) => (
							<tr key={String(label)}>
								<th>{label}</th>
								<td>{formatTokens(tokens as number | null)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</section>
			<p>Cost: {formatCost(phase.total_cost_usd)}</p>
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
				<StatusMark
					tone={record.ok === false || event.type === "error" ? "fail" : "neutral"}
					label={record.ok === false ? `${event.type} · failed` : event.type}
				/>
				<strong>{event.name}</strong>
				<small>
					+{formatDuration(Date.parse(event.started_at) - Date.parse(start))}
					{event.ended_at
						? ` · ${formatDuration(Date.parse(event.ended_at) - Date.parse(event.started_at))}`
						: " · end not recorded"}
					{event.tokens == null ? "" : ` · ${formatTokens(event.tokens)} tokens`}
				</small>
			</div>
			{record.truncated === true ? <p className="trace-warning">Payload exceeded the trace limit; snippet only.</p> : null}
			{typeof record.message === "string" && (
				<p>
					{record.message.slice(0, 400)}
					{record.message.length > 400 ? "…" : ""}
				</p>
			)}

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
						{gate.gate} <StatusMark tone={gate.passed ? "success" : "fail"} label={gate.passed ? "passed" : "failed"} />
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
				<>
					<p className="trace-receipt__source">
						Read from the saved receipt. This page does not recheck its seal; <Link to="/evidence">Evidence</Link> does.
					</p>
					<ReceiptChecks receipt={r} />
				</>
			)}
			{r ? (
				<div className="trace-receipt-grid">
					<div>
						<h3>Outcome</h3>
						<Facts
							entries={["outcome", "outcomeCode", "outcomeDetail", "exitCode", "failureMessage"].map((key) => [key, r[key]])}
						/>
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
							// biome-ignore lint/a11y/noNoninteractiveTabindex: A table wider than its column scrolls, and a scrolling region must take focus so the keyboard can move it.
							<section className="table-scroll" tabIndex={0} aria-label="Tool statistics table">
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
							</section>
						) : null}
						<Facts entries={Object.entries(object(r.toolActivity))} />
					</div>
					<div>
						<h3>Safety</h3>
						<Facts entries={Object.entries(object(r.safety))} />
					</div>
					<div>
						<h3>Provenance</h3>
						<Facts entries={provenanceFacts(r)} />
					</div>
				</div>
			) : null}
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
