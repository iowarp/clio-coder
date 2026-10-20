import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo, useMemo, useRef, useState } from "react";
import { Link, useOutletContext, useSearchParams } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { SessionOverviewItem } from "../../contracts/session-overview.js";
import type { Client } from "../api/client.js";
import { emptyInput } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import type { ConnectionState } from "../api/events.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { Dialog } from "../interaction/Dialog.js";
import { useShell } from "../shell/shell-context.js";
import { TopBar } from "../shell/TopBar.js";
import { useSessionOverview, useTaskActions } from "../shell/tasks.js";
import type { SessionFilter } from "./mission-control-model.js";
import { ACTIVITY, SESSION_FILTERS, sessionInventory } from "./mission-control-model.js";
import "./mission-control.css";

const FILTER_NAMES: Readonly<Record<SessionFilter, string>> = {
	all: "All sessions",
	attention: "Needs you",
	working: "Working",
	ready: "Ready & paused",
	closed: "Closed",
};

export function MissionControl({ client }: { client: Client }) {
	const [search, setSearch] = useSearchParams();
	const connection = useOutletContext<ConnectionState>();
	const shell = useShell();
	const actions = useTaskActions(client);
	const startTask = () => actions.newTask(project || shell?.activeWorkspaceId || undefined);
	const selection = search.get("status");
	const filter = SESSION_FILTERS.find((value) => value === selection) ?? "all";
	const query = search.get("q") ?? "";
	const project = search.get("workspace") ?? "";
	const set = (key: string, value: string) =>
		setSearch(
			(previous) => {
				const next = new URLSearchParams(previous);
				if (value) next.set(key, value);
				else next.delete(key);
				return next;
			},
			{ replace: true },
		);
	const overview = useSessionOverview(client);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const items = overview.data?.sessions;
	const projects = workspaces.data;
	const shown = useMemo(
		() => sessionInventory(items ?? [], projects ?? [], query, project, filter),
		[items, projects, query, project, filter],
	);
	const counts = { attention: 0, working: 0, ready: 0, closed: 0, workers: 0 };
	let workersComplete = true;
	for (const item of items ?? []) {
		const group = ACTIVITY[item.activity].group;
		if (group !== "all") counts[group]++;
		counts.workers += item.activeWorkers;
		workersComplete &&= item.workersComplete;
	}
	const connected = connection === "Connected";
	return (
		<>
			<TopBar title="Sessions">
				<span className="wb-bar__spacer" />
				<Link className="wb-icon wb-icon--text" to="/traces">
					<Icon name="traces" />
					<span>Trace replay</span>
				</Link>
				<Link className="wb-icon wb-icon--text" to="/evidence">
					<Icon name="evidence" />
					<span>Evidence</span>
				</Link>
				<Link className="wb-icon wb-icon--text" to="/machines">
					<Icon name="system" />
					<span>Machines</span>
				</Link>
				<button
					type="button"
					className="wb-icon wb-icon--text"
					disabled={overview.isFetching}
					onClick={() => void overview.refetch()}
				>
					<Icon name="clock" />
					<span>{overview.isFetching ? "Updating…" : "Refresh"}</span>
				</button>
				<button type="button" className="primary" onClick={startTask}>
					<Icon name="plus" />
					Start task
				</button>
			</TopBar>
			<div className="mission">
				<div className="mission__inner">
					<header className="mission__heading">
						<div>
							<p className="eyebrow">Your research, in motion</p>
							<h2>
								One place for <em>every session.</em>
							</h2>
							<p>Follow your work across projects. Pick up where you're needed.</p>
						</div>
						<span className="mission__connection">
							<StatusMark tone={connected ? "success" : "warn"} label={connection} />
							<span>
								<Icon name="system" />
								{overview.data?.host ?? "This Clio server"}
							</span>
						</span>
					</header>
					{!connected ? (
						<p className="mission__notice" role="status">
							Session status may be out of date while the connection recovers. Controls return when Clio reconnects.
						</p>
					) : null}
					<div className="mission__figures">
						{(
							[
								["attention", "Needs you", counts.attention, "Approval, questions or recovery"],
								["working", "Working", counts.working, "Running, starting or queued"],
								["ready", "Ready to continue", counts.ready, "Idle or paused sessions"],
							] as const
						).map(([key, label, value, detail]) => (
							<button
								key={key}
								type="button"
								aria-pressed={filter === key}
								onClick={() => set("status", filter === key ? "" : key)}
							>
								<span>{label}</span>
								<strong>{items ? value : "—"}</strong>
								<small>{detail}</small>
							</button>
						))}
						<div>
							<span>Active workers</span>
							<strong>{items ? `${counts.workers}${workersComplete ? "" : "+"}` : "—"}</strong>
							<small>
								{workersComplete ? "Reported by supervised sessions" : "Partial worker count; open sessions for details"}
							</small>
						</div>
					</div>
					<div className="mission__toolbar">
						<label className="mission__search">
							<Icon name="search" />
							<span className="sr-only">Search sessions</span>
							<input
								type="search"
								value={query}
								maxLength={256}
								onChange={(event) => set("q", event.target.value)}
								placeholder="Find a session, project, model or machine…"
							/>
						</label>
						<label>
							<span className="sr-only">Filter project</span>
							<select value={project} onChange={(event) => set("workspace", event.target.value)}>
								<option value="">All projects</option>
								{project && !projects?.some((workspace) => workspace.id === project) ? (
									<option value={project}>Unavailable project</option>
								) : null}
								{projects?.map((workspace) => (
									<option key={workspace.id} value={workspace.id}>
										{workspace.name}
									</option>
								))}
							</select>
						</label>
					</div>
					<nav className="mission__filters" aria-label="Session activity">
						{SESSION_FILTERS.map((key) => (
							<button
								type="button"
								key={key}
								aria-pressed={filter === key}
								onClick={() => set("status", key === "all" ? "" : key)}
							>
								{FILTER_NAMES[key]}
								<span>{items ? (key === "all" ? items.length : counts[key]) : "—"}</span>
							</button>
						))}
					</nav>
					{overview.error ? (
						<p role="alert">
							Sessions could not be refreshed. {overview.error.message}
							{items ? " Showing the last loaded overview." : ""}
						</p>
					) : null}
					{workspaces.error ? (
						<p role="status">Project names could not be loaded. Session records remain available.</p>
					) : null}
					{overview.isPending ? <p role="status">Reading session activity…</p> : null}
					<div className="mission__grid">
						{shown.map((item) => (
							<SessionCard
								key={item.id}
								client={client}
								item={item}
								projectName={projects?.find((workspace) => workspace.id === item.workspaceId)?.name ?? "Unavailable project"}
								connected={connected}
							/>
						))}
					</div>
					{items && shown.length === 0 ? (
						<div className="mission__empty">
							<Icon name="sessions" />
							<h3>{items.length ? "No sessions match this view" : "A place for your next discovery"}</h3>
							<p>
								{items.length
									? "Try another project, search, or activity filter."
									: "Start a task in a project. Its progress and agents will appear here."}
							</p>
							{items.length ? (
								<button type="button" onClick={() => setSearch({})}>
									Clear filters
								</button>
							) : (
								<button type="button" className="primary" onClick={startTask}>
									Start a task
									<Icon name="plus" />
								</button>
							)}
						</div>
					) : null}
					<footer className="mission__scope">
						Sessions held by this Clio server. Saved project history stays in each project's task list. SSH worker activity
						appears within its owning session.
					</footer>
				</div>
			</div>
		</>
	);
}

const SessionCard = memo(function SessionCard({
	client,
	item,
	projectName,
	connected,
}: {
	client: Client;
	item: SessionOverviewItem;
	projectName: string;
	connected: boolean;
}) {
	const queries = useQueryClient();
	const [confirm, setConfirm] = useState(false);
	const keys = useRef(new Map<string, string>());
	const commandKey = (scope: string) => {
		if (scope !== "close")
			for (const previous of keys.current.keys())
				if (previous !== "close" && previous !== scope) keys.current.delete(previous);
		let key = keys.current.get(scope);
		if (!key) {
			key = crypto.randomUUID();
			keys.current.set(scope, key);
		}
		return key;
	};
	const refresh = () => {
		void queries.invalidateQueries({ queryKey: ["session-overview"] });
		void queries.invalidateQueries({ queryKey: ["sessions"] });
		void queries.invalidateQueries({ queryKey: ["session", item.id] });
	};
	const stop = useMutation({
		mutationFn: (turnId: string) =>
			client.call(routes.cancelTurn, { params: { id: item.id, turnId }, query: {}, body: {} }, commandKey(turnId)),
		onSuccess: refresh,
		retry: false,
	});
	const close = useMutation({
		mutationFn: () =>
			client.call(routes.closeSession, { params: { id: item.id }, query: {}, body: {} }, commandKey("close")),
		onSuccess: () => {
			keys.current.delete("close");
			setConfirm(false);
			refresh();
		},
		retry: false,
	});
	const state = ACTIVITY[item.activity];
	const held = item.state === "open" || item.state === "parked" || item.state === "starting";
	const busy = stop.isPending || close.isPending;
	return (
		<article className="mission-card" data-activity={item.activity}>
			<header>
				<span className="mission-card__project">
					<Icon name="folder" />
					{projectName}
				</span>
				<StatusMark tone={state.tone} label={state.label} />
			</header>
			<h3>
				<Link to={`/sessions/${item.id}`}>{item.title}</Link>
			</h3>
			<div className="mission-card__facts">
				<span>
					<Icon name="models" />
					{item.model ?? "Model not reported"}
				</span>
				{item.turnCount ? (
					<span>
						{item.turnCount} {item.turnCount === 1 ? "turn" : "turns"}
					</span>
				) : (
					<span>No request yet</span>
				)}
			</div>
			{item.pendingApprovals || item.pendingQuestions ? (
				<p className="mission-card__attention">
					{item.pendingApprovals
						? `${item.pendingApprovals} approval${item.pendingApprovals === 1 ? "" : "s"} waiting`
						: `${item.pendingQuestions} question${item.pendingQuestions === 1 ? "" : "s"} waiting`}{" "}
					· Open to respond
				</p>
			) : null}
			{item.activeWorkers || item.queuedWorkers || item.nodes.length || !item.workersComplete ? (
				<p className="mission-card__workers">
					<Icon name="fleet" />
					{item.workersComplete ? "" : "At least "}
					{item.activeWorkers} working · {item.queuedWorkers} queued
					{item.nodes.length ? <span title={item.nodes.join(", ")}>{item.nodes.join(", ")}</span> : null}
				</p>
			) : null}
			{item.activeJobs ? (
				<p className="mission-card__workers">
					{item.activeJobs} background {item.activeJobs === 1 ? "job" : "jobs"} running
				</p>
			) : null}
			{item.recoveredOrphan ? (
				<p className="mission-card__attention">Recovered after an interrupted server. Review before continuing.</p>
			) : null}
			<footer>
				<time dateTime={item.updatedAt ?? undefined} title={item.id}>
					{item.updatedAt ? formatTime(item.updatedAt) : "No activity time reported"}
				</time>
				<div>
					{item.currentTurnId ? (
						<button
							type="button"
							className="mission-card__stop"
							disabled={!connected || busy}
							onClick={() => item.currentTurnId && stop.mutate(item.currentTurnId)}
						>
							<Icon name="stop" />
							{stop.isPending ? "Stopping…" : "Stop"}
						</button>
					) : null}
					{held ? (
						<button
							type="button"
							className="mission-card__close"
							disabled={!connected || busy}
							aria-label={`Close session ${item.title}`}
							title="Close this session"
							onClick={() => setConfirm(true)}
						>
							<Icon name="close" />
						</button>
					) : null}
					<Link className="mission-card__open" to={`/sessions/${item.id}`}>
						{state.group === "attention" ? "Review" : item.state === "parked" ? "Continue" : "Open"}
						<Icon name="arrowUp" />
					</Link>
				</div>
			</footer>
			{stop.error || close.error ? (
				<p className="mission-card__error" role="alert">
					{stop.error?.message ?? close.error?.message}
				</p>
			) : null}
			{confirm ? (
				<Dialog title="Close this session?" eyebrow="Session control" onClose={() => setConfirm(false)}>
					<p>
						<strong>{item.title}</strong>
					</p>
					<p>This releases its runtime and cancels any running request.</p>
					<div className="mission__confirm">
						<button type="button" onClick={() => setConfirm(false)}>
							Keep open
						</button>
						<button type="button" disabled={!connected || busy} onClick={() => close.mutate()}>
							{close.isPending ? "Closing…" : "Close session"}
						</button>
					</div>
				</Dialog>
			) : null}
		</article>
	);
});
