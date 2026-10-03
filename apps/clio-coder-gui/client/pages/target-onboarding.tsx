import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { routes } from "../../contracts/routes.js";
import type { Client } from "../api/client.js";

/**
 * Whether a task can start. Given a workspace, the answer is that project's effective setup, the
 * layers a task started there runs with; without one it is the user's own settings (first-run setup).
 */
export function useSetupStatus(client: Client, enabled = true, workspaceId?: string | null) {
	return useQuery({
		queryKey: workspaceId ? ["setup-status", workspaceId] : ["setup-status"],
		queryFn: () => client.call(routes.setupStatus, setupStatusInput(workspaceId)),
		enabled,
	});
}

export function setupStatusInput(workspaceId?: string | null) {
	return { params: {}, query: workspaceId ? { workspace: workspaceId } : {}, body: {} };
}

/** Where the setup wizard is opened from, so it can return there. */
export function setupLink(targetId?: string): string {
	return targetId ? `/setup?target=${encodeURIComponent(targetId)}` : "/setup?mode=add";
}

/**
 * The way into the setup wizard from Settings: add a connection, or repair one that exists. The wizard
 * is a full-window experience of its own (client/wizard), so this is a link, not a form.
 */
export function ConnectionSetup({ targetId }: { targetId?: string }) {
	const location = useLocation();
	return (
		<p className="connection-setup">
			<Link to={setupLink(targetId)} state={{ from: `${location.pathname}${location.search}` }}>
				{targetId ? "Repair or edit this connection" : "Add a connection with guided setup"}{" "}
				<span aria-hidden="true">→</span>
			</Link>
		</p>
	);
}
