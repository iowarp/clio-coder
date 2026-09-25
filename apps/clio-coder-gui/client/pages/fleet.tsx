import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { Static } from "typebox";
import type { Councils, FleetGates } from "../../contracts/fleet.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime, formatTokens } from "../api/clock.js";
import { Facts } from "../design/facts.js";
import { Boundary, PanelEmpty, PanelHeading } from "../design/panel.js";
import { DISPATCH_SCOPE, emptyState, PANELS } from "../design/panel-model.js";
import { StatusMark } from "../design/status.js";
import { MarkdownContent } from "../render/Markdown.js";
import { ARTIFACT_MAX_PAGES, ARTIFACT_PAGE_SIZE, admittedPages, retainedLinksLive } from "./artifact-pagination.js";

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
	return (
		<section>
			<PanelHeading panel={PANELS.fleet} level={1} />
			<p>Fleet plans, their dispatch runs, and the decisions Clio Coder recorded about them.</p>
			<p className="panel-note">{DISPATCH_SCOPE}</p>
			{Object.entries({ roots, runs, councils, gates }).map(([name, query]) =>
				query.error ? (
					<p key={name} role="alert">
						{query.error.message}
					</p>
				) : null,
			)}
			<h2>Fleet runs</h2>
			{roots.isPending && <p>Reading fleet history…</p>}
			{roots.data?.pages[0]?.items.length === 0 && <PanelEmpty>{emptyState.emptyStore("fleet run")}</PanelEmpty>}
			<div className="config-entries">
				{admittedPages(roots)
					.flatMap((page) => page.items)
					.map((run) => (
						<article className="trace-panel" key={run.id}>
							<h3>{rootsLive ? <Link to={`/fleet/${run.id}`}>{run.fleet}</Link> : run.fleet}</h3>
							<p>{run.id}</p>
							<StatusMark tone={run.endedAt ? "neutral" : "running"} label={run.endedAt ? "Finished" : "Running"} />
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
			<h2>Dispatch runs</h2>
			{runs.isPending && <p>Reading dispatch history…</p>}
			{runs.data?.pages[0]?.items.length === 0 && <PanelEmpty>{emptyState.emptyStore("dispatch run")}</PanelEmpty>}
			<dl className="settings-list">
				{admittedPages(runs)
					.flatMap((page) => page.items)
					.map((run) => (
						<div key={run.id}>
							<dt>
								{runsLive ? <Link to={`/fleet/dispatches/${run.id}`}>{run.id}</Link> : run.id}
								<br />
								<small>{run.agentId}</small>
							</dt>
							<dd>
								{run.outcome ?? run.status}
								<br />
								{run.targetId} / {run.wireModelId}
							</dd>
							<dd>{formatTokens(run.tokenCount)} tokens</dd>
						</div>
					))}
			</dl>
			{runs.hasNextPage && !runs.isRefetchError && (
				<button type="button" disabled={runs.isFetching} onClick={() => void runs.fetchNextPage()}>
					Load more dispatch runs
				</button>
			)}
			<Topologies councils={councils.data} gates={gates.data} />
			<Boundary panel={PANELS.fleet} />
		</section>
	);
}

export function FleetDetail({ client, dispatch = false }: { client: Client; dispatch?: boolean }) {
	const { id = "" } = useParams();
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
		<section>
			<Link to="/fleet">All fleet activity</Link>
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
							<MarkdownContent source={step.output} complete />
						</article>
					))}
					<Topologies councils={root.data.councils} gates={root.data.gates} />
				</>
			)}
			<h2>Receipt</h2>
			{artifact ? (
				<Facts value={artifact} hide={["version"]} />
			) : (
				<PanelEmpty>{emptyState.emptyStore("readable receipt", "for this run")}</PanelEmpty>
			)}
			<Boundary panel={PANELS.fleetRun} />
		</section>
	);
}
