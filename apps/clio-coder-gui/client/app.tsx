import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { API_VERSION } from "../contracts/meta.js";
import { routes } from "../contracts/routes.js";
import { type Client, emptyInput } from "./api/client.js";
import { subscribe } from "./api/events.js";
import { MobileNavigation, Navigation, RouteFocus, ThemeToggle } from "./design/navigation.js";
import { ProblemToasts } from "./design/problems.js";
import { AppPreferences } from "./design/pwa.js";

export function App({ client }: { client: Client }) {
	const queries = useQueryClient();
	const [connection, setConnection] = useState("Connecting…");
	const meta = useQuery({
		queryKey: ["meta"],
		queryFn: () => client.call(routes.meta, emptyInput),
		enabled: !!client.token,
	});
	useEffect(() => {
		if (client.token) return subscribe(client.token, queries, setConnection);
	}, [client, queries]);
	return (
		<div className="shell">
			<RouteFocus />
			<a className="skip-link" href="#main">
				Skip to content
			</a>
			<header className="masthead">
				<NavLink to="/" className="brand">
					<img src="/clio-coder-logo.webp" alt="" width="36" height="36" />
					Clio Coder
				</NavLink>
				<div className="header-controls">
					<span className="connection" role="status" title={connection} data-connected={connection === "Connected"}>
						<span className="connection-dot" aria-hidden="true" />
						<span className="sr-only">{connection}</span>
					</span>
					<ThemeToggle />
					<AppPreferences enabled={meta.data?.pwa ?? false} token={client.token} version={meta.data?.clio} />
					<MobileNavigation />
				</div>
			</header>
			<div className="workspace">
				<aside className="desktop-navigation">
					<Navigation />
				</aside>
				<main id="main" tabIndex={-1}>
					{!client.token ? (
						<div role="alert">
							<h1>Open your launch link</h1>
							<p>
								Open Clio Coder from your applications to connect this browser, or use the full launch URL printed by the
								server.
							</p>
						</div>
					) : meta.error ? (
						<div role="alert">
							<h1>Connection unavailable</h1>
							<p>{meta.error.message}</p>
							<button type="button" disabled={meta.isFetching} onClick={() => void meta.refetch()}>
								Try again
							</button>
						</div>
					) : meta.isPending ? (
						<p>Connecting to your installation…</p>
					) : meta.data.apiVersion !== API_VERSION ? (
						<div role="alert">The app and server versions differ. Rebuild the client and reload.</div>
					) : (
						<Outlet />
					)}
				</main>
			</div>

			<ProblemToasts />
		</div>
	);
}
