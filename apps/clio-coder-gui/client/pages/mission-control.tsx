import { useQuery } from "@tanstack/react-query";
import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
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
import { InventoryMore } from "../interaction/InventoryMore.js";
import { useInventoryWindow } from "../interaction/use-inventory-window.js";
import { useShell } from "../shell/shell-context.js";
import { TopBar } from "../shell/TopBar.js";
import { useSessionOverview, useTaskActions } from "../shell/tasks.js";
import { useSessionIntent } from "../shell/use-session-intent.js";
import type { SessionFilter } from "./mission-control-model.js";
import { ACTIVITY, SESSION_FILTERS, sessionInventory } from "./mission-control-model.js";
import { type SessionControls, useSessionControls } from "./session-control-actions.js";
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
	const deferredQuery = useDeferredValue(query);
	const project = search.get("workspace") ?? "";
	const page = useInventoryWindow(JSON.stringify([deferredQuery, project, filter]));
	const list = useRef<HTMLDivElement>(null);
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
	const controls = useSessionControls(client);
	const workspaces = useQuery({ queryKey: ["workspaces"], queryFn: () => client.call(routes.workspaces, emptyInput) });
	const items = overview.data?.sessions;
	const projects = workspaces.data;
	const shown = useMemo(
		() => sessionInventory(items ?? [], projects ?? [], deferredQuery, project, filter),
		[items, projects, deferredQuery, project, filter],
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
					<ControlFeedback controls={controls} connected={connected} />
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
					<div className="mission__grid" ref={list} aria-busy={query !== deferredQuery}>
						{shown.slice(0, page.limit).map((item) => (
							<SessionCard
								key={item.id}
								client={client}
								controls={controls}
								item={item}
								projectName={projects?.find((workspace) => workspace.id === item.workspaceId)?.name ?? "Unavailable project"}
								connected={connected}
							/>
						))}
					</div>
					{items ? (
						<InventoryMore total={shown.length} limit={page.limit} label="sessions" list={list} onMore={page.more} />
					) : null}
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

function ControlFeedback({ controls, connected }: { controls: SessionControls; connected: boolean }) {
	const recovery = useRef<HTMLElement>(null);
	const unresolvedKey = controls.records
		.filter((row) => row.stage === "unresolved")
		.map((row) => row.key)
		.join(":");
	useEffect(() => {
		if (!unresolvedKey) return;
		let landing = 0;
		const frame = requestAnimationFrame(() => {
			landing = requestAnimationFrame(() => recovery.current?.focus());
		});
		return () => {
			cancelAnimationFrame(frame);
			cancelAnimationFrame(landing);
		};
	}, [unresolvedKey]);
	if (!controls.records.length && !controls.notice) return null;
	return (
		<section className="mission-controls" aria-label="Session control results" ref={recovery} tabIndex={-1}>
			{controls.notice ? <p role="alert">{controls.notice}</p> : null}
			{controls.records.map((record) => (
				<div key={record.key} className="mission-controls__record" data-state={record.stage}>
					<div>
						<h3>
							{record.action === "stop" ? "Stop turn" : "Close session"} · {record.title}
						</h3>
						<p role={record.stage === "unresolved" ? "alert" : "status"}>{record.message}</p>
						{record.stage === "unresolved" ? (
							<p className="mission-controls__hint">
								The outcome is unconfirmed. Recovery stays with this session, even when you change filters or leave this page.
							</p>
						) : null}
					</div>
					<div className="mission-controls__actions">
						<Link to={`/sessions/${record.sessionId}`}>Open session</Link>
						{record.stage !== "sending" ? (
							<button type="button" disabled={!connected} onClick={() => void controls.inspect(record.key)}>
								Refresh session state
							</button>
						) : null}
						{record.stage === "complete" ? (
							<button type="button" onClick={() => controls.dismiss(record.key)}>
								Dismiss
							</button>
						) : null}
						{record.stage === "unresolved" ? (
							<button type="button" disabled={!connected || record.restarted} onClick={() => controls.retry(record.key)}>
								Retry original {record.action}
							</button>
						) : null}
					</div>
					{record.stage === "unresolved" ? (
						<details>
							<summary>Review control tracking</summary>
							<p>
								Session <code>{record.sessionId}</code>
								{record.turnId ? (
									<>
										{" "}
										· Original turn <code>{record.turnId}</code>
									</>
								) : null}
								.
							</p>
							<p>
								Retries retain the original request key. After a server restart, replay is refused. Forgetting tracking does not
								cancel work; review this session's records before starting another control.
							</p>
							<Link to={`/workspaces/${record.workspaceId}/sessions`}>Review project history</Link>{" "}
							<button type="button" onClick={() => controls.forget(record.key)}>
								I reviewed the records; forget tracking
							</button>
						</details>
					) : null}
				</div>
			))}
		</section>
	);
}

const SessionCard = memo(function SessionCard({
	client,
	controls,
	item,
	projectName,
	connected,
}: {
	client: Client;
	controls: SessionControls;
	item: SessionOverviewItem;
	projectName: string;
	connected: boolean;
}) {
	const [confirm, setConfirm] = useState(false);
	const intent = useSessionIntent(client, item.id, connected);
	const control = controls.records.find((record) => record.sessionId === item.id);
	const state = ACTIVITY[item.activity];
	const held = item.state === "open" || item.state === "parked" || item.state === "starting";
	const busy = control !== undefined && control.stage !== "complete";
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
				<Link to={`/sessions/${item.id}`} {...intent}>
					{item.title}
				</Link>
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
							onClick={() => controls.start(item, "stop")}
						>
							<Icon name="stop" />
							{control?.stage === "sending" && control.action === "stop" ? "Stopping…" : "Stop"}
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
					<Link className="mission-card__open" to={`/sessions/${item.id}`} {...intent}>
						{state.group === "attention" ? "Review" : item.state === "parked" ? "Continue" : "Open"}
						<Icon name="arrowUp" />
					</Link>
				</div>
			</footer>
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
						<button
							type="button"
							disabled={!connected || busy}
							onClick={() => {
								controls.start(item, "close");
								setConfirm(false);
							}}
						>
							Close session
						</button>
					</div>
				</Dialog>
			) : null}
		</article>
	);
});
