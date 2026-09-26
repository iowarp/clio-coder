import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router";
import type { Static } from "typebox";
import type { Councils, FleetGates } from "../../contracts/fleet.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime, formatTokens } from "../api/clock.js";
import { Facts } from "../design/facts.js";
import { PanelEmpty, PanelHeading } from "../design/panel.js";
import { DISPATCH_SCOPE, emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark, toneForOutcome } from "../design/status.js";
import { MarkdownContent } from "../render/Markdown.js";
import { ARTIFACT_MAX_PAGES, ARTIFACT_PAGE_SIZE, admittedPages, retainedLinksLive } from "./artifact-pagination.js";
import { evidenceDestination, listDestination, matchesText } from "./run-inspection-model.js";
import "./run-inspection.css";
import { ReceiptChecks } from "./traces/receipt-checks.js";

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
	const [search, setSearch] = useSearchParams();
	const q = search.get("q") ?? "";
	const status = search.get("status") ?? "";
	const destination = (path: string) => listDestination(path, search, ["q", "status"]);

	const roots = useInfiniteQuery({
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
		queryKey: ["fleet-councils"],
		queryFn: () => client.call(routes.fleetCouncils, emptyInput),
	});
	const gates = useQuery({ queryKey: ["fleet-gates"], queryFn: () => client.call(routes.fleetGates, emptyInput) });
	const rootsLive = retainedLinksLive(roots),
		runsLive = retainedLinksLive(runs);
	const loadedRoots = admittedPages(roots).flatMap((page) => page.items);
	const loadedRuns = admittedPages(runs).flatMap((page) => page.items);
	const matchingRoots = loadedRoots.filter(
		(run) => matchesText(q, [run.id, run.fleet]) && (!status || (status === "active" ? !run.endedAt : !!run.endedAt)),
	);
	const matchingRuns = loadedRuns.filter(
		(run) =>
			matchesText(q, [run.id, run.agentId, run.task, run.targetId, run.wireModelId]) &&
			(!status || (status === "active" ? !run.endedAt : !!run.endedAt)),
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
						void Promise.all([roots.refetch(), runs.refetch(), councils.refetch(), gates.refetch()]);
					}}
				>
					Refresh history
				</button>
			</div>
			{(!rootsLive || !runsLive) && <p role="status">Updating history. Detail links return when the refresh finishes.</p>}
			<nav className="inspection-jumps" aria-label="Fleet history sections">
				<a href="#fleet-roots">Fleet executions</a>
				<a href="#fleet-workers">Dispatched workers</a>
				<a href="#fleet-decisions">Councils & decisions</a>
			</nav>
			<form
				className="trace-filters"
				key={search.toString()}
				onSubmit={(event) => {
					event.preventDefault();
					const data = new FormData(event.currentTarget);
					const next = new URLSearchParams();
					for (const key of ["q", "status"]) {
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
				<button type="submit">Filter</button>
				{(q || status) && <Link to="/fleet">Clear filters</Link>}
			</form>
			<p className="panel-note">
				Filters apply to the loaded fleet and worker pages. Continue to older pages to extend the search. Start, steer or
				cancel work from its conversation.
			</p>
			{Object.entries({ roots, runs, councils, gates }).map(([name, query]) =>
				query.error ? (
					<p key={name} role="alert">
						{query.error.message}
					</p>
				) : null,
			)}
			<h2 id="fleet-roots">Fleet executions</h2>
			<p className="panel-note">
				A fleet execution records the plan and completed steps. Each step can point to its terminal worker dispatch.
			</p>
			{roots.isPending && <p>Reading fleet history…</p>}
			{roots.data?.pages[0]?.items.length === 0 && <PanelEmpty>{emptyState.emptyStore("fleet run")}</PanelEmpty>}
			{loadedRoots.length > 0 && matchingRoots.length === 0 && (
				<PanelEmpty>No loaded fleet execution matches these filters.</PanelEmpty>
			)}
			<div className="config-entries">
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
					Load more fleet runs
				</button>
			)}
			<h2 id="fleet-workers">Dispatched workers</h2>
			{runs.isPending && <p>Reading dispatch history…</p>}
			{runs.data?.pages[0]?.items.length === 0 && <PanelEmpty>{emptyState.emptyStore("dispatch run")}</PanelEmpty>}
			{loadedRuns.length > 0 && matchingRuns.length === 0 && (
				<PanelEmpty>No loaded worker dispatch matches these filters.</PanelEmpty>
			)}
			<dl className="settings-list inspection-workers">
				{matchingRuns.map((run) => (
					<div key={run.id}>
						<dt>
							{runsLive ? <Link to={destination(`/fleet/dispatches/${encodeURIComponent(run.id)}`)}>{run.id}</Link> : run.id}
							<br />
							<small>{run.agentId}</small>
							{run.task && (
								<small className="inspection-lineage">{run.task.length > 130 ? `${run.task.slice(0, 130)}…` : run.task}</small>
							)}
						</dt>
						<dd>
							<StatusMark tone={toneForOutcome(run.outcome ?? run.status)} label={run.outcome ?? run.status} />
							<br />
							{run.targetId} / {run.wireModelId}
						</dd>
						<dd>
							{formatTokens(run.tokenCount)} tokens
							{run.rootRunId && <small className="inspection-lineage">Root dispatch: {run.rootRunId}</small>}
							{run.parentRunId && <small className="inspection-lineage">Parent: {run.parentRunId}</small>}
						</dd>
					</div>
				))}
			</dl>
			{runs.hasNextPage && !runs.isRefetchError && (
				<button type="button" disabled={runs.isFetching} onClick={() => void runs.fetchNextPage()}>
					Load more dispatch runs
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
	const back = listDestination("/fleet", search, ["q", "status"]);
	const root = useQuery({
		queryKey: ["fleet-root", id],
		queryFn: () => client.call(routes.fleetRoot, { ...emptyInput, params: { id } }),
		enabled: !dispatch,
	});
	const run = useQuery({
		queryKey: ["fleet-dispatch", id],
		queryFn: () => client.call(routes.dispatchRun, { ...emptyInput, params: { id } }),
		enabled: dispatch,
	});
	const receipt = useQuery({
		queryKey: ["fleet-receipt", id],
		queryFn: () => client.call(routes.fleetReceipt, { ...emptyInput, params: { id } }),
		enabled: dispatch,
	});
	const artifact = dispatch ? receipt.data?.receipt : root.data?.receipt;
	return (
		<section className="run-inspection">
			<Link to={back}>← Fleet history</Link>
			<p className="panel-note">Installation history · saved execution records</p>
			<PanelHeading panel={PANELS.fleetRun} level={1} title={`${dispatch ? "Dispatch run" : "Fleet run"} · ${id}`} />
			{Object.entries({ root, run, receipt }).map(([name, query]) =>
				query.error ? (
					<p role="alert" key={name}>
						{query.error.message}
					</p>
				) : null,
			)}
			{(dispatch ? run.isPending : root.isPending) && <p>Reading run…</p>}
			{run.data && (
				<>
					<h2>
						{run.data.agentId} · {run.data.outcome ?? run.data.status}
					</h2>
					<p>
						{run.data.targetId} / {run.data.wireModelId} · {formatTokens(run.data.tokenCount)} tokens
					</p>
					<div className="inspection-jumps">
						<Link to={evidenceDestination(run.data.id)}>Collect or recheck evidence</Link>
						<Link to={`/traces?${new URLSearchParams({ q: run.data.id, source: "dispatch" })}`}>Find its trace</Link>
						{run.data.sessionId && <Link to={`/sessions/${encodeURIComponent(run.data.sessionId)}`}>Open conversation</Link>}
					</div>
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
					<h3>Worker task</h3>
					<MarkdownContent source={run.data.task} complete />
				</>
			)}
			{root.data && (
				<>
					<h2>{root.data.run.fleet}</h2>
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
			<h2>Saved receipt</h2>
			{dispatch && receipt.isPending && <p>Reading receipt…</p>}
			{artifact ? (
				<>
					<ReceiptChecks receipt={artifact} />
					<details>
						<summary>Every receipt field</summary>
						<Facts value={artifact} hide={["version"]} />
					</details>
				</>
			) : !(dispatch ? receipt.isPending || receipt.error : root.isPending || root.error) ? (
				<PanelEmpty>{emptyState.emptyStore("readable receipt", "for this run")}</PanelEmpty>
			) : null}
		</section>
	);
}
