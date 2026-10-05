import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, useId } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionWorkspace } from "../../contracts/session-telemetry.js";
import type { Client } from "../api/client.js";
import { ContextControls } from "./ContextControls.js";
import { ContextWorkCard } from "./ContextWorkCard.js";
import { contextView, contextWorkspaceFacts } from "./context-model.js";
import { contextWorkView } from "./context-work-model.js";
import { contextMeter, contextSegments } from "./overview-model.js";
import { useContextLedger, useContextWork } from "./session-telemetry.js";
import "./session-board.css";

/**
 * The terminal's /context window view. The numbers are Clio Coder's accounting, read when the panel
 * opens and again when a turn settles; nothing here estimates or recomputes them.
 */
export const ContextPanel = memo(function ContextPanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	settledTurns,
	running = false,
	workspace,
	nowMs = 0,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	settledTurns: number;
	running?: boolean;
	workspace?: SessionWorkspace;
	nowMs?: number;
}) {
	const supported = !!capabilities?.context;
	const id = useId();
	const ledger = useContextLedger(client, sessionId, settledTurns, sessionOpen && supported);
	const status = useQuery({
		queryKey: ["session-context-work", sessionId],
		queryFn: ({ signal }) =>
			client.call(routes.sessionContextStatus, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
		enabled: sessionOpen && !!capabilities?.context?.status,
		retry: false,
	});
	const work = useContextWork(client, sessionId) ?? status.data;
	const operation = work?.active?.operation ?? work?.latest;
	const operationView = operation ? contextWorkView(operation, work?.active ?? undefined, nowMs, sessionOpen) : null;
	const cancel = useMutation({
		mutationFn: (operationId: string) =>
			client.call(routes.cancelSessionContext, { params: { id: sessionId }, query: {}, body: { operationId } }),
	});
	const view = ledger.data ? contextView(ledger.data) : null;
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const segments = ledger.data ? contextSegments(ledger.data) : [];
	return (
		<div className="pane-drill drill context-panel">
			{operationView ? (
				<ContextWorkCard
					view={operationView}
					cancelling={cancel.isPending}
					cancelLabel={running ? "Stop task and context work" : "Stop context work"}
					{...(operationView.live ? { onCancel: () => cancel.mutate(operationView.id) } : {})}
				/>
			) : null}
			{status.error || cancel.error ? (
				<p role="alert" className="drill__note drill__note--error">
					{status.error?.message ?? cancel.error?.message}
				</p>
			) : null}
			{sessionOpen && capabilities?.commands ? (
				<ContextControls
					client={client}
					sessionId={sessionId}
					busy={running || !!work?.active}
					onSettled={() => {
						if (supported) void ledger.refetch();
						if (capabilities.context?.status) void status.refetch();
					}}
				/>
			) : null}
			{!sessionOpen ? <p className="pane-empty">This task is not open. Open it to read its context window.</p> : null}
			{sessionOpen && !supported ? <p className="pane-empty">Clio does not report context window for this task.</p> : null}
			{ledger.isPending && sessionOpen && supported ? <p className="pane-empty">Reading the context window…</p> : null}
			{ledger.error ? (
				<p role="alert" className="pane-empty">
					{ledger.error.message}
				</p>
			) : null}
			{view ? (
				<>
					<section className="drill__section context-panel__lead" aria-label="Context window in use">
						<p className="context-panel__figure">
							<strong>{view.figure.percent ?? view.figure.used}</strong>
							<span className="context-panel__of">
								{view.figure.percent === null ? "" : `${view.figure.used} `}
								{view.figure.window === null ? "tokens in use" : `of ${view.figure.window} tokens`}
							</span>
						</p>
						<p className="drill__note">
							{view.figure.basis}.{view.figure.window === null ? ` ${view.window}` : ""}
						</p>
						{meter ? (
							<div className="pane-meter context-panel__meter" data-tone={meter.tone}>
								{/* biome-ignore lint/a11y/useSemanticElements: a native meter cannot hold the segments that show what fills the window. */}
								<div
									className="pane-stack"
									role="meter"
									aria-label="Context window"
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={Math.round(meter.percent)}
									aria-valuetext={meter.text}
								>
									{segments.map((segment, index) => (
										<span
											key={segment.key}
											className="pane-stack__part"
											data-index={index}
											style={{ width: `${segment.percent}%` }}
											title={`${segment.label} ${segment.percent.toFixed(1)}%`}
										/>
									))}
								</div>
								{segments.length > 0 ? (
									<ul className="pane-legend" aria-label="What fills the window">
										{segments.map((segment, index) => (
											<li key={segment.key} data-index={index}>
												{segment.label} <span>{segment.percent < 1 ? "<1" : Math.round(segment.percent)}%</span>
											</li>
										))}
									</ul>
								) : null}
							</div>
						) : null}
					</section>
					{workspace ? (
						<section className="drill__section" aria-labelledby={`${id}-workspace`}>
							<h3 id={`${id}-workspace`}>Workspace evidence</h3>
							<dl className="drill__facts">
								{contextWorkspaceFacts(workspace).map((fact) => (
									<div key={fact.label}>
										<dt>{fact.label}</dt>
										<dd>{fact.note}</dd>
									</div>
								))}
							</dl>
							<p className="drill__note">Reported workspace state. Instruction coverage is shown separately below.</p>
						</section>
					) : null}
					<section className="drill__section" aria-labelledby={`${id}-parts`}>
						<h3 id={`${id}-parts`}>What fills the window</h3>
						<p className="drill__note">
							Category token counts are estimates. Provider usage anchors the total when available.
						</p>
						<table className="drill__table" aria-labelledby={`${id}-parts`}>
							<thead>
								<tr>
									<th scope="col">Part</th>
									<th scope="col">Tokens</th>
									<th scope="col">Share</th>
								</tr>
							</thead>
							<tbody>
								{view.rows.map((row) => (
									<tr key={row.key}>
										<th scope="row">{row.label}</th>
										<td>{row.tokens}</td>
										<td>{row.share || <span className="drill__absent">not reported</span>}</td>
									</tr>
								))}
							</tbody>
						</table>
					</section>
					<section className="drill__section" aria-labelledby={`${id}-project`}>
						<h3 id={`${id}-project`}>Project instructions</h3>
						<dl className="drill__facts">
							{view.project.map((fact) => (
								<div key={fact.label}>
									<dt>{fact.label}</dt>
									<dd>{fact.note}</dd>
								</div>
							))}
						</dl>
						<p className="drill__note">Project instructions and session history are accounted for separately.</p>
					</section>
					<section className="drill__section" aria-labelledby={`${id}-window`}>
						<h3 id={`${id}-window`}>Window</h3>
						<dl className="drill__facts">
							{view.facts.map((fact) => (
								<div key={fact.label}>
									<dt>{fact.label}</dt>
									<dd>
										{fact.value !== null ? <span className="drill__num">{fact.value}</span> : null}
										{fact.note !== null ? <span>{fact.note}</span> : null}
									</dd>
								</div>
							))}
						</dl>
					</section>
				</>
			) : null}
		</div>
	);
});
