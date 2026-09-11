import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

const verdictText = {
	unknown: "Trust information is missing or has not been checked.",
	unverified: "The receipt is intact. Its result has no observed validation.",
	grounded: "The receipt is intact and validation was observed.",
	reviewed: "The receipt is intact and an independent review passed.",
	compromised:
		"A recorded integrity, validation, review, context or safety check did not hold. Read the findings before relying on this result.",
};
function EvidenceActions({ client, initialRun = "" }: { client: Client; initialRun?: string }) {
	const selection = useWorkspaceSelection(client);
	const [runId, setRunId] = useState(initialRun);
	const [operationId, setOperationId] = useState<string | null>(null);
	const operation = useOperation(client, operationId);
	const action = useMutation({
		mutationFn: (kind: "build" | "verify") =>
			client.call(kind === "build" ? routes.evidenceBuild : routes.receiptVerify, {
				...emptyInput,
				params: { id: selection.id, runId: runId.trim() },
			}),
		onSuccess: (value) => setOperationId(value.operationId),
	});
	const busy =
		action.isPending ||
		(!!operationId && operation.isPending) ||
		operation.data?.status === "queued" ||
		operation.data?.status === "running";
	return (
		<details className="trace-panel">
			<summary>Collect evidence or recheck a receipt</summary>
			<p>
				Choose a workspace and a dispatch run. Collecting evidence saves a report of the records Clio can find. Rechecking
				reads the original receipt again to detect changes since the report was created.
			</p>
			<WorkspacePicker selection={selection} />
			<label>
				Dispatch run ID
				<input
					value={runId}
					onChange={(event) => setRunId(event.target.value)}
					maxLength={128}
					placeholder="Run ID from Fleet"
				/>
			</label>
			<div className="actions">
				<button type="button" disabled={busy || !selection.id || !runId.trim()} onClick={() => action.mutate("build")}>
					Collect evidence
				</button>
				<button type="button" disabled={busy || !selection.id || !runId.trim()} onClick={() => action.mutate("verify")}>
					Recheck receipt
				</button>
			</div>
			{action.error && <p role="alert">{action.error.message}</p>}
			{operation.error && <p role="alert">{operation.error.message}</p>}
			{operation.data && (
				<div role="status">
					<p>Request {operation.data.status}</p>
					{operation.data.status === "succeeded" && (
						<>
							<p>{operation.data.result.message}</p>
							{"kind" in operation.data.result && operation.data.result.kind === "evidence" && (
								<Link to={`/evidence/${operation.data.result.id}`}>Read collected evidence</Link>
							)}
							{"kind" in operation.data.result && operation.data.result.kind === "receipt-verification" && (
								<>
									<p>
										Integrity result: <strong>{operation.data.result.verification.state}</strong> ·{" "}
										{operation.data.result.verification.verifiedAt}
									</p>
									{operation.data.result.verification.reason && <p>Reason: {operation.data.result.verification.reason}</p>}
									<p>An intact receipt authenticates the record; it does not establish that the work is correct.</p>
									<dl className="settings-list">
										{Object.entries(operation.data.result.verification.axes).map(([name, value]) => (
											<div key={name}>
												<dt>{name}</dt>
												<dd>{value}</dd>
												<dd />
											</div>
										))}
									</dl>
								</>
							)}
						</>
					)}
					{operation.data.status === "failed" && <p role="alert">{operation.data.problem.detail}</p>}
				</div>
			)}
		</details>
	);
}
export function EvidencePage({ client }: { client: Client }) {
	const inventory = useInfiniteQuery({
		queryKey: ["evidence"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.evidenceList, {
				...emptyInput,
				query: { limit: 40, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
	return (
		<section>
			<p className="eyebrow">Results / Recorded evidence</p>
			<h1>Evidence</h1>
			<p>
				See what supports a result, what was checked, and what remains uncertain. Reports reflect the records available when
				they were collected.
			</p>
			<EvidenceActions client={client} />
			<div className="actions">
				<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
					Refresh evidence
				</button>
			</div>
			{inventory.isPending && <p>Reading evidence…</p>}
			{inventory.error && <p role="alert">{inventory.error.message}</p>}
			{inventory.data?.pages[0]?.items.length === 0 && (
				<p>No evidence reports yet. Collect evidence from a completed dispatch run to get started.</p>
			)}
			<div className="config-entries">
				{inventory.data?.pages
					.flatMap((page) => page.items)
					.map(({ overview, verdict }) => (
						<article key={overview.evidenceId} className="trace-panel">
							<h2>
								<Link to={`/evidence/${overview.evidenceId}`}>{overview.evidenceId}</Link>
							</h2>
							<p>
								<strong>{verdict}</strong> · {overview.generatedAt}
							</p>
							<p>{verdictText[verdict]}</p>
							<p>{overview.tasks.join(" · ")}</p>
							<p>
								{overview.totals.runs} runs · {overview.totals.receipts} receipts
							</p>
						</article>
					))}
			</div>
			{inventory.hasNextPage && (
				<button type="button" disabled={inventory.isFetchingNextPage} onClick={() => void inventory.fetchNextPage()}>
					Load more evidence
				</button>
			)}
		</section>
	);
}
export function EvidenceDetail({ client }: { client: Client }) {
	const { id = "" } = useParams();
	const detail = useQuery({
		queryKey: ["evidence-detail", id],
		queryFn: () => client.call(routes.evidenceDetail, { ...emptyInput, params: { id } }),
	});
	const data = detail.data;
	return (
		<section>
			<Link to="/evidence">All evidence</Link>
			<h1>Evidence · {id}</h1>
			{detail.isPending && <p>Reading report…</p>}
			{detail.error && <p role="alert">{detail.error.message}</p>}
			{data && (
				<>
					<p>
						<strong>{data.verdict}</strong> · Collected {data.overview.generatedAt}
					</p>
					<p>{verdictText[data.verdict]}</p>
					{data.projection === "historical_format" && (
						<p>
							This historical report has no canonical trust record. Recheck its original receipt to learn its current
							integrity.
						</p>
					)}
					<EvidenceActions key={id} client={client} initialRun={data.overview.runIds[0] ?? ""} />
					<h2>What was found</h2>
					{!data.findings.length && <p>No findings were recorded.</p>}
					{data.findings.map((finding) => (
						<article className="trace-panel" key={finding.id}>
							<h3>
								{finding.tag} · {finding.severity}
							</h3>
							<p>{finding.message}</p>
							{finding.runId && <Link to={`/fleet/dispatches/${finding.runId}`}>{finding.runId}</Link>}
						</article>
					))}
					<h2>Trust by run</h2>
					{data.runs.map((run) => (
						<article className="trace-panel" key={run.runId}>
							<h3>
								<Link to={`/fleet/dispatches/${run.runId}`}>{run.runId}</Link> · {run.summary.verdict}
							</h3>
							<p>{run.summary.text}</p>
							<details>
								<summary>Authorities and artifact references</summary>
								<pre className="fleet-receipt">{JSON.stringify(run.status, null, 2)}</pre>
							</details>
						</article>
					))}
					<h2>Provenance</h2>
					{!data.provenance.some((run) => run.lines.length) && (
						<p>No provenance claims admitted by the recorded trust status.</p>
					)}
					{data.provenance
						.filter((run) => run.lines.length)
						.map((run) => (
							<article key={run.runId} className="trace-panel">
								<h3>{run.runId}</h3>
								<ul>
									{run.lines.map((line) => (
										<li key={line}>{line}</li>
									))}
								</ul>
							</article>
						))}
					<h2>Authenticated gate decisions</h2>
					{!data.gateDecisions.length && <p>No authenticated gate decisions linked to this report.</p>}
					{data.gateDecisions.map((gate, index) => (
						<details key={String(gate.id ?? index)} className="trace-panel">
							<summary>Decision {String(gate.id ?? index + 1)}</summary>
							<pre className="fleet-receipt">{JSON.stringify(gate, null, 2)}</pre>
						</details>
					))}
					<details className="trace-panel">
						<summary>Full report overview</summary>
						<pre className="fleet-receipt">{JSON.stringify(data.overview, null, 2)}</pre>
					</details>
				</>
			)}
		</section>
	);
}
