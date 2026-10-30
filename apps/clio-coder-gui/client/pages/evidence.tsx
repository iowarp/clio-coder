import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { RequestRecovery, useOperationRequest } from "../api/operation-request.js";
import { Facts } from "../design/facts.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { emptyState, PANELS } from "../design/panel-model.js";
import { InspectionError, InspectionSummary } from "../design/run-inspection.js";
import { StatusMark } from "../design/status.js";
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
/**
 * A new bundle was never served by a listing, so its detail route refuses it.
 * Refresh the bounded inventory before following its newly admitted detail.
 */
export function CollectedEvidence({ id }: { id: string }) {
	return (
		<p>
			Collected <code>{id}</code>. Open it from the evidence list, which orders bundles by collection time.
		</p>
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
	const queryClient = useQueryClient();
	const navigate = useNavigate();
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
			request.action === "build" ? routes.evidenceBuild : routes.receiptVerify,
			{ ...emptyInput, params: { id: request.workspaceId, runId: request.resourceId } },
			request.key,
			undefined,
			request.epoch ?? undefined,
		),
	);
	const { operation, busy } = tracking;
	const submit = (kind: "build" | "verify") =>
		tracking.start({ workspaceId: selection.id, resourceId: runId.trim(), action: kind });
	return (
		<details className="trace-panel evidence-actions" open={initiallyOpen || !!tracking.request}>
			<summary>Collect evidence or recheck a receipt</summary>
			<p>
				Choose a workspace and a dispatch run. Collecting evidence saves a report of the records Clio can find. Rechecking
				reads the original receipt again to detect changes since the report was created. The chosen workspace runs the
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
					<button type="button" disabled={busy || !selection.id || !runId.trim()} onClick={() => submit("build")}>
						Collect evidence
					</button>
					<button type="button" disabled={busy || !selection.id || !runId.trim()} onClick={() => submit("verify")}>
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
							{"kind" in operation.data.result && operation.data.result.kind === "evidence" && (
								<>
									<CollectedEvidence id={operation.data.result.id} />
									<button
										type="button"
										onClick={() => {
											void queryClient.resetQueries({ queryKey: ["evidence"] }).then(() => navigate("/evidence"));
										}}
									>
										Open refreshed evidence inventory
									</button>
								</>
							)}
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
				matchesText(q, [
					item.overview.evidenceId,
					...(item.overview.tasks ?? []),
					...(item.overview.runIds ?? []),
					...(item.overview.agentIds ?? []),
					...(item.overview.modelIds ?? []),
				]),
		),
		sort,
		(item) => ({
			name: item.overview.tasks[0] || item.overview.evidenceId,
			date: item.overview.generatedAt,
			id: item.overview.evidenceId,
		}),
	);
	return (
		<section className="run-inspection">
			<PanelHeading panel={PANELS.evidenceInventory} level={1} />
			<p>
				See what supports a result, what was checked, and what remains uncertain. Reports reflect the records available when
				they were collected.
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
					Search loaded bundles
					<input name="q" defaultValue={q} maxLength={256} placeholder="Task, run, agent, model or bundle" />
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
					Sort loaded bundles
					<select name="sort" defaultValue={sort}>
						<option value="newest">Newest collected</option>
						<option value="oldest">Oldest collected</option>
						<option value="name">Task name</option>
					</select>
				</label>
				<button type="submit">Apply</button>
			</form>
			<p className="panel-note">
				Filters apply to retained bundles. Loading older bundles can replace earlier pages; refresh to return to the newest.
			</p>
			{!live && <p role="status">Updating inventory. Bundle links return when the refresh finishes.</p>}
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
						? emptyState.emptyStore("evidence bundle")
						: emptyState.missingStore("evidence inventory")}{" "}
					Collect evidence from a completed dispatch run to start one.
				</PanelEmpty>
			)}
			{loaded.length > 0 && bundles.length === 0 && (
				<PanelEmpty>No loaded bundle matches these filters. Change the filter or continue to older bundles.</PanelEmpty>
			)}
			<InspectionSummary
				figures={[
					{ label: "Bundles matching / loaded", value: `${bundles.length} / ${loaded.length}` },
					{
						label: "Reviewed or grounded · loaded",
						value: loaded.filter((item) => item.verdict === "reviewed" || item.verdict === "grounded").length,
					},
					{ label: "Compromised · loaded", value: loaded.filter((item) => item.verdict === "compromised").length },
				]}
			/>
			<div className="inspection-inventory">
				{bundles.map(({ overview, verdict }) => (
					<article key={overview.evidenceId} className="trace-panel">
						<h2 className="inspection-card-title">
							{live ? (
								<Link
									to={listDestination(`/evidence/${encodeURIComponent(overview.evidenceId)}`, search, ["q", "verdict", "sort"])}
								>
									{overview.tasks[0] || overview.evidenceId}
								</Link>
							) : (
								overview.tasks[0] || overview.evidenceId
							)}
						</h2>
						<p>
							<StatusMark tone={evidenceVerdictTone(verdict)} label={verdict} /> · {formatTime(overview.generatedAt)}
						</p>
						<p>{verdictText[verdict]}</p>
						<p className="inspection-id">{overview.evidenceId}</p>
						{overview.tasks.length > 1 && <p>{overview.tasks.slice(1).join(" · ")}</p>}
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
			<PanelHeading panel={PANELS.evidenceBundle} level={1} title={data?.overview.tasks[0] || "Evidence bundle"} />
			{detail.isPending && <p>Reading report…</p>}
			{detail.error && (
				<>
					<InspectionError
						title="Evidence bundle unavailable"
						error={detail.error}
						busy={detail.isFetching}
						retry={() => {
							void detail.refetch();
						}}
					/>
					<p>Return to the evidence inventory and refresh it to reopen a retained bundle. Its admission may have expired.</p>
				</>
			)}
			{data && (
				<>
					<p>
						<StatusMark tone={evidenceVerdictTone(data.verdict)} label={data.verdict} /> · Collected{" "}
						{formatTime(data.overview.generatedAt)}
					</p>
					<p>{verdictText[data.verdict]}</p>
					<nav className="inspection-jumps" aria-label="Evidence sections">
						<a href="#evidence-findings">Findings</a>
						<a href="#evidence-trust">Trust checks</a>
						<a href="#evidence-provenance">Provenance</a>
						<a href="#evidence-gates">Gate decisions</a>
					</nav>
					<InspectionSummary
						figures={[
							{ label: "Runs in bundle", value: data.overview.totals.runs },
							{ label: "Saved receipts", value: data.overview.totals.receipts },
							{
								label: "Tool calls / errors",
								value: `${data.overview.totals.toolCalls} / ${data.overview.totals.toolErrors}`,
							},
						]}
					/>
					<details className="trace-panel">
						<summary>Bundle identity & source records</summary>
						<p className="inspection-id">{id}</p>
						<Facts
							value={{
								source: data.overview.source,
								models: data.overview.modelIds,
								agents: data.overview.agentIds,
								files: data.overview.files,
							}}
						/>
					</details>

					<details className="trace-panel">
						<summary>Tool-event attribution</summary>
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
					</details>
					{data.projection === "historical_format" && (
						<PanelEmpty>
							{emptyState.predatesSchema("bundle", "trust projection", "axes")} Recheck its original receipt to learn its
							current integrity.
						</PanelEmpty>
					)}
					<EvidenceActions key={id} client={client} initialRun={data.overview.runIds[0] ?? ""} initiallyOpen={false} />
					<h2 id="evidence-findings">What was found</h2>
					{!data.findings.length && <PanelEmpty>{emptyState.emptyStore("finding", "in this bundle")}</PanelEmpty>}
					{data.findings.map((finding) => (
						<article className="trace-panel" key={finding.id}>
							<h3>
								{finding.tag} · {finding.severity}
							</h3>
							{finding.tag === "best-effort-link" && <span className="count">Best effort attribution</span>}
							<p>{finding.message}</p>
							{finding.runId && <Link to={`/fleet/dispatches/${encodeURIComponent(finding.runId)}`}>{finding.runId}</Link>}
						</article>
					))}
					<div id="evidence-trust" />
					<PanelHeading panel={PANELS.evidenceTrust} action={<span className="count">{data.runs.length}</span>} />
					{!data.runs.length && <PanelEmpty>{emptyState.emptyStore("run", "in this bundle")}</PanelEmpty>}
					{data.runs.map((run) => (
						<article className="trace-panel" key={run.runId}>
							<h3>
								<Link to={`/fleet/dispatches/${encodeURIComponent(run.runId)}`}>{run.runId}</Link> · {run.summary.verdict}
							</h3>
							<p>{run.summary.text}</p>
							<dl className="inspection-trust-grid">
								{trustChecks.map((check) => (
									<div key={check.key}>
										<dt>{check.label}</dt>
										<dd>{run.summary.axes[check.key]}</dd>
									</div>
								))}
							</dl>
							<TrustGuide axes={run.summary.axes} />
							{run.summary.unknown.length > 0 && <p className="panel-note">Unresolved: {run.summary.unknown.join(" · ")}</p>}
							<details>
								<summary>Authorities and artifact references</summary>
								<Facts
									value={run.status}
									empty="This run recorded no trust status. That is a missing record, not a passing one."
								/>
							</details>
						</article>
					))}

					<h2 id="evidence-provenance">Provenance</h2>
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
					<div id="evidence-gates" />
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
				</>
			)}
		</section>
	);
}
