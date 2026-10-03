import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { memo } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";
import { StatusMark } from "../design/status.js";
import { extensionRows, reloadOutcome } from "./extensions-model.js";
import "./session-board.css";

/**
 * The terminal's /extensions view and /extensions reload for this conversation. The list is what the
 * running session loaded; installing or enabling one stays with the Library page and the CLI.
 */
export const ExtensionsPanel = memo(function ExtensionsPanel({
	client,
	sessionId,
	sessionOpen,
	capabilities,
	running,
}: {
	client: Client;
	sessionId: string;
	sessionOpen: boolean;
	capabilities: AgentCapabilities | undefined;
	running: boolean;
}) {
	const queries = useQueryClient();
	const params = { params: { id: sessionId }, query: {}, body: {} };
	const supported = !!capabilities?.extensions;
	const list = useQuery({
		queryKey: ["session-extensions", sessionId],
		queryFn: () => client.call(routes.sessionExtensions, params),
		enabled: sessionOpen && supported,
		retry: false,
	});
	const reload = useMutation({
		mutationFn: () => client.call(routes.reloadSessionExtensions, params, crypto.randomUUID()),
		onSettled: () => queries.invalidateQueries({ queryKey: ["session-extensions", sessionId] }),
	});
	const outcome = reload.data ? reloadOutcome(reload.data) : null;
	const body = (
		<>
			{!sessionOpen ? <p>This session is not open. Load it to read its extensions.</p> : null}
			{sessionOpen && !supported ? <p>This Clio Coder session does not report its extensions.</p> : null}
			{list.isPending && sessionOpen && supported ? <p>Reading the extensions…</p> : null}
			{list.error ? <p role="alert">{list.error.message}</p> : null}
			{list.data ? (
				<>
					{list.data.extensions.length === 0 ? (
						<p className="session-board__empty">No extension is installed for this project.</p>
					) : (
						<ul className="session-board__rows session-board__rows--untagged">
							{extensionRows(list.data).map((row) => (
								<li key={row.key}>
									<span className="session-board__title">
										{row.name}
										<small>{row.detail}</small>
										{row.diagnostics.map((line) => (
											<small key={line}>{line}</small>
										))}
									</span>
									<StatusMark tone={row.tone} label={row.word} />
								</li>
							))}
						</ul>
					)}
					<span className="session-board__actions">
						<button type="button" disabled={reload.isPending || running} onClick={() => reload.mutate()}>
							{reload.isPending ? "Reloading…" : "Reload extensions"}
						</button>
					</span>
					<p className="session-board__note">
						{running
							? "Reloading waits for the current turn, because hooks and extension resources change together."
							: "Reloading reads installed extensions and project hooks again and makes them live together."}
					</p>
					{outcome ? (
						<div role={outcome.tone === "error" ? "alert" : "status"} className="session-board__note">
							<p>{outcome.text}</p>
							{outcome.lines.map((line) => (
								<p key={line}>{line}</p>
							))}
						</div>
					) : null}
					{reload.error ? <p role="alert">{reload.error.message}</p> : null}
				</>
			) : null}
		</>
	);
	return <div className="session-board extensions-panel">{body}</div>;
});
