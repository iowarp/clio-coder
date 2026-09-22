import { useQuery } from "@tanstack/react-query";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Facts } from "../design/facts.js";
import { omittedSentence } from "../design/facts-model.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { usageView } from "./usage-model.js";
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
		<section>
			<PanelHeading panel={PANELS.usage} level={1} action={view ? <span className="count">{view.window}</span> : null} />
			<WorkspacePicker selection={selection} />
			<p>
				The last 30 days of recorded activity. Sessions and dispatch runs are filtered to your workspace. Audit, evidence
				and memory observations also include the installation’s shared records.
			</p>
			{!selection.id && <PanelEmpty>{emptyState.unread("usage ledger for this workspace")}</PanelEmpty>}
			{selection.id && query.isPending && <p>Reading usage records…</p>}
			{query.error && <p role="alert">{query.error.message}</p>}
			{view && (
				<>
					<div className="panel-figures">
						{view.headline.map((figure) => (
							<article className="trace-panel" key={figure.label}>
								<h2>{figure.label}</h2>
								<p className="panel-figure">{figure.value}</p>
								{figure.note && <small>{figure.note}</small>}
							</article>
						))}
					</div>
					{view.missingStores.map((sentence) => (
						<PanelEmpty key={sentence}>{sentence}</PanelEmpty>
					))}
					{view.knownSubtotals && <p className="panel-note">{view.knownSubtotals}</p>}
					<h2>Token composition</h2>
					<ul className="usage-bars">
						{view.bars.map((bar) => (
							<li key={bar.label}>
								<span className="usage-bar__label">{bar.label}</span>
								<span className="usage-bar__track" aria-hidden="true">
									<i style={{ width: `${Math.round(bar.share * 100)}%` }} />
								</span>
								<span className="usage-bar__value">{bar.value}</span>
							</li>
						))}
					</ul>
					<p className="panel-note">{view.barsCaveat}</p>
					<h2>Where the calls came from</h2>
					{!!view.origins.length && (
						<dl className="facts">
							{view.origins.map((origin) => (
								<div className="fact" key={origin.label}>
									<dt>{origin.label}</dt>
									<dd>{origin.value}</dd>
								</div>
							))}
						</dl>
					)}
					<p className="panel-note">{view.originsNote}</p>
					<h2>Models · {view.models.length}</h2>
					{!view.models.length && <PanelEmpty>{emptyState.emptyStore("model call", "in this window")}</PanelEmpty>}
					<div className="config-entries">
						{view.models.map((model) => (
							<article className="trace-panel" key={JSON.stringify(model.values)}>
								<Facts value={model.values} order={["attributedModelId", "providerId", "totalTokens", "costUsd"]} />
							</article>
						))}
					</div>
					<h2>Skills</h2>
					{!view.skillsActivated.length && (
						<PanelEmpty>{emptyState.emptyStore("skill activation", "in this window")}</PanelEmpty>
					)}
					{!!view.skillsActivated.length && (
						<dl className="facts">
							{view.skillsActivated.map((skill) => (
								<div className="fact" key={JSON.stringify(skill.values)}>
									<dt>{String(skill.values.skill ?? "Unnamed skill")}</dt>
									<dd>{String(skill.values.activations ?? "Not reported")}</dd>
								</div>
							))}
						</dl>
					)}
					{!!view.skillsDormant.length && (
						<p className="panel-note">Installed and never activated in this window: {view.skillsDormant.join(", ")}.</p>
					)}
					<h2>Other recorded facts</h2>
					{!view.rest.length && !view.tables.length && (
						<PanelEmpty>{emptyState.emptyStore("other fact", "in this window")}</PanelEmpty>
					)}
					<div className="config-entries">
						{view.rest.map((fact) => (
							<article className="trace-panel" key={fact.name}>
								<h3>{fact.label}</h3>
								{fact.single ? (
									<p className="panel-figure">{fact.single}</p>
								) : (
									<Facts value={fact.values} empty={emptyState.emptyStore(fact.label.toLowerCase(), "in this window")} />
								)}
							</article>
						))}
					</div>
					{view.tables.map((table) => (
						<details className="trace-panel usage-table" key={table.name}>
							<summary>
								{table.label} · {table.total.toLocaleString("en-US")}
							</summary>
							{/* biome-ignore lint/a11y/noNoninteractiveTabindex: a keyboard user must be able to scroll a wide table. */}
							<section className="usage-table__scroll" aria-label={`${table.label} rows`} tabIndex={0}>
								<table>
									<thead>
										<tr>
											{table.columns.map((column) => (
												<th scope="col" key={column}>
													{column}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{table.rows.map((row, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: report rows carry no identity and are never reordered.
											<tr key={index}>
												{row.map((value, column) => (
													// biome-ignore lint/suspicious/noArrayIndexKey: a cell is addressed by its column.
													<td key={column}>{value}</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</section>
							{table.omitted > 0 && <PanelEmpty>{omittedSentence(table.omitted, "row")}</PanelEmpty>}
							{table.omittedColumns > 0 && <PanelEmpty>{omittedSentence(table.omittedColumns, "column")}</PanelEmpty>}
						</details>
					))}
					<h2>Suggestions from Clio</h2>
					{!query.data?.opportunities.length && <PanelEmpty>Clio recorded no suggestion for this window.</PanelEmpty>}
					{query.data?.opportunities.map((row) => (
						<article className="trace-panel" key={`${row.kind}:${row.evidence}`}>
							<h3>{row.kind.replace(/-/g, " ")}</h3>
							<p>{row.suggestion}</p>
							<p className="panel-note">{row.evidence}</p>
						</article>
					))}
					<Boundary panel={PANELS.usage} />
				</>
			)}
		</section>
	);
}
