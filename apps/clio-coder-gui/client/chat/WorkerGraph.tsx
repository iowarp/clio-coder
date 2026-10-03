import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { StatusMark, TONE_GLYPHS } from "../design/status.js";
import { steeringAffordances } from "./composer-model.js";
import { FleetRunPanel } from "./FleetRunPanel.js";
import { RunSteer, type RunSteering } from "./FleetStrip.js";
import {
	FLEET_STATE_LABELS,
	FLEET_STATE_TONES,
	fleetEvidence,
	fleetNotices,
	fleetRunDetail,
	isLiveRun,
} from "./fleet-facts.js";
import {
	dispatchRecordPath,
	noticeClock,
	runFacts,
	shownDepths,
	type TreeGuide,
	treeGuides,
	type WorkerNode,
	workerGraph,
} from "./worker-graph-model.js";
import "./agents.css";

/** Indentation stops here so a deep chain never squeezes the task text out of a narrow pane. */
const MAX_DEPTH = 4;

/** The run id as an exact value the operator can carry to a terminal or a report. */
function CopyRunId({ runId }: { runId: string }) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (timer.current !== null) clearTimeout(timer.current);
		},
		[],
	);
	const copy = async () => {
		let next: "copied" | "failed" = "failed";
		try {
			await navigator.clipboard.writeText(runId);
			next = "copied";
		} catch {
			// A page served over plain http has no clipboard API; the id stays selectable as text.
		}
		setState(next);
		if (timer.current !== null) clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), 1_600);
	};
	return (
		<span className="agents-runid">
			<code title={runId}>{runId}</code>
			<button
				type="button"
				className="agents-quiet"
				onClick={() => void copy()}
				aria-label={state === "copied" ? "Run id copied" : state === "failed" ? "Copy failed" : "Copy run id"}
			>
				{state === "idle" ? <Icon name="copy" /> : state === "copied" ? "Copied" : "Copy failed"}
			</button>
		</span>
	);
}

function RunNode({
	node,
	depth,
	guide,
	parentAgent,
	expanded,
	onToggle,
	steering,
}: {
	node: WorkerNode;
	/** The drawn depth, capped so a deep chain keeps its task text readable. */
	depth: number;
	guide: TreeGuide;
	parentAgent: string | null;
	expanded: boolean;
	onToggle: () => void;
	steering: RunSteering | undefined;
}) {
	const { run, missingParent } = node;
	const detailId = useId();
	const facts = runFacts(run);
	return (
		<li
			className="agents-node"
			data-state={run.state}
			data-open={expanded ? "yes" : undefined}
			style={{ "--depth": depth } as CSSProperties}
		>
			<span className="agents-guides" aria-hidden="true">
				{guide.through.map((level) => (
					<span key={level} data-line="through" style={{ "--level": level } as CSSProperties} />
				))}
				<span data-line={guide.continues ? "through" : "end"} style={{ "--level": depth } as CSSProperties} />
				<span data-line="tick" style={{ "--level": depth } as CSSProperties} />
				{guide.opens ? <span data-line="start" style={{ "--level": depth + 1 } as CSSProperties} /> : null}
			</span>
			<div className="agents-node__row">
				<button
					type="button"
					className="agents-node__toggle"
					aria-expanded={expanded}
					aria-controls={detailId}
					onClick={onToggle}
				>
					<span className="agents-node__head">
						<span className="agents-node__agent">{run.agentId}</span>
						{/* A glyph and a word per run; the tree's root row carries the one moving mark. */}
						<StatusMark tone={FLEET_STATE_TONES[run.state]} label={FLEET_STATE_LABELS[run.state]} />
					</span>
					<span className="agents-node__line">
						<span className="agents-node__task">{run.taskPreview ?? "No task preview was reported."}</span>
						{facts === null ? null : <span className="agents-node__facts">{facts}</span>}
					</span>
				</button>
				<Link
					className="agents-quiet agents-node__record"
					to={dispatchRecordPath(run.runId)}
					aria-label={`Open the dispatch record for ${run.agentId}`}
					title="Dispatch record"
				>
					<Icon name="external" />
				</Link>
			</div>
			{expanded ? (
				<div className="agents-node__detail" id={detailId}>
					<dl>
						<div>
							<dt>Run</dt>
							<dd>
								<CopyRunId runId={run.runId} />
							</dd>
						</div>
						{facts === null ? null : (
							<div>
								<dt>State</dt>
								<dd>{fleetRunDetail(run)}</dd>
							</div>
						)}
						{parentAgent !== null || missingParent !== null ? (
							<div>
								<dt>From</dt>
								<dd>{missingParent !== null ? `earlier run ${missingParent}` : parentAgent}</dd>
							</div>
						) : null}
						{run.node === null ? null : (
							<div>
								<dt>Node</dt>
								<dd>{run.node}</dd>
							</div>
						)}
						{run.attempt !== null && run.attempt > 1 ? (
							<div>
								<dt>Attempt</dt>
								<dd>{run.attempt}</dd>
							</div>
						) : null}
						{run.tokenCount === null ? null : (
							<div>
								<dt>Tokens</dt>
								<dd>{run.tokenCount.toLocaleString("en-US")}</dd>
							</div>
						)}
					</dl>
					{steering !== undefined && isLiveRun(run) ? <RunSteer run={run} steering={steering} /> : null}
				</div>
			) : null}
		</li>
	);
}

const figure = (count: number, tone: "running" | "success" | "fail") => (count > 0 ? tone : undefined);

export const WorkerGraph = memo(function WorkerGraph({
	client,
	session,
}: {
	client: Client;
	session: SessionSnapshot;
}) {
	const graph = useMemo(() => workerGraph(session.fleet), [session.fleet]);
	const notices = useMemo(() => fleetNotices(session.fleet), [session.fleet]);
	const evidence = useMemo(() => new Map(fleetEvidence(session.fleet).map((row) => [row.id, row])), [session.fleet]);
	const [selected, setSelected] = useState<string | null>(null);
	const [liveOnly, setLiveOnly] = useState(false);
	const noticesId = useId();
	const capabilities = useQuery({
		queryKey: ["session-capabilities", session.id],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: session.id }, query: {}, body: {} }),
		enabled: session.state === "open",
		staleTime: Number.POSITIVE_INFINITY,
	});
	const agents = useMemo(() => new Map(graph.nodes.map((node) => [node.run.runId, node.run.agentId])), [graph.nodes]);
	const shown = liveOnly ? graph.nodes.filter((node) => isLiveRun(node.run)) : graph.nodes;
	const depths = shownDepths(shown).map((depth) => Math.min(depth, MAX_DEPTH));
	const guides = treeGuides(depths);
	const running = session.turns.at(-1)?.status === "running";
	const open = session.state === "open";
	const steering =
		open && steeringAffordances(capabilities.data).dispatch ? { client, sessionId: session.id } : undefined;
	return (
		<div className="pane-drill worker-graph">
			<div className="agents-stats">
				<dl>
					<div data-tone={figure(graph.active, "running")}>
						<dt>live</dt>
						<dd>{graph.active}</dd>
					</div>
					<div data-tone={figure(graph.completed, "success")}>
						<dt>done</dt>
						<dd>{graph.completed}</dd>
					</div>
					<div data-tone={figure(graph.failed, "fail")}>
						<dt>failed</dt>
						<dd>{graph.failed}</dd>
					</div>
				</dl>
				{graph.nodes.length > 0 ? (
					<button type="button" className="agents-filter" aria-pressed={liveOnly} onClick={() => setLiveOnly(!liveOnly)}>
						Active only
					</button>
				) : null}
			</div>
			<div className="agents-tree">
				<div className="agents-root" data-opens={shown.length > 0 ? "yes" : undefined}>
					<span className="agents-root__dot" aria-hidden="true" />
					<span className="agents-root__name">Clio Coder</span>
					<span className="agents-root__role">main conversation</span>
					<StatusMark live={running && open} tone={running ? "running" : "neutral"} label={running ? "Working" : "Idle"} />
				</div>
				{shown.length > 0 ? (
					<ol aria-label="Dispatched agents">
						{shown.map((node, index) => (
							<RunNode
								key={node.run.runId}
								node={node}
								depth={depths[index] ?? 0}
								guide={guides[index] ?? { through: [], continues: false, opens: false }}
								parentAgent={node.parentRunId === null ? null : (agents.get(node.parentRunId) ?? null)}
								expanded={selected === node.run.runId}
								onToggle={() => setSelected(selected === node.run.runId ? null : node.run.runId)}
								steering={steering}
							/>
						))}
					</ol>
				) : null}
			</div>
			{graph.nodes.length === 0 ? (
				<p className="pane-empty agents-empty">No agents have been dispatched in this task.</p>
			) : shown.length === 0 ? (
				<p className="pane-empty agents-empty">Every dispatched agent has settled.</p>
			) : null}
			{notices.length > 0 ? (
				<section className="agents-section agents-notices" aria-labelledby={noticesId}>
					<h3 className="agents-eyebrow" id={noticesId}>
						Engine notices
					</h3>
					<ol>
						{notices.map((notice) => {
							const stamp = noticeClock(notice.at);
							return (
								<li key={notice.id} data-tone={notice.presentation.tone}>
									<span className="agents-notices__mark" aria-hidden="true">
										{TONE_GLYPHS[notice.presentation.tone]}
									</span>
									<span className="agents-notices__text">
										<strong>{notice.presentation.label}</strong> {notice.presentation.summary}
										{evidence.has(notice.id) ? (
											<Link
												className="agents-notices__link"
												to={`/evidence/${encodeURIComponent(evidence.get(notice.id)?.evidenceId ?? "")}`}
											>
												Open evidence
											</Link>
										) : null}
									</span>
									<time dateTime={notice.at} title={stamp.full}>
										{stamp.short}
									</time>
								</li>
							);
						})}
					</ol>
				</section>
			) : null}
			<FleetRunPanel
				client={client}
				sessionId={session.id}
				sessionOpen={open}
				capabilities={capabilities.data}
				running={running}
			/>
		</div>
	);
});
