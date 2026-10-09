import { Fragment } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../design/icons.js";
import {
	SETTINGS_GROUPS,
	SETTINGS_SECTIONS,
	type SettingsSection,
	settingsDestination,
	settingsSectionFor,
} from "./shell-model.js";

function SectionLink({
	section,
	active,
	workspaceId,
	onNavigate,
}: {
	section: SettingsSection;
	active: boolean;
	workspaceId: string | null | undefined;
	onNavigate: () => void;
}) {
	return (
		<Link
			to={settingsDestination(section.path, workspaceId)}
			className="wb-action"
			aria-current={active ? "page" : undefined}
			data-active={active}
			onClick={onNavigate}
		>
			<Icon name={section.icon} />
			<span>{section.label}</span>
		</Link>
	);
}

/** Configuration is reached from the work sidebar's Settings button. */
export function SettingsSidebar({
	activeWorkspaceId,
	onNavigate,
	onHelp,
}: {
	activeWorkspaceId: string | null;
	onNavigate: () => void;
	onHelp: () => void;
}) {
	const location = useLocation();
	const workspaceId = new URLSearchParams(location.search).get("workspace") || activeWorkspaceId;
	const current = settingsSectionFor(location.pathname);
	return (
		<nav className="wb-side__sections" aria-label="Settings">
			{SETTINGS_GROUPS.map((group) => (
				<Fragment key={group.id}>
					<h2 className="wb-side__label">{group.label}</h2>
					{SETTINGS_SECTIONS.filter((section) => section.group === group.id).map((section) => (
						<SectionLink
							key={section.id}
							section={section}
							active={current?.id === section.id}
							workspaceId={workspaceId}
							onNavigate={onNavigate}
						/>
					))}
				</Fragment>
			))}
			<button type="button" className="wb-action" onClick={onHelp}>
				<Icon name="docs" />
				<span>Help and shortcuts</span>
			</button>
		</nav>
	);
}
