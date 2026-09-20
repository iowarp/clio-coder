import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { Static } from "typebox";
import type { EvalReport } from "../../contracts/reports.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { Facts } from "../design/facts.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";
import { usageView } from "./usage-model.js";
import "./usage.css";

function ReportSummary({ report }: { report: Static<typeof EvalReport> }) {
	const tokens = report.summary.tokens;
	return (
		<>
			<p>
				{report.summary.passed} of {report.summary.runs} trials passed · {report.summary.failed} failed
			</p>
			<p>
				{report.matrix.target} · {report.matrix.model ?? "Model unreported"} ·{" "}
				{(report.summary.wallTimeMs / 1000).toLocaleString()} seconds
			</p>
			<p>
				{tokens.measured
					? `${tokens.total.toLocaleString()} tokens reported for ${tokens.measuredRuns} of ${tokens.runs} trials`
					: "Token usage was not measured."}
			</p>
			<p>
				Started {report.startedAt ?? "at an unrecorded time"} · Clio {report.clioCoder.version}
			</p>
		</>
	);
}
export function EvalsPage({ client }: { client: Client }) {
	const reports = useInfiniteQuery({
		queryKey: ["evals"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.evals, { ...emptyInput, query: { limit: 40, ...(pageParam ? { cursor: pageParam } : {}) } }),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
	return (
		<section>
			<PanelHeading panel={PANELS.evalReports} level={1} />
			<p>Review saved evaluation trials and their measured results.</p>
			<Link to="/usage">View usage across sessions</Link>
			{reports.isPending && <p>Reading evaluations…</p>}
			{reports.error && <p role="alert">{reports.error.message}</p>}
			{reports.data && (
				<>
					{reports.data.pages[0]?.available === false && <PanelEmpty>{emptyState.missingStore("evaluation")}</PanelEmpty>}
					{reports.data.pages[0]?.available === true && reports.data.pages[0]?.stored === 0 && (
						<PanelEmpty>{emptyState.emptyStore("evaluation report")}</PanelEmpty>
					)}
					{!!reports.data.pages[0]?.unreadable && (
						<PanelEmpty>
							{reports.data.pages[0].unreadable} stored files could not be read in the current evaluation format, so they are
							absent from this list rather than counted as failures.
						</PanelEmpty>
					)}
					<div className="config-entries">
						{reports.data.pages
							.flatMap((page) => page.items)
							.map((report) => (
								<article className="trace-panel" key={report.evalId}>
									<h2>
										<Link to={`/evals/${report.evalId}`}>{report.suiteId}</Link>
									</h2>
									<p className="config-path">{report.evalId}</p>
									<ReportSummary report={report} />
								</article>
							))}
					</div>
				</>
			)}
			{reports.hasNextPage && (
				<>
					<PanelEmpty>{emptyState.bounded("evaluation reports")}</PanelEmpty>
					<button type="button" disabled={reports.isFetchingNextPage} onClick={() => void reports.fetchNextPage()}>
						Load more evaluations
					</button>
				</>
			)}
			<Boundary panel={PANELS.evalReports} />
		</section>
	);
}
export function EvalDetail({ client }: { client: Client }) {
	const { id = "" } = useParams();
	const query = useQuery({
		queryKey: ["eval", id],
		queryFn: () => client.call(routes.evalDetail, { ...emptyInput, params: { id } }),
	});
	return (
		<section>
			<Link to="/evals">All evaluations</Link>
			<PanelHeading panel={PANELS.evalReport} level={1} />
			{query.isPending && <p>Reading report…</p>}
			{query.error && <p role="alert">{query.error.message}</p>}
			{query.data && (
				<>
					<h2>{query.data.report.suiteId}</h2>
					<ReportSummary report={query.data.report} />
					<PanelHeading panel={PANELS.evalTrials} action={<span className="count">{query.data.results.length}</span>} />
					{!query.data.results.length && <PanelEmpty>{emptyState.emptyStore("trial", "in this report")}</PanelEmpty>}
					{query.data.results.map((result) => (
						<article className="trace-panel" key={`${result.taskId}:${result.target.id}:${result.repeatIndex}`}>
							<h3>
								{result.taskId} · {result.pass ? "Passed" : "Failed"}
							</h3>
							<p>
								Trial {result.repeatIndex + 1} · {result.target.id}
							</p>
							{result.failureClass && <p>{result.failureClass}</p>}
							<details>
								<summary>Measurements and recorded verdicts</summary>
								<Facts value={result} order={["pass", "failureClass", "target", "repeatIndex"]} hide={["taskId"]} />
							</details>
						</article>
					))}
					<details className="trace-panel">
						<summary>Report context and scenario totals</summary>
						<Facts
							value={{ report: query.data.report, aggregates: query.data.aggregates }}
							empty={emptyState.emptyStore("scenario total", "in this report")}
						/>
					</details>
					<Boundary panel={PANELS.evalTrials} />
				</>
			)}
		</section>
	);
}
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
			<Link to="/evals">View evaluation reports</Link>
			{!selection.id && <PanelEmpty>{emptyState.unread("usage ledger for this workspace")}</PanelEmpty>}
			{selection.id && query.isPending && <p>Reading usage records…</p>}
			{query.error && <p role="alert">{query.error.message}</p>}
			{view && (
				<>
					<div className="config-entries">
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
					{view.models.map((model) => (
						<article className="trace-panel" key={JSON.stringify(model.values)}>
							<Facts value={model.values} order={["attributedModelId", "providerId", "totalTokens", "costUsd"]} />
						</article>
					))}
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
					{view.rest.map((fact) => (
						<article className="trace-panel" key={JSON.stringify(fact)}>
							<h3>{fact.label}</h3>
							{fact.single ? (
								<p className="panel-figure">{fact.single}</p>
							) : (
								<Facts value={fact.values} empty={emptyState.emptyStore(fact.label.toLowerCase(), "in this window")} />
							)}
						</article>
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
