import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";
import { isAwaitingAnswer } from "../chat/approval.js";
import { StatusMark, type StatusTone } from "../design/status.js";

export function Home({ client }: { client: Client }) {
	const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => client.call(routes.sessions, emptyInput) });
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const open = sessions.data?.filter((session) => session.state === "open" || session.state === "starting") ?? [];
	const names = new Map(workspaces.data?.map((workspace) => [workspace.id, workspace.name]) ?? []);
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
							<h2 id="home-resume-title">Continue a conversation</h2>
						</div>
						<Link to="/sessions">
							All projects <span aria-hidden="true">→</span>
						</Link>
					</div>
					{sessions.isPending ? <p className="home-resume__empty">Loading conversations…</p> : null}
					{sessions.error ? <p role="alert">{sessions.error.message}</p> : null}
					{open.length > 0 ? (
						<div className="home-resume__grid">
							{open.map((session) => {
								const last = session.turns.at(-1);
								const waiting = session.permissions.some(isAwaitingAnswer);
								let tone: StatusTone = "success";
								let label = "Ready";
								if (waiting) {
									tone = "warn";
									label = "Approval needed";
								} else if (session.state === "starting" || last?.status === "running") {
									tone = "running";
									label = session.state === "starting" ? "Starting" : "Working";
								} else if (last?.status === "failed") {
									tone = "fail";
									label = "Last turn failed";
								} else if (last?.status === "cancelled") {
									tone = "neutral";
									label = "Last turn stopped";
								}
								return (
									<Link className="home-session" to={`/sessions/${session.id}`} key={session.id}>
										<span className="home-session__project">{names.get(session.workspaceId) ?? "Project"}</span>
										<strong>{session.label ?? session.turns[0]?.prompt ?? "New conversation"}</strong>
										<span className="home-session__foot">
											<StatusMark tone={tone} label={label} />
											<span aria-hidden="true">→</span>
										</span>
									</Link>
								);
							})}
						</div>
					) : !sessions.isPending && !sessions.error ? (
						<p className="home-resume__empty">No conversation is open. Choose a project to start or load one.</p>
					) : null}
				</section>
			</div>

			<div className="home-instruments">
				<Link to="/sessions">
					<span className="eyebrow">01 / Conversation</span>
					<h2>Make progress.</h2>
					<p>Start a session or return to a saved conversation.</p>
					<span aria-hidden="true">↗</span>
				</Link>
				<Link to="/traces">
					<span className="eyebrow">02 / Evidence</span>
					<h2>See what happened.</h2>
					<p>Inspect phases, tool calls, receipts, and recorded outcomes.</p>
					<span aria-hidden="true">↗</span>
				</Link>
				<Link to="/settings">
					<span className="eyebrow">03 / Configuration</span>
					<h2>Make it yours.</h2>
					<p>Review and adjust the settings Clio Coder uses for your projects.</p>
					<span aria-hidden="true">↗</span>
				</Link>
			</div>
		</section>
	);
}
