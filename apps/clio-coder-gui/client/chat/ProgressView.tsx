import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { formatCost } from "../api/clock.js";
import { Icon } from "../design/icons.js";
import { ClioPulse } from "../shell/ClioMark.js";
import { boardView, type PlanRow } from "./board-model.js";
import { changeCounts, summarizeChanges } from "./changes-model.js";
import { foldFleetRuns, isLiveRun } from "./fleet-facts.js";
import { compactCount, compactDuration, taskOverview } from "./overview-model.js";
import type { PaneSession, PaneView } from "./pane-model.js";

function PlanGlyph({ tone }: { tone: PlanRow["tone"] }) {
	if (tone === "success")
		return (
			<span className="pane-step__glyph is-done" aria-hidden="true">
				<Icon name="check" />
			</span>
		);
	if (tone === "running") return <ClioPulse size={16} />;
	if (tone === "fail" || tone === "warn") return <span className="pane-step__glyph is-blocked" aria-hidden="true" />;
	return <span className="pane-step__glyph" aria-hidden="true" />;
}

/**
 * How the task is going: what it set out to do, the plan Clio reported, what it changed, and who is
 * working on it. Nothing here is measured by the browser; each line is a value the session reported.
 */
export function ProgressView({
	client,
	session,
	title,
	workspaceRoot,
	nowMs,
	onOpen,
}: {
	client: Client;
	session: PaneSession;
	title: string;
	workspaceRoot: string | undefined;
	nowMs: number;
	onOpen: (view: PaneView) => void;
}) {
	const params = { params: { id: session.id }, query: {}, body: {} };
	const open = session.state === "open";
	const capabilities = useQuery({
		queryKey: ["session-capabilities", session.id],
		queryFn: () => client.call(routes.sessionCapabilities, params),
		enabled: open,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	const settled = session.turns.filter((turn) => turn.status !== "running").length;
	const board = useQuery({
		queryKey: ["session-board", session.id, settled],
		queryFn: () => client.call(routes.sessionBoard, params),
		enabled: open && capabilities.data?.board !== undefined,
		retry: false,
	});
	const plan = board.data ? boardView(board.data).plan : null;
	const overview = useMemo(() => taskOverview(session.turns, nowMs), [session.turns, nowMs]);
	const changes = useMemo(() => summarizeChanges(session.tools, workspaceRoot), [session.tools, workspaceRoot]);
	const liveWorkers = useMemo(() => foldFleetRuns(session.fleet).filter(isLiveRun).length, [session.fleet]);
	const last = session.turns.at(-1);
	const state = overview.running
		? "Working"
		: last?.status === "failed"
			? "Failed"
			: last?.status === "cancelled"
				? "Stopped"
				: last
					? "Complete"
					: "Not started";
	const done = plan?.rows.filter((row) => row.tone === "success").length ?? 0;
	const facts = [
		`${overview.turns} ${overview.turns === 1 ? "turn" : "turns"}`,
		overview.elapsedMs >= 1000 ? compactDuration(overview.elapsedMs) : null,
		overview.tokens > 0 ? `${compactCount(overview.tokens)} tokens` : null,
		overview.costUsd !== null && overview.costUsd > 0 ? formatCost(overview.costUsd) : null,
	].filter(Boolean);
	return (
		<div className="pane-cards">
			<section className="pane-card" aria-labelledby="pane-goal">
				<header>
					<h2 id="pane-goal">Task</h2>
					<span className="pane-card__state" data-state={state}>
						{overview.running ? <ClioPulse size={12} /> : null}
						{state}
					</span>
				</header>
				<p className="pane-goal">{title}</p>
				{overview.turns > 0 ? <p className="pane-card__facts">{facts.join(" · ")}</p> : null}
			</section>

			<section className="pane-card" aria-labelledby="pane-plan">
				<header>
					<h2 id="pane-plan">Plan</h2>
					{plan && plan.rows.length > 0 ? (
						<span className="pane-card__state">
							{done}/{plan.rows.length}
						</span>
					) : null}
				</header>
				{plan && plan.rows.length > 0 ? (
					<ol className="pane-steps">
						{plan.rows.map((row) => (
							<li key={row.id} data-tone={row.tone}>
								<PlanGlyph tone={row.tone} />
								<span>
									{row.title}
									{row.reason ? <small>{row.reason}</small> : null}
								</span>
							</li>
						))}
					</ol>
				) : (
					<p className="pane-empty">
						{capabilities.data?.board === undefined
							? "This session does not report a plan."
							: "Clio has not published a plan for this task yet."}
					</p>
				)}
			</section>

			<section className="pane-card" aria-labelledby="pane-changes">
				<header>
					<h2 id="pane-changes">Changes</h2>
					{changes.files.length > 0 ? (
						<button type="button" className="pane-link" onClick={() => onOpen("changes")}>
							Review
						</button>
					) : null}
				</header>
				{changes.files.length > 0 ? (
					<p className="pane-changes-line">
						{changes.files.length} {changes.files.length === 1 ? "file" : "files"} changed{" "}
						<span className="diffstat">
							<span className="diffstat__add">+{changes.adds}</span> <span className="diffstat__del">−{changes.dels}</span>
						</span>
						<span className="sr-only">{changeCounts(changes)}</span>
					</p>
				) : (
					<p className="pane-empty">No files changed yet.</p>
				)}
			</section>

			{liveWorkers > 0 ? (
				<section className="pane-card" aria-labelledby="pane-agents">
					<header>
						<h2 id="pane-agents">Agents</h2>
						<button type="button" className="pane-link" onClick={() => onOpen("agents")}>
							Open
						</button>
					</header>
					<p className="pane-changes-line">
						{liveWorkers} {liveWorkers === 1 ? "worker is" : "workers are"} running
					</p>
				</section>
			) : null}
		</div>
	);
}
