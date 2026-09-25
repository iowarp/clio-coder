import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { useOperation } from "../api/queries.js";
import { Facts } from "../design/facts.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { ARTIFACT_MAX_PAGES, ARTIFACT_PAGE_SIZE, admittedPages, retainedLinksLive } from "./artifact-pagination.js";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

const verdictText = {
	unknown: "Trust information is missing or has not been checked.",
	unverified: "The receipt is intact. Its result has no observed validation.",
	grounded: "The receipt is intact and validation was observed.",
	reviewed: "The receipt is intact and an independent review passed.",
	compromised:
		"At least one trust check failed or a validation claim lacked an observed command. The receipt seal may still be intact; read the six checks below.",
};

const trustChecks = [
	{ key: "artifactIntegrity", label: "Receipt integrity", meaning: "Was the saved receipt verified against its seal?" },
	{ key: "validationGrounding", label: "Validation", meaning: "Did an observed command support the claimed check?" },
	{ key: "independentReview", label: "Independent review", meaning: "Did an independent reviewer check this result?" },
	{ key: "contextProvenance", label: "Context", meaning: "Was the worker context recorded and valid?" },
	{ key: "autonomyEnforcement", label: "Safety", meaning: "Did Clio enforce the worker safety boundary?" },
	{ key: "completionEvidence", label: "Completion", meaning: "Is the completed work supported by evidence?" },
] as const;

function TrustGuide({ axes }: { axes?: Record<(typeof trustChecks)[number]["key"], string> }) {
	return (
		<details className="trace-panel">
			<summary>How to read the six trust checks</summary>
			<p>The verdict summarizes these checks; it is not a correctness score.</p>
			<dl className="settings-list">
				{trustChecks.map((check) => (
					<div key={check.key}>
						<dt>{check.label}</dt>
						<dd>{axes ? `${axes[check.key]} · ${check.meaning}` : check.meaning}</dd>
					</div>
				))}
			</dl>
		</details>
	);
}
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
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const live = retainedLinksLive(inventory);
	return (
		<section>
			<PanelHeading panel={PANELS.evidenceInventory} level={1} />
			<p>
				See what supports a result, what was checked, and what remains uncertain. Reports reflect the records available when
				they were collected.
			</p>
			<TrustGuide />
			<EvidenceActions client={client} />
			<div className="actions">
				<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.refetch()}>
					Refresh evidence
				</button>
			</div>
			{inventory.isPending && <p>Reading evidence…</p>}
			{inventory.error && <p role="alert">{inventory.error.message}</p>}
			{inventory.data?.pages[0]?.items.length === 0 && (
				<PanelEmpty>
					{emptyState.emptyStore("evidence bundle")} Collect evidence from a completed dispatch run to start one.
				</PanelEmpty>
			)}
			<div className="config-entries">
				{admittedPages(inventory)
					.flatMap((page) => page.items)
					.map(({ overview, verdict }) => (
						<article key={overview.evidenceId} className="trace-panel">
							<h2>
								{live ? <Link to={`/evidence/${overview.evidenceId}`}>{overview.evidenceId}</Link> : overview.evidenceId}
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
			{inventory.hasNextPage && !inventory.isRefetchError && (
				<>
					<PanelEmpty>{emptyState.bounded("evidence bundles")}</PanelEmpty>
					<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.fetchNextPage()}>
						Load more evidence
					</button>
				</>
			)}
			<Boundary panel={PANELS.evidenceInventory} />
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
			<PanelHeading panel={PANELS.evidenceBundle} level={1} title={`Evidence · ${id}`} />
			{detail.isPending && <p>Reading report…</p>}
			{detail.error && <p role="alert">{detail.error.message}</p>}
			{data && (
				<>
					<p>
						<strong>{data.verdict}</strong> · Collected {data.overview.generatedAt}
					</p>
					<p>{verdictText[data.verdict]}</p>
					<h2>Tool-event attribution</h2>
					<p>Counts describe event rows in this collected bundle. Time-window links can overlap during concurrent runs.</p>
					<div className="actions">
						<span className="count" title="The source record carried an exact run link.">
							Exact links {data.attribution.exact}
						</span>
						<span className="count" title="Clio linked these rows by time window; concurrent runs may overlap.">
							Best effort links {data.attribution.bestEffort}
						</span>
						<span className="count" title="These tool-event rows contain no usable link confidence.">
							Unclassified {data.attribution.unclassified}
						</span>
					</div>
					{data.projection === "historical_format" && (
						<PanelEmpty>
							{emptyState.predatesSchema("bundle", "trust projection", "axes")} Recheck its original receipt to learn its
							current integrity.
						</PanelEmpty>
					)}
					<EvidenceActions key={id} client={client} initialRun={data.overview.runIds[0] ?? ""} />
					<h2>What was found</h2>
					{!data.findings.length && <PanelEmpty>{emptyState.emptyStore("finding", "in this bundle")}</PanelEmpty>}
					{data.findings.map((finding) => (
						<article className="trace-panel" key={finding.id}>
							<h3>
								{finding.tag} · {finding.severity}
							</h3>
							{finding.tag === "best-effort-link" && <span className="count">Best effort attribution</span>}
							<p>{finding.message}</p>
							{finding.runId && <Link to={`/fleet/dispatches/${finding.runId}`}>{finding.runId}</Link>}
						</article>
					))}
					<PanelHeading panel={PANELS.evidenceTrust} action={<span className="count">{data.runs.length}</span>} />
					{!data.runs.length && <PanelEmpty>{emptyState.emptyStore("run", "in this bundle")}</PanelEmpty>}
					{data.runs.map((run) => (
						<article className="trace-panel" key={run.runId}>
							<h3>
								<Link to={`/fleet/dispatches/${run.runId}`}>{run.runId}</Link> · {run.summary.verdict}
							</h3>
							<p>{run.summary.text}</p>
							<TrustGuide axes={run.summary.axes} />
							<details>
								<summary>Authorities and artifact references</summary>
								<Facts
									value={run.status}
									empty="This run recorded no trust status. That is a missing record, not a passing one."
								/>
							</details>
						</article>
					))}
					<Boundary panel={PANELS.evidenceTrust} />
					<h2>Provenance</h2>
					{!data.provenance.some((run) => run.lines.length) && (
						<PanelEmpty>No provenance claim is admitted by the recorded trust status.</PanelEmpty>
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
					<PanelHeading panel={PANELS.evidenceGates} action={<span className="count">{data.gateDecisions.length}</span>} />
					{!data.gateDecisions.length && (
						<PanelEmpty>{emptyState.emptyStore("authenticated gate decision", "against this bundle")}</PanelEmpty>
					)}
					{data.gateDecisions.map((gate, index) => (
						<details key={String(gate.id ?? index)} className="trace-panel">
							<summary>Decision {String(gate.id ?? index + 1)}</summary>
							<Facts value={gate} order={["id", "decision", "verdict", "outcome", "reason", "decidedAt", "runId"]} />
						</details>
					))}
					<Boundary panel={PANELS.evidenceGates} />
					<details className="trace-panel">
						<summary>Full report overview</summary>
						<Facts
							value={data.overview}
							order={[
								"source",
								"generatedAt",
								"statuses",
								"startedAt",
								"endedAt",
								"totals",
								"tasks",
								"agentIds",
								"targetIds",
								"modelIds",
							]}
							hide={["version"]}
						/>
					</details>
					<Boundary panel={PANELS.evidenceBundle} />
				</>
			)}
		</section>
	);
}
