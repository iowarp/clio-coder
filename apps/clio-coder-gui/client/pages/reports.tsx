import { useQuery } from "@tanstack/react-query";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { Facts } from "../design/facts.js";
import { Icon } from "../design/icons.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { UsageInsights } from "./usage-insights.js";
import { usageLabel, usageView } from "./usage-model.js";
import "./usage.css";

export function UsagePage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const query = useQuery({
		queryKey: ["usage", selection.id],
		enabled: !!selection.id,
		queryFn: () => client.call(routes.usage, { ...emptyInput, params: { id: selection.id } }),
	});
	const view = query.data ? usageView(query.data) : null;
	return (
		<section className="usage-page">
			<PanelHeading
				panel={PANELS.usage}
				title="Usage insights"
				level={1}
				action={
					<span className="usage-window">
						<Icon name="clock" /> Last 30 days
					</span>
				}
			/>
			<div className="usage-scope">
				<WorkspacePicker selection={selection} />
				{view && <span>{view.window}</span>}
			</div>
			<p className="usage-introduction">A research ledger for your models, calls, and computational spend.</p>
			{!selection.id && <PanelEmpty>{emptyState.unread("usage ledger for this workspace")}</PanelEmpty>}
			{selection.id && query.isPending && <p role="status">Reading usage records…</p>}
			{query.error && <p role="alert">{query.error.message}</p>}
			{view && query.data && (
				<>
					<section className="usage-totals" aria-label="Window totals">
						{view.headline.map((figure, index) => (
							<article key={figure.label}>
								<p className="usage-total-label">
									<Icon name={index === 0 ? "layers" : index === 1 ? "usage" : index === 2 ? "sessions" : "fleet"} />
									{figure.label === "Tokens" ? "Recorded tokens" : figure.label === "Cost" ? "Known cost · USD" : figure.label}
								</p>
								<p className="usage-total-value">{figure.value}</p>
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
					<UsageInsights key={selection.id} report={query.data} />
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
										<span className="usage-bar__value">{bar.value}</span>
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
											<dd>{origin.value}</dd>
										</div>
									))}
								</dl>
							)}
							<p className="usage-chart-footnote">{view.originsNote}</p>
						</section>
					</div>
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
							installation records. Model rows combine disjoint session and worker sources; aggregate totals are never added
							again.
						</p>
						<div className="usage-fact-list">
							{query.data.facts.map((fact) => (
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
