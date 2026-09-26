import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { isAwaitingAnswer } from "../chat/approval-model.js";
import { StatusMark, type StatusTone } from "../design/status.js";
import { ProjectOpenForm, useProjectLaunch } from "./project-open.js";
import "./projects.css";

const RECENT_PROJECTS = 5;

function sessionState(session: SessionSnapshot): { tone: StatusTone; label: string } {
	const last = session.turns.at(-1);
	if (session.permissions.some(isAwaitingAnswer)) return { tone: "warn", label: "Approval needed" };
	if (session.state === "starting") return { tone: "running", label: "Starting" };
	if (last?.status === "running") return { tone: "running", label: "Working" };
	if (last?.status === "failed") return { tone: "fail", label: "Last turn failed" };
	if (last?.status === "cancelled") return { tone: "neutral", label: "Last turn stopped" };
	return { tone: "success", label: "Ready" };
}

/**
 * The front door. Someone arriving here wants to get to work, so the page leads with the project
 * folder field (a first visit reaches a conversation in two actions), then the open conversations and
 * the recent projects, each one action away from a conversation. Inspection and configuration live in
 * the rail and are not repeated here.
 */
export function Home({ client }: { client: Client }) {
	const launch = useProjectLaunch(client);
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const open = sessions.data?.filter((session) => session.state === "open" || session.state === "starting") ?? [];
	const names = new Map(workspaces.data?.map((workspace) => [workspace.id, workspace.name]) ?? []);
	const projects = [...(workspaces.data ?? [])]
		.sort((a, b) => b.openedAt.localeCompare(a.openedAt))
		.slice(0, RECENT_PROJECTS);
	return (
		<section className="home">
			<div className="home-hero">
				<div className="home-hero__intro">
					<p className="eyebrow">Clio Coder / your local workspace</p>
					<h1>
						From a question
						<br />
						<em>to a working answer.</em>
					</h1>
					<p className="intro">
						Work with Clio Coder in your own projects. Follow the conversation, review each consequential action, and inspect
						the evidence behind the result.
					</p>
					<ProjectOpenForm client={client} launch={launch} />
				</div>
				<section className="home-resume" aria-labelledby="home-resume-title">
					<div className="home-resume__heading">
						<div>
							<p className="eyebrow">Your work</p>
							<h2 id="home-resume-title">Continue where you left off</h2>
						</div>
						<Link to="/sessions">
							All projects <span aria-hidden="true">→</span>
						</Link>
					</div>
					{sessions.isPending || workspaces.isPending ? <p className="home-resume__empty">Loading your work…</p> : null}
					{sessions.error || workspaces.error || launch.error ? (
						<p role="alert">{sessions.error?.message ?? workspaces.error?.message ?? launch.error?.message}</p>
					) : null}
					{open.length > 0 ? (
						<div className="home-resume__grid">
							{open.map((session) => {
								const state = sessionState(session);
								return (
									<Link className="home-session" to={`/sessions/${session.id}`} key={session.id}>
										<span className="home-session__project">{names.get(session.workspaceId) ?? "Project"}</span>
										<strong>{session.label ?? session.turns[0]?.prompt ?? "New conversation"}</strong>
										<span className="home-session__foot">
											<StatusMark tone={state.tone} label={state.label} />
											<span aria-hidden="true">→</span>
										</span>
									</Link>
								);
							})}
						</div>
					) : null}
					{projects.length > 0 ? (
						<ul className="home-projects" aria-label="Recent projects">
							{projects.map((workspace) => (
								<li className="home-project" key={workspace.id}>
									<div className="home-project__text">
										<Link to={`/workspaces/${workspace.id}/sessions`} className="home-project__name">
											{workspace.name}
										</Link>
										<span className="home-project__path" title={workspace.path}>
											{workspace.path}
										</span>
										<span className="home-project__time">Opened {formatTime(workspace.openedAt)}</span>
									</div>
									<button
										type="button"
										disabled={launch.busy}
										onClick={() => launch.start(workspace.id)}
										aria-label={`New conversation in ${workspace.name}`}
									>
										{launch.starting === workspace.id ? "Starting…" : "New conversation"}
									</button>
								</li>
							))}
						</ul>
					) : !workspaces.isPending && !workspaces.error && open.length === 0 ? (
						<p className="home-resume__empty">
							No project has been opened yet. Choose its folder to start your first conversation.
						</p>
					) : null}
				</section>
			</div>
		</section>
	);
}
