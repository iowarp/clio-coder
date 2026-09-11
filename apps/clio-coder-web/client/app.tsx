import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { API_VERSION } from "../contracts/meta.js";
import { routes } from "../contracts/routes.js";
import { type Client, emptyInput } from "./api/client.js";
import { subscribe } from "./api/events.js";

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
			<header className="masthead">
				<NavLink to="/" className="brand">
					<span className="mark" aria-hidden="true">
						C
					</span>
					Clio Coder
				</NavLink>
				<span className="connection">
					<span aria-hidden="true">●</span> {connection}
				</span>
			</header>
			<div className="workspace">
				<aside>
					<p className="eyebrow">Your installation</p>
					<nav aria-label="Main navigation">
						<NavLink to="/" end>
							Overview <span>01</span>
						</NavLink>
						<NavLink to="/traces">
							Traces <span>02</span>
						</NavLink>
						<NavLink to="/toolchain">
							Toolchain <span>03</span>
						</NavLink>
					</nav>
					<p className="local-note">
						Runs on your machine.
						<br />
						Ready when you are.
					</p>
				</aside>
				<main>
					{!client.token ? (
						<div role="alert">
							<h1>Open your launch link</h1>
							<p>Use the full URL printed by the Clio Coder server to connect this tab.</p>
						</div>
					) : meta.error ? (
						<div role="alert">
							<h1>Connection unavailable</h1>
							<p>{meta.error.message}</p>
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
			<footer>
				<span>CLIO CODER / LOCAL WORKSPACE</span>
				<span>{meta.data ? `v${meta.data.clio}` : "Starting"}</span>
			</footer>
		</div>
	);
}
