import { useQuery } from "@tanstack/react-query";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Workspace } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { foldFleetRuns, isLiveRun } from "../chat/fleet-facts.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { useSetupStatus } from "../pages/target-onboarding.js";
import { setAsideExpanded } from "./aside-state.js";
import { useShell } from "./shell-context.js";
import { isHeld, isUntouched, STATE_LABELS, taskState, taskTitle } from "./shell-model.js";
import "../chat/pane.css";

/**
 * The right sidebar before a task is open: the project the next task starts in, the connection it will
 * use, and what is already running anywhere. Every line is a read the rest of the app already makes.
 */
export function HomeAside({ client, workspace }: { client: Client; workspace: Workspace | null }) {
	const slot = useShell()?.asideSlot ?? null;
	const setup = useSetupStatus(client, true, workspace?.id ?? null);
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	if (!slot) return null;
	const names = new Map((workspaces.data ?? []).map((item) => [item.id, item.name]));
	const live = (sessions.data ?? []).filter((session) => isHeld(session) && !isUntouched(session));
	// "Running now" means work in motion or work waiting on the operator. An open task that sits idle
	// is in the rail; listing it here made the heading untrue and left its row without a mark.
	const active = live
		.map((session) => ({ session, state: taskState(session) }))
		.filter(({ state }) => state === "working" || state === "waiting" || state === "starting" || state === "approval");
	const workers = live.reduce((sum, session) => sum + foldFleetRuns(session.fleet).filter(isLiveRun).length, 0);
	const status = setup.data;
	return createPortal(
		<aside className="pane" aria-label="Project overview">
			<div className="pane__inner">
				<header className="pane__head">
					<h2 className="pane__title">
						<Icon name="overview" /> Overview
					</h2>
					<button
						type="button"
						className="wb-icon"
						onClick={() => setAsideExpanded(false)}
						aria-label="Hide right sidebar"
						title="Hide right sidebar"
					>
						<Icon name="panelRight" />
					</button>
				</header>
				<div className="pane__body">
					<div className="pane-cards">
						<section className="pane-card" aria-labelledby="aside-project">
							<header>
								<h2 id="aside-project" className="pane-card__heading">
									<span className="pane-card__symbol">
										<Icon name="folder" />
									</span>
									Project
								</h2>
								{workspace ? (
									<Link className="pane-link" to={`/workspaces/${workspace.id}/sessions`}>
										All tasks
									</Link>
								) : null}
							</header>
							{workspace ? (
								<>
									<p className="pane-goal">{workspace.name}</p>
									<p className="pane-path" title={workspace.path}>
										<bdi dir="ltr">{workspace.path}</bdi>
									</p>
								</>
							) : (
								<p className="pane-empty">Open a workspace to start a task in it.</p>
							)}
						</section>

						<section className="pane-card" aria-labelledby="aside-model">
							<header>
								<h2 id="aside-model" className="pane-card__heading">
									<span className="pane-card__symbol">
										<Icon name="models" />
									</span>
									Model
								</h2>
								<Link className="pane-link" to="/settings/models">
									Change
								</Link>
							</header>
							{status ? (
								status.state === "ready" ? (
									<p className="pane-changes-line">
										<StatusMark tone="success" label={status.targetId ?? "Connected"} />{" "}
										{status.model ? <span className="pane-mono">{status.model}</span> : null}
									</p>
								) : (
									<p className="pane-changes-line">
										<StatusMark tone="warn" label={status.targetId ?? "Not connected"} /> {status.message}
									</p>
								)
							) : (
								<p className="pane-empty">Reading the connection…</p>
							)}
						</section>

						<section className="pane-card" aria-labelledby="aside-running">
							<header>
								<h2 id="aside-running" className="pane-card__heading">
									<span className="pane-card__symbol">
										<Icon name="running" />
									</span>
									Running now
								</h2>
								{workers > 0 ? (
									<span className="pane-card__state">
										{workers} {workers === 1 ? "worker" : "workers"}
									</span>
								) : null}
							</header>
							{active.length > 0 ? (
								<ul className="pane-agents">
									{active.slice(0, 8).map(({ session, state }) => (
										<li key={session.id}>
											{state === "approval" ? (
												<span className="wb-dot wb-dot--approval" aria-hidden="true" />
											) : (
												<span className="pane-agents__glyph" aria-hidden="true">
													▸
												</span>
											)}
											<Link to={`/sessions/${session.id}`}>{taskTitle(session)}</Link>
											{/* The heading and the mark say it is running, so the row names where; a task
											    that waits on the operator says so instead. */}
											<span>
												{state === "approval" || state === "waiting"
													? STATE_LABELS[state]
													: (names.get(session.workspaceId) ?? STATE_LABELS[state])}
											</span>
										</li>
									))}
								</ul>
							) : (
								<p className="pane-empty">No task is running.</p>
							)}
						</section>
					</div>
				</div>
			</div>
		</aside>,
		slot,
	);
}
