import { Fragment } from "react";
import { Link, useLocation } from "react-router";
import { Icon } from "../design/icons.js";
import { SETTINGS_GROUPS, SETTINGS_SECTIONS, type SettingsSection, settingsSectionFor } from "./shell-model.js";

function SectionLink({
	section,
	active,
	onNavigate,
}: {
	section: SettingsSection;
	active: boolean;
	onNavigate: () => void;
}) {
	return (
		<Link
			to={section.path}
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

/** The second rail swaps the task list for a short list of places, with one obvious way back. */
export function SettingsSidebar({
	backTo,
	onNavigate,
	onToggle,
	onHelp,
}: {
	backTo: string;
	onNavigate: () => void;
	onToggle: () => void;
	onHelp: () => void;
}) {
	const location = useLocation();
	const current = settingsSectionFor(location.pathname);
	return (
		<div className="wb-side">
			<div className="wb-side__top">
				<Link className="wb-back" to={backTo} onClick={onNavigate}>
					<Icon name="arrowLeft" />
					<span>Back to app</span>
				</Link>
				<button type="button" className="wb-icon" onClick={onToggle} aria-label="Collapse sidebar">
					<Icon name="sidebar" />
				</button>
			</div>
			<nav className="wb-side__sections" aria-label="Settings">
				{SETTINGS_GROUPS.map((group) => (
					<Fragment key={group.id}>
						<h2 className="wb-side__label">{group.label}</h2>
						{SETTINGS_SECTIONS.filter((section) => section.group === group.id).map((section) => (
							<SectionLink key={section.id} section={section} active={current?.id === section.id} onNavigate={onNavigate} />
						))}
					</Fragment>
				))}
			</nav>
			<div className="wb-side__foot wb-side__foot--plain">
				<button type="button" className="wb-action" onClick={onHelp}>
					<Icon name="docs" />
					<span>Help and shortcuts</span>
				</button>
			</div>
		</div>
	);
}
