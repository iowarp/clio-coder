import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "react-router";
import { routes } from "../../contracts/routes.js";
import { type Client, emptyInput } from "../api/client.js";

export function useSetupStatus(client: Client, enabled = true) {
	return useQuery({
		queryKey: ["setup-status"],
		queryFn: () => client.call(routes.setupStatus, emptyInput),
		enabled,
	});
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
