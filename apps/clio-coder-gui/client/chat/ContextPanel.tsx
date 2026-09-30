import { useQuery } from "@tanstack/react-query";
import { memo, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { contextView } from "./context-model.js";
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
	const [expanded, setExpanded] = useState(true);
	const supported = !!capabilities?.context;
	const ledger = useQuery({
		queryKey: ["session-context", sessionId, settledTurns],
		queryFn: () => client.call(routes.sessionContext, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: expanded && sessionOpen && supported,
		retry: false,
	});
	const view = ledger.data ? contextView(ledger.data) : null;
	return (
		<details
			open={expanded}
			className="command-panel session-board context-panel"
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary>Context window</summary>
			{!sessionOpen ? <p>This session is not open. Load it to read its context window.</p> : null}
			{sessionOpen && !supported ? <p>This Clio Coder session does not report its context window.</p> : null}
			{ledger.isPending && expanded && sessionOpen && supported ? <p>Reading the context window…</p> : null}
			{ledger.error ? <p role="alert">{ledger.error.message}</p> : null}
			{view ? (
				<>
					<p className="session-board__note">
						{view.route}. {view.window}
					</p>
					<p className="context-panel__total">{view.accounting}</p>
					<table className="context-panel__rows">
						<caption className="session-board__note">What fills the window</caption>
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
									<td>{row.share || "not reported"}</td>
								</tr>
							))}
						</tbody>
					</table>
					<p className="session-board__note">
						{view.reserve} {view.free}
					</p>
					<p className="session-board__note">
						{view.compaction}
						{view.lastCompaction ? ` ${view.lastCompaction}` : ""}
					</p>
					{view.cache ? <p className="session-board__note">{view.cache}</p> : null}
					{view.handbook ? <p className="session-board__note">{view.handbook}</p> : null}
				</>
			) : null}
		</details>
	);
});
