import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { InspectionError } from "../design/run-inspection.js";
import "./run-inspection.css";
import { Facts } from "../design/facts.js";
import { Icon } from "../design/icons.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { Explained } from "../telemetry/Explained.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { UsageInsights } from "./usage-insights.js";
import { usageCacheEvidence } from "./usage-insights-model.js";
import { filterUsageFacts, usageLabel, usageView } from "./usage-model.js";
import "./usage.css";

export function UsagePage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const [factQuery, setFactQuery] = useState("");
	const query = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["usage", selection.id],
		enabled: !!selection.id,
		queryFn: () => client.call(routes.usage, { ...emptyInput, params: { id: selection.id } }),
	});
	const view = query.data ? usageView(query.data) : null;
	const facts = query.data ? filterUsageFacts(query.data.facts, factQuery) : [];
	const cache = query.data ? usageCacheEvidence(query.data) : null;
	return (
		<section className="usage-page">
			<PanelHeading
				panel={PANELS.usage}
				title="Usage insights"
				level={1}
				action={
					<span className="usage-window">
						<Icon name="clock" /> Retained local records
					</span>
				}
			/>
			<div className="usage-scope">
				<WorkspacePicker selection={selection} />
				{view && <span>{view.window}</span>}
				<button
					type="button"
					disabled={!selection.id || query.isFetching}
					onClick={() => {
						void query.refetch();
					}}
				>
					{query.isFetching ? "Refreshing usage…" : "Refresh usage"}
				</button>
			</div>
			<p className="usage-introduction">A research ledger for your models, calls, and computational spend.</p>
			{!selection.id && <PanelEmpty>{emptyState.unread("usage ledger for this workspace")}</PanelEmpty>}
			{selection.id && query.isPending && <p role="status">Reading usage records…</p>}
			{query.error && (
				<InspectionError
					title="Usage report unavailable"
					error={query.error}
					busy={query.isFetching}
					retry={() => {
						void query.refetch();
					}}
				/>
			)}
			{view && query.data && (
				<>
					<section className="usage-totals" aria-label="Window totals">
						{view.headline.map((figure, index) => (
							<article key={figure.label}>
								<p className="usage-total-label">
									<Icon name={index === 0 ? "layers" : index === 1 ? "usage" : index === 2 ? "sessions" : "fleet"} />
									{figure.label === "Tokens" ? "Recorded tokens" : figure.label === "Cost" ? "Known cost · USD" : figure.label}
								</p>
								<p className="usage-total-value">
									<Explained client={client} {...figure} />
								</p>
								{figure.note && <small>{figure.note}</small>}
							</article>
						))}
					</section>
					{view.missingStores.map((sentence) => (
						<p className="usage-coverage-note" key={sentence}>
							<Icon name="unverified" />
							{sentence}
						</p>
					))}
					{view.knownSubtotals && (
						<p className="usage-coverage-note">
							<Icon name="unverified" />
							{view.knownSubtotals}
						</p>
					)}
					<UsageInsights key={selection.id} client={client} report={query.data} />
					<div className="usage-secondary">
						<section aria-labelledby="usage-token-fields">
							<p className="usage-kicker">03 / Token accounting</p>
							<h2 id="usage-token-fields">Inside the token record</h2>
							<ul className="usage-bars">
								{view.bars.map((bar) => (
									<li key={bar.label}>
										<span className="usage-bar__label">{bar.label}</span>
										<span className="usage-bar__track" aria-hidden="true">
											<i style={{ width: `${bar.share * 100}%` }} />
										</span>
										<span className="usage-bar__value">
											<Explained client={client} label={`${bar.label} tokens`} value={bar.value} ref={bar.ref} />
										</span>
									</li>
								))}
							</ul>
							<p className="usage-chart-footnote">{view.barsCaveat}</p>
						</section>
						<section aria-labelledby="usage-call-origins">
							<p className="usage-kicker">04 / Call origins</p>
							<h2 id="usage-call-origins">What asked for the work</h2>
							{!!view.origins.length && (
								<dl className="usage-origins">
									{view.origins.map((origin) => (
										<div key={origin.label}>
											<dt>{origin.label}</dt>
											<dd>
												<Explained client={client} label={`${origin.label} calls`} value={origin.value} ref={origin.ref} />
											</dd>
										</div>
									))}
								</dl>
							)}
							<p className="usage-chart-footnote">{view.originsNote}</p>
						</section>
					</div>
					{cache && (
						<section className="usage-cache-evidence" aria-labelledby="usage-cache-title">
							<p className="usage-kicker">05 / Prompt cache</p>
							<h2 id="usage-cache-title">Observed prefill work</h2>
							<p className="usage-chart-footnote">
								Model prompt-cache evidence from retained session records. Uncached prefill is backend work; reprocessed prefix
								is an estimate of earlier prompt tokens evaluated again on measured cache breaks. These observations do not add
								to token totals or establish a hit rate, saved cost, or tool-call cache reuse.
							</p>
							{cache.rows.length ? (
								// biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll the evidence table horizontally.
								<section className="usage-cache-scroll" aria-label="Session prompt-cache observations" tabIndex={0}>
									<table className="usage-cache-table">
										<thead>
											<tr>
												<th scope="col">Session</th>
												<th scope="col">Uncached prefill tokens</th>
												<th scope="col">Reprocessed prefix tokens · estimated</th>
												<th scope="col">Measured cache breaks</th>
												<th scope="col">Recorded verdicts</th>
											</tr>
										</thead>
										<tbody>
											{cache.rows.map((row) => (
												<tr key={row.key}>
													<th scope="row">{row.session}</th>
													<td>{row.uncached}</td>
													<td>{row.reprocessed}</td>
													<td>{row.breaks}</td>
													<td>{row.verdicts}</td>
												</tr>
											))}
										</tbody>
									</table>
								</section>
							) : (
								<PanelEmpty>No session prompt-cache observations were recorded in this window.</PanelEmpty>
							)}
							<p className="usage-chart-footnote">
								{cache.rows.length} of {cache.total} session observations shown.
								{cache.omitted > 0 ? ` ${cache.omitted} further observations remain in recorded facts below.` : ""} Not recorded
								means missing evidence; a recorded zero remains zero. Counts cover recorded verdicts only.
							</p>
						</section>
					)}
					<details className="usage-records">
						<summary>
							<Icon name="evidence" />
							<span>
								Recorded facts & provenance
								<small>{query.data.facts.length} facts · skills, models, cache, evidence, and memory</small>
							</span>
							<Icon name="chevronDown" />
						</summary>
						<p className="usage-chart-footnote">
							Session and dispatch records are filtered to this workspace. Audit, evidence, and memory also include shared
							installation records. Model rows are the server's one fold of sessions and their workers' runs per model; no
							total is added again here.
						</p>
						<div className="usage-explore-controls">
							<label>
								Search recorded facts
								<input
									type="search"
									value={factQuery}
									onChange={(event) => setFactQuery(event.target.value)}
									maxLength={256}
									placeholder="Fact name, model, session or recorded value"
								/>
							</label>
							{factQuery && (
								<button type="button" onClick={() => setFactQuery("")}>
									Reset fact search
								</button>
							)}
						</div>
						<p className="usage-chart-footnote" role="status">
							{facts.length} of {query.data.facts.length} recorded facts shown.
						</p>
						{!facts.length && (
							<PanelEmpty>
								{factQuery ? "No recorded fact matches this search." : "No source facts were retained for this window."}
							</PanelEmpty>
						)}
						<div className="usage-fact-list">
							{facts.map((fact) => (
								<details key={JSON.stringify(fact)}>
									<summary>
										{usageLabel(fact.name)}
										<small>
											{String(
												fact.values.attributedModelId ?? fact.values.modelId ?? fact.values.skill ?? fact.values.sessionId ?? "",
											)}
										</small>
									</summary>
									<Facts value={fact.values} />
									<details className="usage-raw">
										<summary>Raw recorded fact</summary>
										<pre>{JSON.stringify(fact, null, 2)}</pre>
									</details>
								</details>
							))}
						</div>
					</details>
					<details className="usage-records">
						<summary>
							<Icon name="skills" />
							<span>
								Suggestions from Clio<small>{query.data.opportunities.length} recorded suggestions in this window</small>
							</span>
							<Icon name="chevronDown" />
						</summary>
						{!query.data.opportunities.length && <PanelEmpty>Clio recorded no suggestion for this window.</PanelEmpty>}
						{query.data.opportunities.map((row) => (
							<article className="usage-source-fact" key={`${row.kind}:${row.evidence}`}>
								<h3>{usageLabel(row.kind)}</h3>
								<p>{row.suggestion}</p>
								<p className="usage-chart-footnote">{row.evidence}</p>
							</article>
						))}
					</details>
					<Boundary panel={PANELS.usage} />
				</>
			)}
		</section>
	);
}
