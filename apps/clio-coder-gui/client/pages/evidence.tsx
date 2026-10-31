import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { RequestRecovery, useOperationRequest } from "../api/operation-request.js";
import { Facts } from "../design/facts.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { InspectionError, InspectionSummary } from "../design/run-inspection.js";
import { StatusMark } from "../design/status.js";
import { Explained } from "../telemetry/Explained.js";
import { explainable } from "../telemetry/quantity-model.js";
import { ARTIFACT_MAX_PAGES, ARTIFACT_PAGE_SIZE, admittedPages, retainedLinksLive } from "./artifact-pagination.js";
import {
	evidenceVerdictTone,
	inspectionSort,
	listDestination,
	matchesText,
	sortInspectionRecords,
} from "./run-inspection-model.js";
import "./run-inspection.css";
import { useWorkspaceSelection, WorkspacePicker } from "./settings.js";

const verdictText = {
	unknown: "Trust information is missing or has not been checked.",
	unverified: "The receipt is intact. Its result has no observed validation.",
	grounded: "The receipt is intact and validation was observed.",
	reviewed: "The receipt is intact and an independent review passed.",
	compromised:
		"At least one trust check failed or a validation claim lacked an observed command. The receipt seal may still be intact; read the five checks below.",
};

const trustChecks = [
	{ key: "artifactIntegrity", label: "Receipt integrity", meaning: "Was the saved receipt verified against its seal?" },
	{ key: "validationGrounding", label: "Validation", meaning: "Did an observed command support the claimed check?" },
	{ key: "independentReview", label: "Independent review", meaning: "Did an independent reviewer check this result?" },
	{ key: "contextProvenance", label: "Context", meaning: "Was the worker context recorded and valid?" },
	{ key: "completionEvidence", label: "Completion", meaning: "Is the completed work supported by evidence?" },
] as const;

function TrustGuide({ axes }: { axes?: Record<(typeof trustChecks)[number]["key"], string> }) {
	return (
		<details className="trace-panel">
			<summary>How to read the five trust checks</summary>
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
function EvidenceActions({
	client,
	initialRun = "",
	initiallyOpen = !!initialRun,
}: {
	client: Client;
	initialRun?: string;
	initiallyOpen?: boolean;
}) {
	const selection = useWorkspaceSelection(client);
	const [runId, setRunId] = useState(initialRun);
	const [choosing, setChoosing] = useState(false);
	const dispatches = useInfiniteQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-dispatches"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.dispatchRuns, {
				...emptyInput,
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
		enabled: choosing,
	});
	const tracking = useOperationRequest(client, "evidence", (request) =>
		client.call(
			routes.receiptVerify,
			{ ...emptyInput, params: { id: request.workspaceId, runId: request.resourceId } },
			request.key,
			undefined,
			request.epoch ?? undefined,
		),
	);
	const { operation, busy } = tracking;
	const submit = () => tracking.start({ workspaceId: selection.id, resourceId: runId.trim(), action: "verify" });
	return (
		<details className="trace-panel evidence-actions" open={initiallyOpen || !!tracking.request}>
			<summary>Recheck a receipt</summary>
			<p>
				Choose a workspace and a dispatch run. Each run's evidence is assessed when it settles and sealed with it.
				Rechecking reads the run's sealed record again to detect changes since it was sealed. The chosen workspace runs the
				command; history can include other workspaces.
			</p>
			<fieldset disabled={busy}>
				<WorkspacePicker selection={selection} />
				<button type="button" onClick={() => setChoosing(!choosing)} aria-expanded={choosing}>
					Choose a recent dispatch
				</button>
				{choosing && (
					<div className="inspection-picker">
						{dispatches.isPending && <p role="status">Reading recent dispatches…</p>}
						{dispatches.error && (
							<InspectionError
								title="Recent dispatches unavailable"
								error={dispatches.error}
								busy={dispatches.isFetching}
								retry={() => {
									void dispatches.refetch();
								}}
							/>
						)}
						<label>
							Recorded dispatch
							<select
								value={admittedPages(dispatches).some((page) => page.items.some((run) => run.id === runId)) ? runId : ""}
								disabled={!retainedLinksLive(dispatches)}
								onChange={(event) => {
									if (event.target.value) setRunId(event.target.value);
								}}
							>
								<option value="">Select a dispatch run</option>
								{admittedPages(dispatches)
									.flatMap((page) => page.items)
									.map((run) => (
										<option value={run.id} key={run.id}>
											{run.agentId} · {run.outcome ?? run.status} · {run.id}
										</option>
									))}
							</select>
						</label>
						{dispatches.data?.pages[0]?.items.length === 0 && (
							<PanelEmpty>
								{dispatches.data.pages[0].present ? "No dispatch runs have been recorded." : "No dispatch ledger is available."}{" "}
								Start work from a conversation.
							</PanelEmpty>
						)}
						{dispatches.hasNextPage && !dispatches.isRefetchError && (
							<button type="button" disabled={dispatches.isFetching} onClick={() => void dispatches.fetchNextPage()}>
								Load older dispatches
							</button>
						)}
						<p className="panel-note">
							The list covers installation history. Confirm the chosen workspace matches the run you intend to inspect.
						</p>
					</div>
				)}
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
					<button type="button" disabled={busy || !selection.id || !runId.trim()} onClick={submit}>
						Recheck receipt
					</button>
				</div>
			</fieldset>
			<RequestRecovery tracking={tracking} />
			{operation.data && !tracking.epochChanged && (
				<div role="status">
					<p>
						<StatusMark
							tone={
								operation.data.status === "failed"
									? "fail"
									: operation.data.status === "succeeded" || operation.data.status === "cancelled"
										? "neutral"
										: "running"
							}
							label={`Request ${operation.data.status}`}
						/>
					</p>
					{operation.data.progress.at(-1) && <p>{operation.data.progress.at(-1)?.message}</p>}
					{operation.data.status === "succeeded" && (
						<>
							<p>{operation.data.result.message}</p>
							{"kind" in operation.data.result && operation.data.result.kind === "receipt-verification" && (
								<>
									<p>
										Integrity result: <strong>{operation.data.result.verification.state}</strong> ·{" "}
										{formatTime(operation.data.result.verification.verifiedAt)}
									</p>
									{operation.data.result.verification.reason && <p>Reason: {operation.data.result.verification.reason}</p>}
									<p>An intact receipt authenticates the record; it does not establish that the work is correct.</p>
									<dl className="settings-list">
										{trustChecks.map((check) => (
											<div key={check.key}>
												<dt>{check.label}</dt>
												<dd>
													{operation.data.status === "succeeded" && "verification" in operation.data.result
														? operation.data.result.verification.axes[check.key]
														: "Not recorded"}
												</dd>
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
	const queryClient = useQueryClient();
	const [search, setSearch] = useSearchParams();
	const q = search.get("q") ?? "";
	const verdict = search.get("verdict") ?? "";
	const sort = inspectionSort(search.get("sort"));
	const initialRun = search.get("run") ?? "";

	const inventory = useInfiniteQuery({
		meta: { errorSurface: "inline" },
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
	const loaded = admittedPages(inventory).flatMap((page) => page.items);
	const bundles = sortInspectionRecords(
		loaded.filter(
			(item) =>
				(!verdict || item.verdict === verdict) &&
				matchesText(q, [item.run.runId, item.run.agentId ?? "", item.run.wireModelId ?? "", ...item.run.tags]),
		),
		sort,
		(item) => ({
			name: item.run.agentId ?? item.run.runId,
			date: item.run.settledAt ?? "",
			id: item.run.runId,
		}),
	);
	return (
		<section className="run-inspection">
			<PanelHeading panel={PANELS.evidenceInventory} level={1} />
			<p>
				See what supports a result, what was checked, and what remains uncertain. Each run is assessed when it settles, and
				its seal covers the assessment.
			</p>
			<TrustGuide />
			<EvidenceActions key={initialRun} client={client} initialRun={initialRun} />
			<form
				className="trace-filters"
				key={`${q}:${verdict}:${sort}`}
				onSubmit={(event) => {
					event.preventDefault();
					const data = new FormData(event.currentTarget);
					const next = new URLSearchParams(search);
					for (const key of ["q", "verdict", "sort"]) {
						const value = String(data.get(key) ?? "").trim();
						if (value) next.set(key, value);
						else next.delete(key);
					}
					setSearch(next);
				}}
			>
				<label>
					Search loaded runs
					<input name="q" defaultValue={q} maxLength={256} placeholder="Run, agent, model or tag" />
				</label>
				<label>
					Trust verdict
					<select name="verdict" defaultValue={verdict}>
						<option value="">All verdicts</option>
						{Object.keys(verdictText).map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				<label>
					Sort loaded runs
					<select name="sort" defaultValue={sort}>
						<option value="newest">Newest settled</option>
						<option value="oldest">Oldest settled</option>
						<option value="name">Agent</option>
					</select>
				</label>
				<button type="submit">Apply</button>
			</form>
			<p className="panel-note">
				Filters apply to retained runs. Loading older runs can replace earlier pages; refresh to return to the newest.
			</p>
			{!live && <p role="status">Updating inventory. Run links return when the refresh finishes.</p>}
			{(q || verdict || sort !== "newest") && <Link to={listDestination("/evidence", search, ["run"])}>Reset view</Link>}
			<div className="actions inspection-refresh">
				<button
					type="button"
					disabled={inventory.isFetching}
					onClick={() => {
						void queryClient.resetQueries({ queryKey: ["evidence"] });
					}}
				>
					Refresh evidence
				</button>
			</div>
			{inventory.isPending && <p>Reading evidence…</p>}
			{inventory.error && (
				<InspectionError
					title="Evidence inventory unavailable"
					error={inventory.error}
					busy={inventory.isFetching}
					retry={() => {
						void inventory.refetch();
					}}
				/>
			)}
			{inventory.data?.pages[0]?.items.length === 0 && (
				<PanelEmpty>
					{inventory.data.pages[0].present
						? emptyState.emptyStore("settled run")
						: emptyState.missingStore("evidence inventory")}{" "}
					Each dispatch run is assessed when it settles.
				</PanelEmpty>
			)}
			{loaded.length > 0 && bundles.length === 0 && (
				<PanelEmpty>No loaded run matches these filters. Change the filter or continue to older runs.</PanelEmpty>
			)}
			<InspectionSummary
				figures={[
					{ label: "Runs matching / loaded", value: `${bundles.length} / ${loaded.length}` },
					{
						label: "Reviewed or grounded · loaded",
						value: loaded.filter((item) => item.verdict === "reviewed" || item.verdict === "grounded").length,
					},
					{ label: "Compromised · loaded", value: loaded.filter((item) => item.verdict === "compromised").length },
				]}
			/>
			<div className="inspection-inventory">
				{bundles.map(({ run, verdict }) => (
					<article key={run.runId} className="trace-panel">
						<h2 className="inspection-card-title">
							{live ? (
								<Link to={listDestination(`/evidence/${encodeURIComponent(run.runId)}`, search, ["q", "verdict", "sort"])}>
									{run.agentId ?? run.runId}
								</Link>
							) : (
								(run.agentId ?? run.runId)
							)}
						</h2>
						<p>
							<StatusMark tone={evidenceVerdictTone(verdict)} label={verdict} />
							{run.settledAt ? ` · ${formatTime(run.settledAt)}` : ""}
						</p>
						<p>{verdictText[verdict]}</p>
						<p className="inspection-id">{run.runId}</p>
						{run.outcome && <p>{run.outcome}</p>}
						{run.quantities && (
							<p>
								{Object.entries(run.quantities).map(([key, q]) => (
									<span key={key}>
										{key}: <Explained client={client} label={key} {...explainable(q)} />{" "}
									</span>
								))}
							</p>
						)}
					</article>
				))}
			</div>
			{inventory.hasNextPage && !inventory.isRefetchError && (
				<>
					<PanelEmpty>{emptyState.bounded("runs")}</PanelEmpty>
					<button type="button" disabled={inventory.isFetching} onClick={() => void inventory.fetchNextPage()}>
						{inventory.isFetchingNextPage ? "Loading evidence…" : "Load older evidence"}
					</button>
				</>
			)}
		</section>
	);
}
export function EvidenceDetail({ client }: { client: Client }) {
	const { id = "" } = useParams();
	const [search] = useSearchParams();
	const detail = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["evidence-detail", id],
		queryFn: () => client.call(routes.evidenceDetail, { ...emptyInput, params: { id } }),
	});
	const data = detail.data;
	return (
		<section className="run-inspection">
			<Link to={listDestination("/evidence", search, ["q", "verdict", "sort"])}>← Evidence inventory</Link>
			<PanelHeading panel={PANELS.evidenceBundle} level={1} title={data?.run.agentId ?? "Run evidence"} />
			{detail.isPending && <p>Reading evidence…</p>}
			{detail.error && (
				<>
					<InspectionError
						title="Run evidence unavailable"
						error={detail.error}
						busy={detail.isFetching}
						retry={() => {
							void detail.refetch();
						}}
					/>
					<p>Return to the evidence inventory and refresh it to reopen a retained run. Its admission may have expired.</p>
				</>
			)}
			{data && (
				<>
					<p>
						<StatusMark tone={evidenceVerdictTone(data.verdict)} label={data.verdict} />
						{data.run.assessedAt ? ` · Assessed ${formatTime(data.run.assessedAt)}` : " · Not assessed"}
					</p>
					<p>{verdictText[data.verdict]}</p>
					{data.run.sealReason && <p role="alert">Seal: {data.run.sealReason}</p>}
					<nav className="inspection-jumps" aria-label="Evidence sections">
						<a href="#evidence-findings">Findings</a>
						<a href="#evidence-trust">Trust checks</a>
						<a href="#evidence-provenance">Provenance</a>
						<a href="#evidence-gates">Gate verdicts</a>
					</nav>
					{data.run.quantities && (
						<dl className="drill__facts">
							{Object.entries(data.run.quantities).map(([key, q]) => (
								<div key={key}>
									<dt>{key}</dt>
									<dd>
										<Explained client={client} label={key} {...explainable(q)} />
									</dd>
								</div>
							))}
						</dl>
					)}
					<details className="trace-panel">
						<summary>Run identity</summary>
						<p className="inspection-id">{id}</p>
						<Facts
							value={{
								agent: data.run.agentId,
								target: data.run.targetId,
								model: data.run.wireModelId,
								outcome: data.run.outcome,
								session: data.run.sessionId,
							}}
						/>
					</details>
					<EvidenceActions key={id} client={client} initialRun={data.run.runId} initiallyOpen={false} />
					<h2 id="evidence-findings">What was found</h2>
					{!data.findings.length && <PanelEmpty>{emptyState.emptyStore("finding", "for this run")}</PanelEmpty>}
					{data.findings.map((finding) => (
						<article className="trace-panel" key={finding.id}>
							<h3>
								{finding.tag} · {finding.severity}
							</h3>
							<p>{finding.message}</p>
						</article>
					))}
					<div id="evidence-trust" />
					<PanelHeading panel={PANELS.evidenceTrust} />
					<article className="trace-panel">
						<h3>
							<Link to={`/fleet/dispatches/${encodeURIComponent(data.run.runId)}`}>{data.run.runId}</Link> ·{" "}
							{data.summary.verdict}
						</h3>
						<p>{data.summary.text}</p>
						<dl className="inspection-trust-grid">
							{trustChecks.map((check) => (
								<div key={check.key}>
									<dt>{check.label}</dt>
									<dd>{data.summary.axes[check.key]}</dd>
								</div>
							))}
						</dl>
						<TrustGuide axes={data.summary.axes} />
						{data.summary.unknown.length > 0 && <p className="panel-note">Unresolved: {data.summary.unknown.join(" · ")}</p>}
						<details>
							<summary>Authorities and artifact references</summary>
							<Facts
								value={data.status}
								empty="This run recorded no trust status. That is a missing record, not a passing one."
							/>
						</details>
					</article>

					<h2 id="evidence-provenance">Provenance</h2>
					{!data.provenance.lines.length && (
						<PanelEmpty>No provenance claim is admitted by the recorded trust status.</PanelEmpty>
					)}
					{data.provenance.lines.length > 0 && (
						<article className="trace-panel">
							<ul>
								{data.provenance.lines.map((line) => (
									<li key={line}>{line}</li>
								))}
							</ul>
						</article>
					)}
					<div id="evidence-gates" />
					<PanelHeading panel={PANELS.evidenceGates} action={<span className="count">{data.verdicts.length}</span>} />
					{!data.verdicts.length && <PanelEmpty>{emptyState.emptyStore("gate verdict", "sealed with this run")}</PanelEmpty>}
					{data.verdicts.map((gate) => (
						<details key={gate.decisionId} className="trace-panel">
							<summary>Decision {gate.decisionId}</summary>
							<Facts value={gate} order={["decisionId", "outcome", "review", "digest"]} />
						</details>
					))}
					{data.decisions.length > 0 && (
						<details className="trace-panel">
							<summary>Decisions the run cited</summary>
							<Facts value={data.decisions} />
						</details>
					)}
				</>
			)}
		</section>
	);
}
