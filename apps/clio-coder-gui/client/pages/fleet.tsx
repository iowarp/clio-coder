import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import type { Static } from "typebox";
import type { Councils, FleetGates } from "../../contracts/fleet.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Facts } from "../design/facts.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { DISPATCH_SCOPE, emptyState, PANELS } from "../design/panel-model.js";
import { InspectionError, InspectionSummary } from "../design/run-inspection.js";
import { StatusMark, toneForOutcome } from "../design/status.js";
import { MarkdownContent } from "../render/Markdown.js";
import { Explained } from "../telemetry/Explained.js";
import { explainable } from "../telemetry/quantity-model.js";
import { ARTIFACT_MAX_PAGES, ARTIFACT_PAGE_SIZE, admittedPages, retainedLinksLive } from "./artifact-pagination.js";
import {
	evidenceDestination,
	inspectionSort,
	listDestination,
	matchesText,
	sortInspectionRecords,
} from "./run-inspection-model.js";
import "./run-inspection.css";
import { RunRecordChecks } from "./traces/run-record-checks.js";

function Topologies({
	councils,
	gates,
}: {
	councils: Static<typeof Councils> | undefined;
	gates: Static<typeof FleetGates> | undefined;
}) {
	return (
		<>
			<h2>Councils</h2>
			{councils?.truncated && <PanelEmpty>{emptyState.bounded("council groups")}</PanelEmpty>}
			{councils && !councils.councils.length && (
				<PanelEmpty>{emptyState.emptyStore("council group", "in this window")}</PanelEmpty>
			)}
			{councils?.councils.map((council) => (
				<article className="trace-panel" key={council.group}>
					<h3>{council.group}</h3>
					<p className="panel-marks">
						<StatusMark tone={council.running ? "running" : "neutral"} label={council.running ? "Running" : "Finished"} />
						<span>
							Rounds {council.roundsObserved} of {council.roundsPlanned ?? "a plan that was not reported"}
						</span>
						<span>Synthesis {council.synthesis.kind ?? "not reported"}</span>
					</p>
					{council.members.map((member) => (
						<div key={member.label}>
							<h4>
								{member.label} · {member.agentId}
							</h4>
							<p>
								{member.targetId} / {member.wireModelId}
							</p>
							<ul>
								{member.turns.map((turn) => (
									<li key={turn.runId}>
										Round {turn.round}: <Link to={`/fleet/dispatches/${turn.runId}`}>{turn.runId}</Link> ·{" "}
										{turn.outcome ?? turn.status}
									</li>
								))}
							</ul>
							{member.turnsTruncated && <PanelEmpty>{emptyState.bounded("turns", "Earlier")}</PanelEmpty>}
						</div>
					))}
					{council.membersTruncated && <PanelEmpty>{emptyState.bounded("members", "Later")}</PanelEmpty>}
				</article>
			))}
			<h2>Gate decisions</h2>
			{gates?.truncated && <PanelEmpty>{emptyState.bounded("gate decisions")}</PanelEmpty>}
			{!!gates?.unverifiable && (
				<PanelEmpty role="status">
					{gates.unverifiable.toLocaleString("en-US")} gate {gates.unverifiable === 1 ? "artifact" : "artifacts"} could not
					be authenticated, so {gates.unverifiable === 1 ? "it is" : "they are"} not shown as decisions.
				</PanelEmpty>
			)}
			{gates && !gates.decisions.length && (
				<PanelEmpty>{emptyState.emptyStore("authenticated gate decision", "in this window")}</PanelEmpty>
			)}
			{gates?.decisions.map((gate) => (
				<article className="trace-panel" key={gate.id}>
					<h3>
						{gate.topology} · {gate.outcome}
					</h3>
					<p>
						{gate.group} · Cycle {gate.cycle} · {formatTime(gate.decidedAt)}
					</p>
					<ul>
						{gate.subjects.map((id) => (
							<li key={id}>
								<Link to={`/fleet/dispatches/${id}`}>{id}</Link>
							</li>
						))}
					</ul>
					{gate.reason && <p>{gate.reason}</p>}
					{gate.winner && (
						<p>
							Winner: <Link to={`/fleet/dispatches/${gate.winner.runId}`}>{gate.winner.runId}</Link>
						</p>
					)}
					{gate.correlation && <p>Independent decider: {gate.correlation.independent ? "yes" : "no"}</p>}
				</article>
			))}
		</>
	);
}

export function FleetPage({ client }: { client: Client }) {
	const queryClient = useQueryClient();
	const [search, setSearch] = useSearchParams();
	const q = search.get("q") ?? "";
	const status = search.get("status") ?? "";
	const sort = inspectionSort(search.get("sort"));
	const destination = (path: string) => listDestination(path, search, ["q", "status", "sort"]);

	const roots = useInfiniteQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-roots"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.fleetRoots, {
				...emptyInput,
				query: { limit: ARTIFACT_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
		maxPages: ARTIFACT_MAX_PAGES,
	});
	const runs = useInfiniteQuery({
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
	});
	const councils = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-councils"],
		queryFn: () => client.call(routes.fleetCouncils, emptyInput),
	});
	const gates = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-gates"],
		queryFn: () => client.call(routes.fleetGates, emptyInput),
	});
	const rootsLive = retainedLinksLive(roots),
		runsLive = retainedLinksLive(runs);
	const loadedRoots = admittedPages(roots).flatMap((page) => page.items);
	const loadedRuns = admittedPages(runs).flatMap((page) => page.items);
	const matchingRoots = sortInspectionRecords(
		loadedRoots.filter(
			(run) => matchesText(q, [run.id, run.fleet]) && (!status || (status === "active" ? !run.endedAt : !!run.endedAt)),
		),
		sort,
		(run) => ({ name: run.fleet, date: run.startedAt, id: run.id }),
	);
	const matchingRuns = sortInspectionRecords(
		loadedRuns.filter(
			(run) =>
				matchesText(q, [run.id, run.agentId, run.task, run.targetId, run.wireModelId]) &&
				(!status || (status === "active" ? !run.endedAt : !!run.endedAt)),
		),
		sort,
		(run) => ({ name: run.task || run.agentId, date: run.startedAt, id: run.id }),
	);
	return (
		<section className="run-inspection">
			<PanelHeading panel={PANELS.fleet} level={1} />
			<p>Fleet plans, their dispatch runs, and the decisions Clio Coder recorded about them.</p>
			<p className="panel-note">{DISPATCH_SCOPE}</p>
			<div className="actions">
				<button
					type="button"
					disabled={roots.isFetching || runs.isFetching || councils.isFetching || gates.isFetching}
					onClick={() => {
						void Promise.all([
							queryClient.resetQueries({ queryKey: ["fleet-roots"] }),
							queryClient.resetQueries({ queryKey: ["fleet-dispatches"] }),
							councils.refetch(),
							gates.refetch(),
						]);
					}}
				>
					Refresh history
				</button>
			</div>
			{(!rootsLive || !runsLive) && <p role="status">Updating history. Detail links return when the refresh finishes.</p>}
			<nav className="inspection-jumps" aria-label="Fleet history sections">
				<a href="#fleet-roots">Fleet executions</a>
				<a href="#fleet-workers">Dispatched workers</a>
				{/* biome-ignore lint/a11y/useValidAnchor: This jump navigates to the decisions section and opens its disclosure so the destination is visible. */}
				<a
					href="#fleet-decisions"
					onClick={() => {
						const section = document.getElementById("fleet-decisions");
						if (section instanceof HTMLDetailsElement) section.open = true;
					}}
				>
					Councils & decisions
				</a>
			</nav>
			<form
				className="trace-filters"
				key={search.toString()}
				onSubmit={(event) => {
					event.preventDefault();
					const data = new FormData(event.currentTarget);
					const next = new URLSearchParams();
					for (const key of ["q", "status", "sort"]) {
						const value = String(data.get(key) ?? "").trim();
						if (value) next.set(key, value);
					}
					setSearch(next);
				}}
			>
				<label>
					Search loaded history
					<input name="q" defaultValue={q} maxLength={256} placeholder="Fleet, run, agent, task or model" />
				</label>
				<label>
					Activity
					<select name="status" defaultValue={status}>
						<option value="">All activity</option>
						<option value="active">No end recorded</option>
						<option value="finished">End recorded</option>
					</select>
				</label>
				<label>
					Sort loaded history
					<select name="sort" defaultValue={sort}>
						<option value="newest">Newest first</option>
						<option value="oldest">Oldest first</option>
						<option value="name">Task / fleet name</option>
					</select>
				</label>
				<button type="submit">Apply</button>
				{(q || status || sort !== "newest") && <Link to="/fleet">Reset view</Link>}
			</form>
			<p className="panel-note">
				Filters apply to retained fleet and worker pages. Loading older records can replace earlier pages; refresh to return
				to the newest. Start, steer or cancel work from its conversation.
			</p>
			<InspectionSummary
				figures={[
					{ label: "Fleet executions loaded", value: loadedRoots.length },
					{ label: "Worker dispatches loaded", value: loadedRuns.length },
					{ label: "Council groups recorded", value: councils.data?.councils.length ?? "—" },
					{ label: "Authenticated decisions", value: gates.data?.decisions.length ?? "—" },
				]}
			/>
			{Object.entries({
				"Fleet executions": roots,
				"Worker dispatches": runs,
				"Council groups": councils,
				"Gate decisions": gates,
			}).map(([name, query]) =>
				query.error ? (
					<InspectionError
						key={name}
						title={`${name} unavailable`}
						error={query.error}
						busy={query.isFetching}
						retry={() => {
							void query.refetch();
						}}
					/>
				) : null,
			)}
			<div className="inspection-section-heading">
				<h2 id="fleet-roots">Fleet executions</h2>
				<span className="inspection-result-count">
					{matchingRoots.length} of {loadedRoots.length} loaded
				</span>
			</div>
			<p className="panel-note">
				A fleet execution records the plan and completed steps. Each step can point to its terminal worker dispatch.
			</p>
			{roots.isPending && <p>Reading fleet history…</p>}
			{roots.data?.pages[0]?.items.length === 0 && (
				<PanelEmpty>
					{roots.data.pages[0].present ? emptyState.emptyStore("fleet run") : emptyState.missingStore("fleet history")}
				</PanelEmpty>
			)}
			{loadedRoots.length > 0 && matchingRoots.length === 0 && (
				<PanelEmpty>No loaded fleet execution matches these filters.</PanelEmpty>
			)}
			<div className="inspection-inventory">
				{matchingRoots.map((run) => (
					<article className="trace-panel" key={run.id}>
						<h3>
							{rootsLive ? <Link to={destination(`/fleet/${encodeURIComponent(run.id)}`)}>{run.fleet}</Link> : run.fleet}
						</h3>
						<p className="inspection-id">{run.id}</p>
						<StatusMark
							tone={run.endedAt ? "neutral" : "unverified"}
							label={run.endedAt ? "End recorded" : "No end recorded"}
						/>
						<p>
							{run.completedCount} of {run.stepCount} {run.stepCount === 1 ? "step" : "steps"} recorded
						</p>
						<p>Started {formatTime(run.startedAt)}</p>
					</article>
				))}
			</div>
			{roots.hasNextPage && !roots.isRefetchError && (
				<button type="button" disabled={roots.isFetching} onClick={() => void roots.fetchNextPage()}>
					{roots.isFetchingNextPage ? "Loading fleet runs…" : "Load older fleet runs"}
				</button>
			)}
			<div className="inspection-section-heading">
				<h2 id="fleet-workers">Dispatched workers</h2>
				<span className="inspection-result-count">
					{matchingRuns.length} of {loadedRuns.length} loaded
				</span>
			</div>
			{runs.isPending && <p>Reading dispatch history…</p>}
			{runs.data?.pages[0]?.items.length === 0 && (
				<PanelEmpty>
					{runs.data.pages[0].present ? emptyState.emptyStore("dispatch run") : emptyState.missingStore("dispatch ledger")}
				</PanelEmpty>
			)}
			{loadedRuns.length > 0 && matchingRuns.length === 0 && (
				<PanelEmpty>No loaded worker dispatch matches these filters.</PanelEmpty>
			)}
			<div className="inspection-inventory">
				{matchingRuns.map((run) => (
					<article className="trace-panel" key={run.id}>
						<p className="panel-marks">
							<StatusMark tone={toneForOutcome(run.outcome ?? run.status)} label={run.outcome ?? run.status} />
							<span className="panel-note">{run.agentId}</span>
						</p>
						<h3 className="inspection-card-title">
							{runsLive ? (
								<Link to={destination(`/fleet/dispatches/${encodeURIComponent(run.id)}`)}>
									{run.task || `Dispatch by ${run.agentId}`}
								</Link>
							) : (
								run.task || `Dispatch by ${run.agentId}`
							)}
						</h3>
						<p className="panel-note">
							{run.targetId} / {run.wireModelId}
						</p>
						<p className="panel-note">{run.evidence.integrity.display}</p>
						<div className="panel-note">
							{formatTime(run.startedAt)} ·{" "}
							<Explained client={client} label="Run tokens" {...explainable(run.telemetry?.tokens)} /> tokens
						</div>
						<details>
							<summary>Run identity & lineage</summary>
							<p className="inspection-id">{run.id}</p>
							{run.rootRunId && <p className="inspection-lineage">Root: {run.rootRunId}</p>}
							{run.parentRunId && <p className="inspection-lineage">Parent: {run.parentRunId}</p>}
						</details>
					</article>
				))}
			</div>
			{runs.hasNextPage && !runs.isRefetchError && (
				<button type="button" disabled={runs.isFetching} onClick={() => void runs.fetchNextPage()}>
					{runs.isFetchingNextPage ? "Loading dispatches…" : "Load older dispatches"}
				</button>
			)}
			<details className="trace-panel" id="fleet-decisions">
				<summary>
					Councils & gate decisions · {councils.data?.councils.length ?? "…"} groups / {gates.data?.decisions.length ?? "…"}{" "}
					decisions
				</summary>
				{(councils.isPending || gates.isPending) && <p>Reading recorded decisions…</p>}
				<Topologies councils={councils.data} gates={gates.data} />
			</details>
		</section>
	);
}

export function FleetDetail({ client, dispatch = false }: { client: Client; dispatch?: boolean }) {
	const { id = "" } = useParams();
	const [search] = useSearchParams();
	const back = listDestination("/fleet", search, ["q", "status", "sort"]);
	const root = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-root", id],
		queryFn: () => client.call(routes.fleetRoot, { ...emptyInput, params: { id } }),
		enabled: !dispatch,
	});
	const run = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-dispatch", id],
		queryFn: () => client.call(routes.dispatchRun, { ...emptyInput, params: { id } }),
		enabled: dispatch,
	});
	// The saved document is read only once asked for; until then the record is its evidence alone (#434 §11.3).
	const [full, setFull] = useState(false);
	const record = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["fleet-run-record", id, full],
		queryFn: () =>
			client.call(routes.fleetRunRecord, { ...emptyInput, params: { id }, query: full ? { include: "full" } : {} }),
		enabled: full,
		placeholderData: (previous) => previous,
	});
	// The full response rechecks the seal, so its evidence replaces the row's once it arrives (#434).
	const fresh = full && !record.isPlaceholderData ? record.data : undefined;
	const evidence = fresh?.evidence ?? (dispatch ? run.data?.evidence : root.data?.evidence);
	const saved = fresh?.record ?? null;
	return (
		<section className="run-inspection">
			<Link to={back}>← Fleet history</Link>
			<p className="panel-note">Installation history · saved execution records</p>
			<PanelHeading
				panel={PANELS.fleetRun}
				level={1}
				title={
					dispatch
						? run.data?.agentId
							? `${run.data.agentId} dispatch`
							: "Dispatch run"
						: (root.data?.run.fleet ?? "Fleet execution")
				}
			/>
			{Object.entries({ root, run, record }).map(([name, query]) =>
				query.error ? (
					<InspectionError
						key={name}
						title={`${name === "root" ? "Fleet execution" : name === "run" ? "Dispatch" : "Run record"} unavailable`}
						error={query.error}
						busy={query.isFetching}
						retry={() => {
							void query.refetch();
						}}
					/>
				) : null,
			)}
			{(dispatch ? run.isPending : root.isPending) && <p>Reading run…</p>}
			{run.data && (
				<>
					<h2>
						{run.data.agentId} · {run.data.outcome ?? run.data.status}
					</h2>
					<div className="panel-note">
						{run.data.targetId} / {run.data.wireModelId} ·{" "}
						<Explained client={client} label="Run tokens" {...explainable(run.data.telemetry?.tokens)} /> tokens
					</div>
					<div className="inspection-jumps">
						<Link to={evidenceDestination(run.data.id)}>Collect or recheck evidence</Link>
						<Link to={`/traces?${new URLSearchParams({ q: run.data.id, source: "dispatch" })}`}>Find its trace</Link>
						{run.data.sessionId && <Link to={`/sessions/${encodeURIComponent(run.data.sessionId)}`}>Open conversation</Link>}
					</div>
					<details className="trace-panel inspection-record-meta">
						<summary>Run identity, timing & runtime</summary>
						<p className="inspection-id">{id}</p>
						<dl className="trace-facts">
							<dt>Workspace</dt>
							<dd>{run.data.cwd}</dd>
							<dt>Runtime</dt>
							<dd>{run.data.runtimeId}</dd>
							<dt>Started</dt>
							<dd>{formatTime(run.data.startedAt)}</dd>
							<dt>Ended</dt>
							<dd>{run.data.endedAt ? formatTime(run.data.endedAt) : "Not recorded"}</dd>
							{run.data.parentRunId && (
								<>
									<dt>Parent dispatch</dt>
									<dd>
										<Link to={`/fleet/dispatches/${encodeURIComponent(run.data.parentRunId)}`}>{run.data.parentRunId}</Link>
									</dd>
								</>
							)}
							{run.data.rootRunId && (
								<>
									<dt>Root dispatch</dt>
									<dd>
										<Link to={`/fleet/dispatches/${encodeURIComponent(run.data.rootRunId)}`}>{run.data.rootRunId}</Link>
									</dd>
								</>
							)}
						</dl>
					</details>
					{run.data.outcomeDetail && <p className="inspection-error">{run.data.outcomeDetail}</p>}
					<h3>Worker task</h3>
					<MarkdownContent source={run.data.task} complete />
				</>
			)}
			{root.data && (
				<>
					<InspectionSummary
						figures={[
							{ label: "Steps recorded", value: `${root.data.run.completedCount} / ${root.data.run.stepCount}` },
							{ label: "End time", value: root.data.run.endedAt ? formatTime(root.data.run.endedAt) : "Not recorded" },
						]}
					/>
					<details className="trace-panel">
						<summary>Execution identity & plan</summary>
						<Facts value={root.data.run} />
					</details>
					<h2>Recorded steps</h2>
					{!root.data.steps.length && <PanelEmpty>No completed step output was retained for this execution.</PanelEmpty>}
					<p>
						{root.data.run.completedCount} of {root.data.run.stepCount} {root.data.run.stepCount === 1 ? "step" : "steps"}{" "}
						recorded
					</p>
					{root.data.run.completedCount < root.data.run.stepCount && (
						<p className="panel-note">Remaining steps have no completed result in this record.</p>
					)}
					{root.data.steps.map((step) => (
						<article className="trace-panel" key={step.stepId}>
							<h3>
								{step.stepId} · {step.succeeded ? "Succeeded" : "Failed"}
							</h3>
							{step.terminalRunId && <Link to={`/fleet/dispatches/${step.terminalRunId}`}>{step.terminalRunId}</Link>}
							<StatusMark
								tone={step.integrityValid ? "success" : "fail"}
								label={step.integrityValid ? "Recorded integrity valid" : "Recorded integrity invalid"}
							/>
							{step.failureReason && <p>{step.failureReason}</p>}
							<details>
								<summary>Inspect worker output</summary>
								<MarkdownContent source={step.output} complete />
							</details>
						</article>
					))}
					<Topologies councils={root.data.councils} gates={root.data.gates} />
				</>
			)}
			<h2>Run record</h2>
			{dispatch && record.isPending && <p>Reading run record…</p>}
			{evidence ? (
				<>
					<RunRecordChecks evidence={evidence} />
					{saved ? (
						<details>
							<summary>The settled record, in full</summary>
							<Facts value={saved} hide={["version"]} />
						</details>
					) : evidence.record === "settled" ? (
						<button type="button" disabled={full && record.isFetching} onClick={() => setFull(true)}>
							{full && record.isFetching ? "Reading run record…" : "Load full run record"}
						</button>
					) : null}
				</>
			) : !(dispatch ? run.isPending || run.error : root.isPending || root.error) ? (
				<PanelEmpty>{emptyState.emptyStore("readable record", "for this run")}</PanelEmpty>
			) : null}
		</section>
	);
}
