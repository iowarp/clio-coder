import { useQuery } from "@tanstack/react-query";
import { memo, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { formatTime } from "../api/clock.js";
import { StatusMark } from "../design/status.js";
import { quotaCards, usageRows, usageTotals } from "./session-usage-model.js";
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
	const [expanded, setExpanded] = useState(true);
	const supported = !!capabilities?.usage;
	const usage = useQuery({
		queryKey: ["session-usage", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionUsage, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: expanded && sessionOpen && supported,
		retry: false,
	});
	const quota = usage.data ? quotaCards(usage.data) : null;
	return (
		<details
			open={expanded}
			className="command-panel session-board usage-panel"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>Usage and quota</summary>
			{!sessionOpen ? <p>This session is not open. Load it to read its usage.</p> : null}
			{sessionOpen && !supported ? <p>This Clio Coder session does not report its usage.</p> : null}
			{usage.isPending && expanded && sessionOpen && supported ? <p>Reading usage…</p> : null}
			{usage.error ? <p role="alert">{usage.error.message}</p> : null}
			{usage.data ? (
				<>
					<dl className="facts" aria-label="This conversation's spend">
						{usageTotals(usage.data).map((figure) => (
							<div className="fact" key={figure.label}>
								<dt>{figure.label}</dt>
								<dd>{figure.value}</dd>
							</div>
						))}
					</dl>
					{usage.data.session.rows.length > 0 ? (
						<ul className="session-board__rows" aria-label="Spend by provider and model">
							{usageRows(usage.data).map((row) => (
								<li key={row.key}>
									<span className="session-board__title">
										{row.route}
										<small>{row.tokens}</small>
										{row.beside ? <small>Beside the conversation: {row.beside}</small> : null}
									</span>
									<span className="usage-panel__cost">{row.cost}</span>
								</li>
							))}
						</ul>
					) : null}
					<h3>Provider quota</h3>
					{quota?.status === "failed" ? <p role="alert">{quota.reason}</p> : null}
					{quota?.status === "read" && quota.cards.length === 0 ? (
						<p className="session-board__empty">No provider with a readable plan is signed in.</p>
					) : null}
					{quota?.status === "read" ? (
						<ul className="usage-panel__quota">
							{quota.cards.map((card) => (
								<li key={card.key}>
									<p className="usage-panel__provider">
										<strong>{card.name}</strong>
										<StatusMark tone={card.tone} label={card.word} />
									</p>
									{card.note ? <small>{card.note}</small> : null}
									{card.message ? <small>{card.message}</small> : null}
									{card.credits ? <small>Credits: {card.credits}</small> : null}
									{card.windows.map((window) => (
										<div key={window.label} className="usage-panel__window">
											<span>
												{window.label}
												{window.binding ? " · the binding limit" : ""}
											</span>
											<meter min={0} max={100} value={window.share} aria-label={`${window.label} used`}>
												{window.used}
											</meter>
											<span className="usage-panel__used">{window.used}</span>
											<small>{window.resetsAt ? `resets ${formatTime(window.resetsAt)}` : "reset time not reported"}</small>
										</div>
									))}
								</li>
							))}
						</ul>
					) : null}
					<p className="session-board__note">
						Spend is Clio Coder's own accounting for this conversation. Quota is each provider's report for the signed-in plan
						and covers every tool using that plan, not only Clio Coder.
					</p>
				</>
			) : null}
		</details>
	);
});
