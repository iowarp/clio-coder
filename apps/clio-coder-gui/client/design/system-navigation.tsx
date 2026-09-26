import { useId, useState } from "react";
import { Link } from "react-router";
import { SystemPage } from "../pages/system.js";
import type { AreaNavigationProps } from "./area-navigation-props.js";
import { Icon } from "./icons.js";
import "./system-navigation.css";

export function SystemNavigation({ client, workspaceId, close }: AreaNavigationProps) {
	const [filter, setFilter] = useState("");
	const filterId = useId();
	return (
		<section className="system-navigation" aria-label="System diagnostic controls">
			<div className="system-navigation__filter">
				<label className="sr-only" htmlFor={filterId}>
					Filter system diagnostics
				</label>
				<Icon name="search" />
				<input
					id={filterId}
					type="search"
					placeholder="Find a diagnostic"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
			</div>
			<div className="system-navigation__viewers">
				<Link to="/system" onClick={close}>
					Open System page <Icon name="external" />
				</Link>
				<Link to={`/system/interop${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`} onClick={close}>
					Other coding agents <Icon name="external" />
				</Link>
			</div>
			<section className="system-navigation__scroll" aria-label="Installation diagnostics">
				<SystemPage client={client} compact filter={filter} />
			</section>
		</section>
	);
}
