import { useId, useState } from "react";
import { Link } from "react-router";
import { Toolchain } from "../pages/toolchain.js";
import type { AreaNavigationProps } from "./area-navigation-props.js";
import { Icon } from "./icons.js";
import "./toolchain-navigation.css";

export function ToolchainNavigation({ client, close }: AreaNavigationProps) {
	const [filter, setFilter] = useState("");
	const filterId = useId();
	return (
		<section className="tool-navigation" aria-label="Pinned tool controls">
			<div className="tool-navigation__filter">
				<label className="sr-only" htmlFor={filterId}>
					Filter pinned tools
				</label>
				<Icon name="search" />
				<input
					id={filterId}
					type="search"
					placeholder="Find a tool"
					value={filter}
					onChange={(event) => setFilter(event.target.value)}
				/>
			</div>
			<Link className="tool-navigation__viewer" to="/toolchain" onClick={close}>
				Open Toolchain page <Icon name="external" />
			</Link>
			<section className="tool-navigation__scroll" aria-label="Tool installations">
				<Toolchain client={client} compact filter={filter} />
			</section>
		</section>
	);
}
