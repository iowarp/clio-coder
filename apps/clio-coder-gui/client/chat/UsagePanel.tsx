import { useQuery } from "@tanstack/react-query";
import { memo, useId, useRef } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { sessionReadScope } from "../api/sessions.js";
import { StatusMark } from "../design/status.js";
import { Explained } from "../telemetry/Explained.js";
import { useTelemetrySession } from "./session-telemetry.js";
import { quotaCards, quotaTone, usageCoverageNotes, usageRows, usageSummary } from "./session-usage-model.js";
import "./session-board.css";
import "./usage-panel.css";
import "./pane-inspection.css";

/**
 * The terminal's /usage for this conversation: what it spent, per provider and model, and what each
 * provider reports about its plan's windows. Read when opened and after each settled turn; a quota
 * read goes through the agent's cache, so opening this does not spend a provider call every time.
 */
export const UsagePanel = memo(function UsagePanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	settledTurns,
	liveUsage,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	settledTurns: number;
	liveUsage?: LiveUsage;
}) {
	const supported = !!capabilities?.usage;
	const scope = sessionReadScope(sessionId);
	const id = useId();
	const refreshButton = useRef<HTMLButtonElement>(null);
	const usage = useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["session-usage", sessionId, settledTurns, scope],
		queryFn: ({ signal }) =>
			client.call(routes.sessionUsage, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
		enabled: sessionOpen && supported,
		retry: false,
		// The next settled turn changes the key; the last answer stays on screen until the new one lands,
		// so rows (and the focus a row holds) do not vanish between the two reads.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === sessionId && previousQuery.queryKey.at(-1) === scope ? previous : undefined,
	});
	// A closed task has no live usage read; the cold telemetry route folds its journal instead (#434).
	const cold = useTelemetrySession(client, sessionId, !sessionOpen);
	const summary = usageSummary(sessionOpen, usage.data, liveUsage, cold.data);
	const quota = usage.data ? quotaCards(usage.data) : null;
	const refresh = () => {
		if (usage.isFetching) return;
		refreshButton.current?.focus();
		void usage.refetch();
	};
	return (
		<div className="pane-drill drill usage-panel">
			{sessionOpen && supported && (
				<div className="pane-inspection-toolbar">
					<p>Session accounting</p>
					<button ref={refreshButton} type="button" aria-disabled={usage.isFetching} onClick={refresh}>
						{usage.isFetching ? "Refreshing…" : "Refresh accounting"}
					</button>
				</div>
			)}
			{usage.isPlaceholderData && (
				<p className="drill__note" role="status">
					Showing the previous accounting while this turn's usage is read.
				</p>
			)}
			{!sessionOpen ? <p className="pane-empty">{summary.note}</p> : null}
			{sessionOpen && !supported ? <p className="pane-empty">Clio does not report usage for this task.</p> : null}
			{usage.isPending && sessionOpen && supported ? <p className="pane-empty">Reading usage…</p> : null}
			{sessionOpen && usage.error ? (
				<p role="alert" className="pane-empty">
					{usage.error.message} {usage.data ? "Showing the last successful accounting. " : ""}
					<button type="button" disabled={usage.isFetching} onClick={refresh}>
						Retry usage
					</button>
				</p>
			) : null}
			{summary.totals.length > 0 ? (
				<section className="drill__section" aria-label="This conversation's spend">
					<dl className="usage-panel__stats">
						{summary.totals.map((figure) => (
							<div key={figure.label}>
								<dt>{figure.label}</dt>
								<dd>
									<Explained client={client} {...figure} />
								</dd>
							</div>
						))}
					</dl>
					{sessionOpen ? <p className="drill__note">{summary.note}</p> : null}
				</section>
			) : null}
			{summary.details && usage.data ? (
				<>
					{usage.data.session.rows.length > 0 ? (
						<section className="drill__section" aria-labelledby={`${id}-models`}>
							<h3 id={`${id}-models`}>By model</h3>
							<ul className="drill__rows usage-panel__models" aria-label="Spend by provider and model">
								{usageRows(usage.data, "fields").map((row) => (
									<li key={row.key}>
										<span className="drill__main">
											<span className="usage-panel__route">{row.route}</span>
											<small className="drill__num">
												<Explained client={client} label={`Tokens, ${row.route}`} value={row.tokens} ref={row.refs.tokens} />
											</small>
											{row.beside ? <small>Call details: {row.beside}</small> : null}
										</span>
										<span className="drill__num usage-panel__cost">
											<Explained client={client} label={`Cost, ${row.route}`} value={row.cost} ref={row.refs.cost} />
										</span>
									</li>
								))}
							</ul>
							{usageCoverageNotes(usage.data).map((note) => (
								<p key={note} className="drill__note">
									{note}
								</p>
							))}
						</section>
					) : null}
					<details className="pane-inspection-disclosure">
						<summary id={`${id}-quota`}>
							Provider quota
							{quota?.status === "read" ? ` · ${quota.cards.length} ${quota.cards.length === 1 ? "plan" : "plans"}` : ""}
						</summary>

						{quota?.status === "failed" ? (
							<p role="alert" className="pane-empty">
								{quota.reason}{" "}
								<button type="button" disabled={usage.isFetching} onClick={refresh}>
									Refresh reported quota
								</button>
							</p>
						) : null}
						{quota?.status === "read" && quota.cards.length === 0 ? (
							<p className="pane-empty">No provider with a readable plan is signed in.</p>
						) : null}
						{quota?.status === "read" && quota.cards.length > 0 ? (
							<ul className="usage-panel__quota">
								{quota.cards.map((card) => (
									<li key={card.key}>
										<p className="usage-panel__provider">
											<strong>{card.name}</strong>
											<StatusMark tone={card.tone} label={card.word} />
										</p>
										{card.note ? <small className="drill__note">{card.note}</small> : null}
										{card.message ? <small className="drill__note">{card.message}</small> : null}
										{card.credits ? <small className="drill__note">Credits: {card.credits}</small> : null}
										{card.windows.map((window) => (
											<div key={window.label} className="usage-panel__window" data-tone={quotaTone(window.share)}>
												<span className="usage-panel__label">
													{window.label}
													{window.binding ? <small> · the binding limit</small> : null}
												</span>
												<span className="drill__num usage-panel__used">{window.used}</span>
												{/* biome-ignore lint/a11y/useSemanticElements: the native meter's chrome differs per browser and theme; the role keeps its value announced. */}
												<span
													className="usage-panel__bar"
													role="meter"
													aria-label={`${window.label} used`}
													aria-valuemin={0}
													aria-valuemax={100}
													aria-valuenow={Math.round(Math.min(100, Math.max(0, window.share)))}
													aria-valuetext={`${window.used} used`}
												>
													<span style={{ width: `${Math.min(100, Math.max(0, window.share))}%` }} />
												</span>
												<small>{window.resetsAt ? `Resets ${formatTime(window.resetsAt)}` : "Reset time not reported"}</small>
											</div>
										))}
									</li>
								))}
							</ul>
						) : null}
						<p className="drill__note">
							Each provider's report for the signed-in plan. It covers every tool using that plan, not only Clio Coder.
						</p>
					</details>
				</>
			) : null}
		</div>
	);
});
