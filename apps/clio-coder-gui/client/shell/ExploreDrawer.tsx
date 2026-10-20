import { useId } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../design/icons.js";
import { Dialog } from "../interaction/Dialog.js";
import { SETTINGS_SECTIONS, settingsDestination, settingsSectionFor } from "./shell-model.js";
import "./explore-drawer.css";

const GROUPS = [
	{ label: "Library", detail: "What Clio can use", sections: ["library", "toolchain"] },
	{ label: "Work together", detail: "Work happening together", sections: ["fleet"] },
	{ label: "Reports & evidence", detail: "Results, checks and usage", sections: ["evidence", "usage"] },
	{ label: "Activity", detail: "Follow what happened", sections: ["traces"] },
	{
		label: "Settings",
		detail: "Make Clio work for you",
		sections: ["general", "models", "safety", "context", "all", "system"],
	},
];

const LINK_LABELS: Readonly<Record<string, string>> = {
	toolchain: "Tools",
	evidence: "Reports",
	traces: "Activity",
	models: "AI models",
	safety: "Permissions",
	all: "Advanced settings",
};

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
	const current = settingsSectionFor(location.pathname);
	const workspaceId = new URLSearchParams(location.search).get("workspace") || activeWorkspaceId;
	const id = useId();
	return (
		<Dialog title="Explore Clio" eyebrow="A place for everything" className="wb-explore" onClose={onClose}>
			<p className="wb-explore__intro">Find tools, follow your work, or make yourself at home.</p>
			<nav className="wb-explore__groups" aria-label="Explore Clio">
				{GROUPS.map((group, index) => (
					<section className="wb-explore__group" key={group.label} aria-labelledby={`${id}-${index}`}>
						<div className="wb-explore__heading">
							<h3 id={`${id}-${index}`}>{group.label}</h3>
							<p>{group.detail}</p>
						</div>
						<div className="wb-explore__links">
							{group.sections.map((sectionId) => {
								const section = SETTINGS_SECTIONS.find((item) => item.id === sectionId);
								if (!section) return null;
								return (
									<Link
										key={section.id}
										className="wb-explore__link"
										to={settingsDestination(section.path, workspaceId)}
										aria-current={current?.id === section.id ? "page" : undefined}
										onClick={onNavigate}
									>
										<Icon name={section.icon} />
										<span>{LINK_LABELS[section.id] ?? section.label}</span>
										<Icon name="chevronRight" />
									</Link>
								);
							})}
						</div>
					</section>
				))}
			</nav>
		</Dialog>
	);
}
