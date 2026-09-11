import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { Static } from "typebox";
import type { EvalReport } from "../../contracts/reports.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

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
			<p className="eyebrow">Results / Evaluation history</p>
			<h1>Evals</h1>
			<p>Review saved evaluation trials and their measured results.</p>
			<Link to="/usage">View usage across sessions</Link>
			{reports.isPending && <p>Reading evaluations…</p>}
			{reports.error && <p role="alert">{reports.error.message}</p>}
			{reports.data && (
				<>
					{!!reports.data.pages[0]?.unreadable && (
						<p>{reports.data.pages[0].unreadable} stored files could not be read in the current evaluation format.</p>
					)}
					{reports.data.pages[0]?.stored === 0 && (
						<p>No saved evaluations yet. Reports created by Clio’s evaluation tools will appear here.</p>
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
				<button type="button" disabled={reports.isFetchingNextPage} onClick={() => void reports.fetchNextPage()}>
					Load more evaluations
				</button>
			)}
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
			<h1>Evaluation results</h1>
			{query.isPending && <p>Reading report…</p>}
			{query.error && <p role="alert">{query.error.message}</p>}
			{query.data && (
				<>
					<h2>{query.data.report.suiteId}</h2>
					<ReportSummary report={query.data.report} />
					<h2>Trials</h2>
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
								<pre className="fleet-receipt">{JSON.stringify(result, null, 2)}</pre>
							</details>
						</article>
					))}
					<details className="trace-panel">
						<summary>Report context and scenario totals</summary>
						<pre className="fleet-receipt">
							{JSON.stringify({ report: query.data.report, aggregates: query.data.aggregates }, null, 2)}
						</pre>
					</details>
				</>
			)}
		</section>
	);
}
const label = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/-/g, " ");
const amount = (value: unknown) =>
	value === null || value === undefined
		? "Not reported"
		: typeof value === "number"
			? value.toLocaleString(undefined, { maximumFractionDigits: 6 })
			: typeof value === "string"
				? value
				: JSON.stringify(value);
export function UsagePage({ client }: { client: Client }) {
	const selection = useWorkspaceSelection(client);
	const query = useQuery({
		queryKey: ["usage", selection.id],
		enabled: !!selection.id,
		queryFn: () => client.call(routes.usage, { ...emptyInput, params: { id: selection.id } }),
	});
	const tokens = query.data?.facts.find((row) => row.name === "tokens")?.values;
	return (
		<section>
			<p className="eyebrow">Activity / Resource use</p>
			<h1>Usage</h1>
			<WorkspacePicker selection={selection} />
			<p>
				The last 30 days of recorded activity. Sessions and dispatch runs are filtered to your workspace. Audit, evidence
				and memory observations also include the installation’s shared records.
			</p>
			<Link to="/evals">View evaluation reports</Link>
			{selection.id && query.isPending && <p>Reading usage records…</p>}
			{query.error && <p role="alert">{query.error.message}</p>}
			{query.data && (
				<>
					<p>
						{query.data.from} to {query.data.to}
					</p>
					<div className="config-entries">
						{["apiCalls", "totalTokens", "costUsd"].map((name) => (
							<article className="trace-panel" key={name}>
								<h2>{name === "apiCalls" ? "Model calls" : name === "totalTokens" ? "Tokens" : "Reported cost (USD)"}</h2>
								<p>{amount(tokens?.[name])}</p>
							</article>
						))}
					</div>
					{tokens?.knownSubtotals === true && (
						<p>
							These amounts include known contributions only; some usage was not observed. See the detailed coverage below.
						</p>
					)}
					<h2>Recorded facts</h2>
					<dl className="settings-list">
						{query.data.facts.map((fact) => (
							<div key={JSON.stringify(fact)}>
								<dt>{label(fact.name)}</dt>
								<dd>
									{Object.entries(fact.values).map(([name, value]) => (
										<p key={name}>
											{label(name)}: {amount(value)}
										</p>
									))}
								</dd>
								<dd />
							</div>
						))}
					</dl>
					<h2>Suggestions from Clio</h2>
					{!query.data.opportunities.length && <p>No suggestions in this report.</p>}
					{query.data.opportunities.map((row) => (
						<article className="trace-panel" key={`${row.kind}:${row.evidence}`}>
							<h3>{label(row.kind)}</h3>
							<p>{row.suggestion}</p>
							<p>{row.evidence}</p>
						</article>
					))}
				</>
			)}
		</section>
	);
}
