import { Fragment } from "react";
import { Link } from "react-router";
import type { Static } from "typebox";
import type { TraceReceipt, TraceRun } from "../../../contracts/traces.js";
import type { RunTimelineEntry } from "../../../contracts/wire.js";
import type { Client } from "../../api/client.js";
import { clock, formatDuration } from "../../api/clock.js";
import { tokensText } from "../../chat/session-usage-model.js";
import { Facts as RecordFacts } from "../../design/facts.js";
import { humanizeKey } from "../../design/facts-model.js";
import { StatusMark } from "../../design/status.js";
import { Explained } from "../../telemetry/Explained.js";
import { ReceiptChecks } from "./receipt-checks.js";
import { callPosition, entryLabel, provenanceFacts, runSpan, stageBars } from "./trace-model.js";
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
type CallEntry = Extract<RunTimelineEntry, { kind: "call" }>;
/**
 * Each call attempt as a lane on the run's span, its recorded stages as segments of its bar. Bars use recorded
 * times and offsets and imply no causality; every label is the server's display (#434).
 */
export function CallWaterfall({
	client,
	run,
	entries,
}: {
	client: Client;
	run: TraceRun;
	entries: readonly RunTimelineEntry[];
}) {
	const calls = entries.filter((entry): entry is CallEntry => entry.kind === "call");
	const now = clock.now();
	const span = runSpan(run, now);
	return (
		<section className="trace-panel">
			<div className="page-heading">
				<h2>Model calls</h2>
				<small>{span ? formatDuration(span.end - span.start) : "Run timing not recorded"}</small>
			</div>
			<p className="panel-note">
				One lane per call attempt, placed on the run's span. Segments are the stages the journal recorded: admission, auth,
				transform, connect, send, then the model from its first token to settle.
			</p>
			<div className="trace-waterfall">
				{calls.map((call) => {
					const position = span ? callPosition(call, span, now) : null;
					const label = entryLabel(call);
					return (
						<div className="trace-lane" key={call.attemptId}>
							<div className="trace-lane__label">
								<StatusMark tone={label.tone} label={label.title} />
								<small>
									<CallSpend client={client} call={call} /> · first token {call.timing.ttft.display} · model{" "}
									{call.timing.modelTime.display}
								</small>
							</div>
							<div className="trace-track">
								{position ? (
									<span
										className={`trace-bar${label.tone === "fail" ? " fail" : ""}`}
										title={label.title}
										style={{ left: `${position.left}%`, width: `${Math.max(0.5, position.width)}%` }}
									>
										{stageBars(call).map((bar) => (
											<i
												key={bar.stage}
												className="trace-stage"
												data-stage={bar.stage}
												title={bar.stage}
												style={{ left: `${bar.left}%`, width: `${Math.max(0.5, bar.width)}%` }}
											/>
										))}
									</span>
								) : (
									<span className="trace-timing-missing">No recorded timing</span>
								)}
							</div>
						</div>
					);
				})}
			</div>
			{calls.length === 0 ? <p>No model call was journaled for this run.</p> : null}
		</section>
	);
}
/** A call's tokens and cost, each opening its explanation. */
function CallSpend({ client, call }: { client: Client; call: CallEntry }) {
	return (
		<>
			<Explained client={client} label="Call tokens" value={tokensText(call.tokens.display)} ref={call.tokens.ref} /> ·{" "}
			<Explained client={client} label="Call cost" value={call.usd.display} ref={call.usd.ref} />
		</>
	);
}
/** One timeline entry: what it is, when it fell in the run, and the displays it carries. */
export function EntryRow({ client, entry, start }: { client: Client; entry: RunTimelineEntry; start: number | null }) {
	const label = entryLabel(entry);
	const at = Date.parse(entry.at);
	const elapsed = start !== null && Number.isFinite(at) && at >= start ? `+${formatDuration(at - start)}` : null;
	const details =
		entry.kind === "call" ? (
			<>
				<CallSpend client={client} call={entry} /> · settle {entry.timing.settle.display}
			</>
		) : entry.kind === "feed" && entry.duration ? (
			entry.duration.display
		) : null;
	return (
		<article className="trace-event">
			<div className="trace-event-head">
				<StatusMark tone={label.tone} label={label.kind} />
				<strong>{label.title}</strong>
				<small>
					{elapsed ?? "Elapsed time unavailable"}
					{details ? <> · {details}</> : null}
				</small>
			</div>
		</article>
	);
}
/**
 * The receipt as the read model checks it: the seal's integrity, the checks and outcome it vouches for, and the
 * evidence bundle that names the run (#434 §11.3). The saved document itself appears only once it is asked for, and
 * nothing in it is vouched for beyond what the checks say.
 */
export function ReceiptPanel({
	data,
	loadFull,
	full,
	loading = false,
}: {
	data: Static<typeof TraceReceipt>;
	loadFull: () => void;
	full: boolean;
	loading?: boolean;
}) {
	const { evidence } = data;
	const sealed = evidence.sealed;
	const r = data.receipt;
	return (
		<section className="trace-panel">
			<div className="page-heading">
				<h2>Receipt</h2>
				{evidence.receipt !== "missing" && !full ? (
					<button type="button" disabled={loading} onClick={loadFull}>
						{loading ? "Reading receipt…" : "Load full receipt"}
					</button>
				) : null}
			</div>
			<ReceiptChecks evidence={evidence} />
			{sealed ? (
				<>
					<h3>Outcome</h3>
					<Facts
						entries={[
							["outcome", sealed.outcome],
							["outcomeCode", sealed.outcomeCode],
							["exitCode", sealed.exitCode],
							["failureMessage", sealed.failureMessage],
						]}
					/>
				</>
			) : null}
			<h3>Evidence</h3>
			{evidence.evidence ? (
				<Facts entries={Object.entries(evidence.evidence)} />
			) : (
				<p>No evidence bundle names this run.</p>
			)}
			{r ? (
				<>
					<h3>The saved document</h3>
					<p className="trace-receipt__source">
						As written to disk. Only the checks above are vouched for by its seal; <Link to="/evidence">Evidence</Link>{" "}
						collects and rechecks bundles.
					</p>
					<div className="trace-receipt-grid">
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
														<td>
															{typeof stat.totalDurationMs === "number" ? formatDuration(stat.totalDurationMs) : "not recorded"}
														</td>
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
							{Object.keys(object(r.safety)).length ? (
								<Facts entries={Object.entries(object(r.safety))} />
							) : (
								<p>No safety facts were recorded in this receipt.</p>
							)}
						</div>
						<div>
							<details>
								<summary>Execution provenance & runtime facts</summary>
								<Facts entries={provenanceFacts(r)} />
							</details>
						</div>
					</div>
					{r.findingsSummary ? <Facts entries={Object.entries(object(r.findingsSummary))} /> : null}
					<details>
						<summary>Full receipt payload</summary>
						<Json value={r} />
					</details>
				</>
			) : null}
		</section>
	);
}
