import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Client } from "../api/client.js";
import { Icon } from "../design/icons.js";
import { StatusMark } from "../design/status.js";
import { Dialog } from "../interaction/Dialog.js";
import { type SessionControls, useSessionControls } from "../pages/session-control-actions.js";
import type { SessionControlTarget } from "../pages/session-control-model.js";
import "./session-controls.css";

interface SessionCommands {
	readonly controls: SessionControls;
	requestClose(target: SessionControlTarget): void;
}
const SessionCommandsContext = createContext<SessionCommands | null>(null);

export function useSessionCommands(): SessionCommands {
	const value = useContext(SessionCommandsContext);
	if (!value) throw new Error("Session controls require the workbench.");
	return value;
}

/** One owner keeps control recovery alive when its original conversation or menu unmounts. */
export function SessionControlsProvider({ client, children }: { client: Client; children: ReactNode }) {
	const controls = useSessionControls(client);
	const [closing, setClosing] = useState<(SessionControlTarget & { epoch: string | null }) | null>(null);
	const keepOpen = useRef<HTMLButtonElement>(null);
	const commands = useMemo(
		() => ({
			controls,
			requestClose: (target: SessionControlTarget) => setClosing({ ...target, epoch: controls.currentEpoch() }),
		}),
		[controls],
	);
	const busy =
		closing !== null && controls.records.some((row) => row.sessionId === closing.id && row.stage !== "complete");
	return (
		<SessionCommandsContext.Provider value={commands}>
			{children}
			{closing ? (
				<Dialog
					title="Close this session?"
					eyebrow="Session control"
					onClose={() => setClosing(null)}
					initialFocus={keepOpen}
				>
					<p className="session-control-confirm__title">{closing.title}</p>
					<p>This releases the session's runtime and stops any work still running in it.</p>
					<p>Your saved conversation stays in project history. Closing a session does not delete it.</p>
					{busy ? <p role="status">Review this session's earlier control request before sending another.</p> : null}
					<div className="session-control-confirm__actions">
						<button type="button" ref={keepOpen} onClick={() => setClosing(null)}>
							Keep open
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								controls.start(closing, "close", closing.epoch);
								setClosing(null);
							}}
						>
							Close session
						</button>
					</div>
				</Dialog>
			) : null}
		</SessionCommandsContext.Provider>
	);
}

export function SessionControlNotice({ connected }: { connected: boolean }) {
	const { controls } = useSessionCommands();
	const [reviewing, setReviewing] = useState(false);
	const reviewButton = useRef<HTMLButtonElement>(null);
	const results = useRef<HTMLDivElement>(null);
	const pendingFocus = useRef<string | null>(null);
	useEffect(() => {
		const key = pendingFocus.current;
		if (!reviewing || !key) return;
		const record = controls.records.find((row) => row.key === key);
		if (record?.stage === "sending") return;
		pendingFocus.current = null;
		const active = document.activeElement;
		if (active !== document.body && active?.getAttribute("data-control-wait") !== key) return;
		results.current?.querySelector<HTMLElement>(`[data-control-key="${key}"] [data-control-focus]`)?.focus();
	}, [controls.records, reviewing]);
	const unresolved = controls.records.filter((row) => row.stage === "unresolved");
	const pending = controls.records.filter((row) => row.stage === "sending");
	const latest = pending.at(-1) ?? controls.records.at(-1);
	const returnToWork = () =>
		requestAnimationFrame(() => {
			const field = document.querySelector<HTMLTextAreaElement>(".composer__field:not(:disabled)");
			(field ?? document.getElementById("main"))?.focus();
		});
	if (!latest && !controls.notice) return null;
	const needsReview = unresolved.length > 0 || controls.notice !== null;
	const label = needsReview ? "Check session" : pending.length ? "Request in progress" : "Request checked";
	const summary = needsReview
		? `${unresolved.length || 1} session ${unresolved.length > 1 ? "requests need" : "request needs"} your review.`
		: pending.length > 1
			? `${pending.length} session requests in progress…`
			: latest?.action === "close"
				? `${pending.length ? "Close request" : "Closed"} · ${latest.title}`
				: `Stop request · ${latest?.title ?? "Session"}`;
	const dismissCompleted = () => {
		for (const row of controls.records) if (row.stage === "complete") controls.dismiss(row.key);
		controls.clearNotice();
		setReviewing(false);
		returnToWork();
	};
	return (
		<>
			<section
				className="session-control-notice"
				data-state={needsReview ? "unresolved" : pending.length ? "sending" : "complete"}
				aria-label="Session control status"
			>
				<div className="session-control-notice__message" role="status">
					<StatusMark tone={needsReview ? "warn" : pending.length ? "running" : "success"} label={label} />
					<span>{summary}</span>
				</div>
				<div className="session-control-notice__actions">
					<button type="button" ref={reviewButton} onClick={() => setReviewing(true)} aria-haspopup="dialog">
						{needsReview ? "Review request" : "Details"}
						<Icon name="arrowUp" />
					</button>
					{!needsReview && !pending.length ? (
						<button type="button" onClick={dismissCompleted} aria-label="Dismiss completed session controls">
							<Icon name="close" />
						</button>
					) : null}
				</div>
			</section>
			{reviewing ? (
				<Dialog title="Session requests" eyebrow="Session control" size="wide" onClose={() => setReviewing(false)}>
					<p>Each request stays with its original session as you move around Clio.</p>
					{controls.notice ? (
						<p role="alert">
							{controls.notice}
							<button type="button" onClick={controls.clearNotice}>
								Dismiss notice
							</button>
						</p>
					) : null}
					<div className="session-control-results" ref={results}>
						{controls.records.map((record) => (
							<section
								key={record.key}
								className="session-control-result"
								data-state={record.stage}
								data-control-key={record.key}
								aria-label={`${record.action === "stop" ? "Stop turn" : "Close session"} · ${record.title}`}
							>
								<header>
									<StatusMark
										tone={record.stage === "unresolved" ? "warn" : record.stage === "sending" ? "running" : "success"}
										label={record.action === "stop" ? "Stop turn" : "Close session"}
									/>
									<h3>{record.title}</h3>
								</header>
								<p role={record.stage === "unresolved" ? "alert" : "status"}>{record.message}</p>
								<div className="session-control-result__actions">
									<Link to={`/sessions/${record.sessionId}`} onClick={() => setReviewing(false)}>
										Open session
										<Icon name="external" />
									</Link>
									<button
										type="button"
										data-control-wait={record.key}
										data-control-focus={record.stage === "unresolved" ? "" : undefined}
										disabled={!connected || record.stage === "sending"}
										onClick={() => {
											pendingFocus.current = record.key;
											void controls.inspect(record.key);
										}}
									>
										Check session state
									</button>
									{record.stage !== "complete" ? (
										<button
											type="button"
											data-control-wait={record.key}
											disabled={!connected || record.restarted || record.stage === "sending"}
											onClick={() => {
												pendingFocus.current = record.key;
												controls.retry(record.key);
											}}
										>
											Retry original {record.action}
										</button>
									) : null}
									{record.stage === "complete" ? (
										<button
											type="button"
											data-control-focus=""
											onClick={() => {
												controls.dismiss(record.key);
												if (controls.records.length === 1) {
													setReviewing(false);
													returnToWork();
												}
											}}
										>
											Dismiss
										</button>
									) : null}
								</div>
								{record.stage === "unresolved" ? (
									<details>
										<summary>Review tracking</summary>
										<p>
											The outcome is unconfirmed. A retry uses this request's original key and session. Clio refuses replay after
											its server restarts.
										</p>
										<p>
											Session <code>{record.sessionId}</code>
											{record.turnId ? (
												<>
													{" "}
													· Turn <code>{record.turnId}</code>
												</>
											) : null}
										</p>
										<Link to={`/workspaces/${record.workspaceId}/sessions`} onClick={() => setReviewing(false)}>
											Review project history
										</Link>
										<p>Forgetting tracking does not stop work or confirm this request.</p>
										<button
											type="button"
											onClick={() => {
												controls.forget(record.key);
												if (controls.records.length === 1) {
													setReviewing(false);
													returnToWork();
												}
											}}
										>
											I reviewed the session; forget tracking
										</button>
									</details>
								) : null}
							</section>
						))}
					</div>
				</Dialog>
			) : null}
		</>
	);
}
