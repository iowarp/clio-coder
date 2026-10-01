import { useQuery } from "@tanstack/react-query";
import { memo, useMemo, useState } from "react";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { steeringAffordances } from "./composer-model.js";
import { FleetRunPanel } from "./FleetRunPanel.js";
import { FleetRunRows } from "./FleetStrip.js";
import {
	FLEET_STATE_LABELS,
	FLEET_STATE_TONES,
	fleetNotices,
	fleetRunDetail,
	isLiveRun,
	isWorkingRun,
} from "./fleet-facts.js";
import { workerGraph } from "./worker-graph-model.js";

export const WorkerGraph = memo(function WorkerGraph({
	client,
	session,
}: {
	client: Client;
	session: SessionSnapshot;
}) {
	const graph = useMemo(() => workerGraph(session.fleet), [session.fleet]);
	const notices = useMemo(() => fleetNotices(session.fleet), [session.fleet]);
	const [selected, setSelected] = useState<string | null>(null);
	const [liveOnly, setLiveOnly] = useState(false);
	const capabilities = useQuery({
		queryKey: ["session-capabilities", session.id],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: session.id }, query: {}, body: {} }),
		enabled: session.state === "open",
		staleTime: Number.POSITIVE_INFINITY,
	});
	const shown = liveOnly ? graph.nodes.filter((node) => isLiveRun(node.run)) : graph.nodes;
	const selection = graph.nodes.find((node) => node.run.runId === selected);
	const running = session.turns.at(-1)?.status === "running";
	const open = session.state === "open";
	return (
		<section className="worker-graph" aria-label="Agent activity">
			<div className="worker-graph__heading">
				<div>
					<p className="eyebrow">Live orchestration</p>
					<h2>
						Working together<span className="period">.</span>
					</h2>
				</div>
				<Icon name="fleet" />
			</div>
			<dl className="worker-graph__stats">
				<div>
					<dt>Active</dt>
					<dd>{graph.active}</dd>
				</div>
				<div>
					<dt>Complete</dt>
					<dd>{graph.completed}</dd>
				</div>
				<div>
					<dt>Failed</dt>
					<dd>{graph.failed}</dd>
				</div>
			</dl>
			<div className="worker-graph__root">
				<Icon name="sessions" />
				<div>
					<strong>Clio Coder</strong>
					<small>Main conversation</small>
				</div>
				<StatusMark live={running && open} tone={running ? "running" : "neutral"} label={running ? "Working" : "Idle"} />
			</div>
			{graph.nodes.length > 0 ? (
				<>
					<div className="worker-graph__filter">
						<span>
							{shown.length} of {graph.nodes.length} recorded runs
						</span>
						<button type="button" aria-pressed={liveOnly} onClick={() => setLiveOnly(!liveOnly)}>
							Active only
						</button>
					</div>
					<ol className="worker-graph__nodes" aria-label="Dispatched workers">
						{shown.map(({ run, depth, parentRunId, missingParent }) => (
							<li key={run.runId} style={{ paddingInlineStart: `${Math.min(depth, 4) * 12}px` }}>
								<button
									className="worker-node"
									type="button"
									aria-expanded={selected === run.runId}
									aria-label={`Inspect ${run.agentId}: ${FLEET_STATE_LABELS[run.state]}`}
									data-selected={selected === run.runId}
									data-state={run.state}
									onClick={() => setSelected(selected === run.runId ? null : run.runId)}
								>
									<span className="worker-node__light" aria-hidden="true" />
									<span className="worker-node__body">
										<strong>{run.agentId}</strong>
										<small>{run.taskPreview ?? "Task preview not reported"}</small>
										{parentRunId ? (
											<small>
												From{" "}
												{missingParent
													? `earlier run ${missingParent}`
													: graph.nodes.find((node) => node.run.runId === parentRunId)?.run.agentId}
											</small>
										) : null}
										{run.node ? <code>{run.node}</code> : null}
									</span>
									<StatusMark
										live={open && isWorkingRun(run)}
										tone={FLEET_STATE_TONES[run.state]}
										label={FLEET_STATE_LABELS[run.state]}
									/>
								</button>
								{selected === run.runId && selection ? (
									<div className="worker-graph__detail">
										<p>{fleetRunDetail(run)}</p>
										<code title={run.runId}>{run.runId}</code>
										<FleetRunRows
											runs={[run]}
											sessionOpen={open}
											steering={
												open && steeringAffordances(capabilities.data).dispatch ? { client, sessionId: session.id } : undefined
											}
										/>
									</div>
								) : null}
							</li>
						))}
					</ol>
					{shown.length === 0 ? <p className="session-panel-empty">Every recorded worker has settled.</p> : null}
				</>
			) : (
				<div className="session-panel-empty">
					<Icon name="fleet" />
					<h3>Room for the whole team.</h3>
					<p>
						Dispatched workers appear here as Clio assigns work. Follow each run, inspect its results, or send live guidance.
					</p>
				</div>
			)}
			{notices.length ? (
				<section className="worker-graph__notices" aria-label="Engine notices">
					{notices.map((notice) => (
						<p key={notice.id}>
							<StatusMark tone={notice.presentation.tone} label={notice.presentation.label} />
							<span>{notice.presentation.summary}</span>
							<small>{formatTime(notice.at)}</small>
						</p>
					))}
				</section>
			) : null}
			<FleetRunPanel
				client={client}
				sessionId={session.id}
				sessionOpen={session.state === "open"}
				capabilities={capabilities.data}
				running={running}
			/>
		</section>
	);
});
