import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import type { Static } from "typebox";
import type { Councils, FleetGates } from "../../contracts/fleet.js";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { MarkdownContent } from "../render/Markdown.js";

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
			{councils?.truncated && <p>The canonical council window is truncated; older groups may be absent.</p>}
			{councils && !councils.councils.length && <p>No council groups recorded in this window.</p>}
			{councils?.councils.map((council) => (
				<article className="trace-panel" key={council.group}>
					<h3>{council.group}</h3>
					<p>
						{council.running ? "Running" : "Finished"} · Rounds {council.roundsObserved} /{" "}
						{council.roundsPlanned ?? "unreported"} · Synthesis: {council.synthesis.kind ?? "unreported"}
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
							{member.turnsTruncated && <p>Earlier turns omitted by the canonical topology window.</p>}
						</div>
					))}
					{council.membersTruncated && <p>Additional members omitted.</p>}
				</article>
			))}
			<h2>Gate decisions</h2>
			{gates?.truncated && <p>The canonical gate window is truncated; older decisions may be absent.</p>}
			{!!gates?.unverifiable && <p role="status">{gates.unverifiable} gate artifacts could not be authenticated.</p>}
			{gates && !gates.decisions.length && <p>No verified gate decisions in this window.</p>}
			{gates?.decisions.map((gate) => (
				<article className="trace-panel" key={gate.id}>
					<h3>
						{gate.topology} · {gate.outcome}
					</h3>
					<p>
						{gate.group} · Cycle {gate.cycle} · {gate.decidedAt}
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
			client.call(routes.fleetRoots, { ...emptyInput, query: { limit: 40, ...(pageParam ? { cursor: pageParam } : {}) } }),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
	const runs = useInfiniteQuery({
		queryKey: ["fleet-dispatches"],
		initialPageParam: undefined as string | undefined,
		queryFn: ({ pageParam }) =>
			client.call(routes.dispatchRuns, {
				...emptyInput,
				query: { limit: 40, ...(pageParam ? { cursor: pageParam } : {}) },
			}),
		getNextPageParam: (page) => page.nextCursor ?? undefined,
	});
	const councils = useQuery({
		queryKey: ["fleet-councils"],
		queryFn: () => client.call(routes.fleetCouncils, emptyInput),
	});
	const gates = useQuery({ queryKey: ["fleet-gates"], queryFn: () => client.call(routes.fleetGates, emptyInput) });
	return (
		<section>
			<p className="eyebrow">Execution / Durable history</p>
			<h1>Fleet</h1>
			<p>Inspect fleet plans, their dispatch runs, and the decisions recorded by Clio.</p>
			{Object.entries({ roots, runs, councils, gates }).map(([name, query]) =>
				query.error ? (
					<p key={name} role="alert">
						{query.error.message}
					</p>
				) : null,
			)}
			<h2>Fleet runs</h2>
			{roots.isPending && <p>Reading fleet history…</p>}
			{roots.data?.pages[0]?.items.length === 0 && <p>No durable fleet runs.</p>}
			<div className="config-entries">
				{roots.data?.pages
					.flatMap((page) => page.items)
					.map((run) => (
						<article className="trace-panel" key={run.id}>
							<h3>
								<Link to={`/fleet/${run.id}`}>{run.fleet}</Link>
							</h3>
							<p>{run.id}</p>
							<p>
								{run.completedCount} / {run.stepCount} steps recorded · {run.endedAt ? "Finished" : "Running"}
							</p>
							<p>{run.startedAt}</p>
						</article>
					))}
			</div>
			{roots.hasNextPage && (
				<button type="button" disabled={roots.isFetchingNextPage} onClick={() => void roots.fetchNextPage()}>
					Load more fleet runs
				</button>
			)}
			<h2>Dispatch runs</h2>
			{runs.isPending && <p>Reading dispatch history…</p>}
			{runs.data?.pages[0]?.items.length === 0 && <p>No durable dispatch runs.</p>}
			<dl className="settings-list">
				{runs.data?.pages
					.flatMap((page) => page.items)
					.map((run) => (
						<div key={run.id}>
							<dt>
								<Link to={`/fleet/dispatches/${run.id}`}>{run.id}</Link>
								<br />
								<small>{run.agentId}</small>
							</dt>
							<dd>
								{run.outcome ?? run.status}
								<br />
								{run.targetId} / {run.wireModelId}
							</dd>
							<dd>{run.tokenCount} tokens</dd>
						</div>
					))}
			</dl>
			{runs.hasNextPage && (
				<button type="button" disabled={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
					Load more dispatch runs
				</button>
			)}
			<Topologies councils={councils.data} gates={gates.data} />
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
			<h1>
				{dispatch ? "Dispatch run" : "Fleet run"} · {id}
			</h1>
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
						{run.data.targetId} / {run.data.wireModelId} · {run.data.tokenCount} tokens
					</p>
					<MarkdownContent source={run.data.task} complete />
				</>
			)}
			{root.data && (
				<>
					<h2>{root.data.run.fleet}</h2>
					<p>
						{root.data.run.completedCount} / {root.data.run.stepCount} steps recorded
					</p>
					{root.data.steps.map((step) => (
						<article className="trace-panel" key={step.stepId}>
							<h3>
								{step.stepId} · {step.succeeded ? "Succeeded" : "Failed"}
							</h3>
							{step.terminalRunId && <Link to={`/fleet/dispatches/${step.terminalRunId}`}>{step.terminalRunId}</Link>}
							<p>Recorded integrity: {step.integrityValid ? "valid" : "invalid"}</p>
							{step.failureReason && <p>{step.failureReason}</p>}
							<MarkdownContent source={step.output} complete />
						</article>
					))}
					<Topologies councils={root.data.councils} gates={root.data.gates} />
				</>
			)}
			<h2>Receipt</h2>
			{artifact ? (
				<pre className="fleet-receipt">{JSON.stringify(artifact, null, 2)}</pre>
			) : (
				<p>No readable receipt recorded.</p>
			)}
		</section>
	);
}
