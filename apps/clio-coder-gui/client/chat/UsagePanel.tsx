import { useQuery } from "@tanstack/react-query";
import { memo, useId } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { quotaCards, quotaTone, usageRows, usageTotals } from "./session-usage-model.js";
import "./session-board.css";
import "./usage-panel.css";

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
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	settledTurns: number;
}) {
	const supported = !!capabilities?.usage;
	const id = useId();
	const usage = useQuery({
		queryKey: ["session-usage", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionUsage, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: sessionOpen && supported,
		retry: false,
		// The next settled turn changes the key; the last answer stays on screen until the new one lands,
		// so rows (and the focus a row holds) do not vanish between the two reads.
		placeholderData: (previous) => previous,
	});
	const quota = usage.data ? quotaCards(usage.data) : null;
	return (
		<div className="pane-drill drill usage-panel">
			{!sessionOpen ? <p className="pane-empty">This session is not open. Load it to read its usage.</p> : null}
			{sessionOpen && !supported ? <p className="pane-empty">This Clio Coder session does not report its usage.</p> : null}
			{usage.isPending && sessionOpen && supported ? <p className="pane-empty">Reading usage…</p> : null}
			{usage.error ? (
				<p role="alert" className="pane-empty">
					{usage.error.message}
				</p>
			) : null}
			{usage.data ? (
				<>
					<section className="drill__section" aria-label="This conversation's spend">
						<dl className="usage-panel__stats">
							{usageTotals(usage.data).map((figure) => (
								<div key={figure.label}>
									<dt>{figure.label}</dt>
									<dd>{figure.value}</dd>
								</div>
							))}
						</dl>
						<p className="drill__note">Clio Coder's own accounting for this conversation.</p>
					</section>
					{usage.data.session.rows.length > 0 ? (
						<section className="drill__section" aria-labelledby={`${id}-models`}>
							<h3 id={`${id}-models`}>By model</h3>
							<ul className="drill__rows usage-panel__models" aria-label="Spend by provider and model">
								{usageRows(usage.data).map((row) => (
									<li key={row.key}>
										<span className="drill__main">
											<span className="usage-panel__route">{row.route}</span>
											<small className="drill__num">{row.tokens}</small>
											{row.beside ? <small>Beside the conversation: {row.beside}</small> : null}
										</span>
										<span className="drill__num usage-panel__cost">{row.cost}</span>
									</li>
								))}
							</ul>
						</section>
					) : null}
					<section className="drill__section" aria-labelledby={`${id}-quota`}>
						<h3 id={`${id}-quota`}>Provider quota</h3>
						{quota?.status === "failed" ? (
							<p role="alert" className="pane-empty">
								{quota.reason}
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
					</section>
				</>
			) : null}
		</div>
	);
});
