import { useId, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../design/icons.js";
import { Dialog } from "../interaction/Dialog.js";
import { exploreGroups } from "./explore-model.js";
import { settingsDestination } from "./shell-model.js";
import "./explore-drawer.css";

export function ExploreDrawer({
	activeWorkspaceId,
	onClose,
	onNavigate,
}: {
	activeWorkspaceId: string | null;
	onClose: () => void;
	onNavigate: () => void;
}) {
	const location = useLocation();
	const [query, setQuery] = useState("");
	const field = useRef<HTMLInputElement>(null);
	const groups = exploreGroups(query);
	const workspaceId = new URLSearchParams(location.search).get("workspace") || activeWorkspaceId;
	const id = useId();
	return (
		<Dialog
			title="Explore Clio"
			eyebrow="A place for everything"
			className="wb-explore"
			onClose={onClose}
			initialFocus={field}
		>
			<p className="wb-explore__intro">Find tools, follow your work, or make yourself at home.</p>
			<label className="wb-explore__search">
				<Icon name="search" />
				<span className="sr-only">Find a view</span>
				<input
					ref={field}
					type="search"
					maxLength={128}
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					placeholder="Try machines, memory, costs or skills…"
				/>
			</label>
			<nav className="wb-explore__groups" aria-label="Explore Clio">
				{groups.map((group, index) => (
					<section className="wb-explore__group" key={group.label} aria-labelledby={`${id}-${index}`}>
						<div className="wb-explore__heading">
							<h3 id={`${id}-${index}`}>{group.label}</h3>
							<p>{group.detail}</p>
						</div>
						<div className="wb-explore__links">
							{group.sections.map((section) => {
								return (
									<Link
										key={section.id}
										className="wb-explore__link"
										to={settingsDestination(section.path, workspaceId)}
										aria-current={location.pathname === section.path ? "page" : undefined}
										onClick={onNavigate}
									>
										<Icon name={section.icon} />
										<span>{section.label}</span>
										<Icon name="chevronRight" />
									</Link>
								);
							})}
						</div>
					</section>
				))}
			</nav>
			{groups.length === 0 ? (
				<div className="wb-explore__empty" role="status">
					<p>No matching views. Try another word.</p>
					<button
						type="button"
						onClick={() => {
							setQuery("");
							field.current?.focus();
						}}
					>
						Clear search
					</button>
				</div>
			) : null}
			<footer className="wb-explore__footer">
				<Link to="/docs" onClick={onNavigate}>
					<Icon name="docs" />
					Help and guides
					<Icon name="chevronRight" />
				</Link>
			</footer>
		</Dialog>
	);
}
