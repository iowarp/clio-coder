import { Link } from "react-router";
import { LibraryPage } from "../pages/library.js";
import { useWorkspaceSelection } from "../pages/settings.js";
import type { AreaNavigationProps } from "./area-navigation-props.js";
import "./library-navigation.css";

/** Catalog inspection stays local; package changes retain their canonical review dialog. */
export function LibraryNavigation({ client, close, workspaceId }: AreaNavigationProps) {
	const selection = useWorkspaceSelection(client);
	const id = workspaceId ?? selection.id;
	const workspace = selection.workspaces.data?.find((row) => row.id === id);
	return (
		<section className="sidebar-library" aria-label="Workspace library">
			<div className="sidebar-library__toolbar">
				{workspaceId && <p className="sidebar-note">{workspace?.name ?? "Current project"}</p>}
				<Link to={`/library?${new URLSearchParams({ workspace: id })}`} onClick={close}>
					Open Library page
				</Link>
			</div>
			{/* biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users can scroll the library independently. */}
			<section className="sidebar-library__content" tabIndex={0} aria-label="Library collections and packages">
				<LibraryPage key={id} client={client} workspaceId={workspaceId} compact onReview={close} />
			</section>
		</section>
	);
}
