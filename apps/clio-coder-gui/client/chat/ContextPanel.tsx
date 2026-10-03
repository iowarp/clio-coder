import { memo, useId } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { Client } from "../api/client.js";
import { contextView } from "./context-model.js";
import { contextMeter, contextSegments } from "./overview-model.js";
import { useContextLedger } from "./session-telemetry.js";
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
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	settledTurns: number;
}) {
	const supported = !!capabilities?.context;
	const id = useId();
	const ledger = useContextLedger(client, sessionId, settledTurns, sessionOpen && supported);
	const view = ledger.data ? contextView(ledger.data) : null;
	const meter = ledger.data ? contextMeter(ledger.data) : null;
	const segments = ledger.data ? contextSegments(ledger.data) : [];
	return (
		<div className="pane-drill drill context-panel">
			{!sessionOpen ? <p className="pane-empty">This session is not open. Load it to read its context window.</p> : null}
			{sessionOpen && !supported ? (
				<p className="pane-empty">This Clio Coder session does not report its context window.</p>
			) : null}
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
					<section className="drill__section" aria-labelledby={`${id}-parts`}>
						<h3 id={`${id}-parts`}>What fills the window</h3>
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
