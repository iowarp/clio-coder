import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { Link, useNavigate } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import { type Client, emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { sessionBuffer } from "../api/sessions.js";
import { isAwaitingAnswer } from "../chat/approval.js";
import { StatusMark, type StatusTone } from "../design/status.js";

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
 * The front door. Someone arriving here wants to get back to work, so the page leads with the open
 * conversations and the recent projects, each one action away from a conversation. Inspection and
 * configuration are linked below, not in front.
 */
export function Home({ client }: { client: Client }) {
	const navigate = useNavigate();
	const queries = useQueryClient();
	const starting = useRef(false);
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const start = useMutation({
		mutationFn: (workspaceId: string) =>
			client.call(routes.newSession, { params: { id: workspaceId }, query: {}, body: {} }),
		onSuccess: (session) => {
			sessionBuffer(session.id).snapshot(session);
			queries.setQueryData(["session", session.id], session);
			void queries.invalidateQueries({ queryKey: ["sessions"] });
			void navigate(`/sessions/${session.id}`);
		},
		onSettled: () => {
			starting.current = false;
		},
	});
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
					<Link className="primary home-link" to="/sessions">
						Open a project <span aria-hidden="true">↗</span>
					</Link>
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
					{sessions.error || workspaces.error || start.error ? (
						<p role="alert">{sessions.error?.message ?? workspaces.error?.message ?? start.error?.message}</p>
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
										disabled={start.isPending}
										onClick={() => {
											if (starting.current) return;
											starting.current = true;
											start.mutate(workspace.id);
										}}
									>
										{start.isPending && start.variables === workspace.id ? "Starting…" : "New conversation"}
									</button>
								</li>
							))}
						</ul>
					) : !workspaces.isPending && !workspaces.error && open.length === 0 ? (
						<p className="home-resume__empty">
							No project has been opened yet. Open a project folder to start your first conversation.
						</p>
					) : null}
				</section>
			</div>

			<div className="home-instruments">
				<Link to="/traces">
					<span className="eyebrow">Evidence</span>
					<h2>See what happened.</h2>
					<p>Inspect phases, tool calls, receipts, and recorded outcomes.</p>
					<span aria-hidden="true">↗</span>
				</Link>
				<Link to="/settings">
					<span className="eyebrow">Configuration</span>
					<h2>Make it yours.</h2>
					<p>Review and adjust the settings Clio Coder uses for your projects.</p>
					<span aria-hidden="true">↗</span>
				</Link>
				<Link to="/docs">
					<span className="eyebrow">Guide</span>
					<h2>Learn how it works.</h2>
					<p>Read how Clio Coder routes work, asks for approval, and records evidence.</p>
					<span aria-hidden="true">↗</span>
				</Link>
			</div>
		</section>
	);
}
