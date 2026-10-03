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

/** The harness tab shares the task rail's header, footer and width. */
export function SettingsSidebar({ onNavigate, onHelp }: { onNavigate: () => void; onHelp: () => void }) {
	const location = useLocation();
	const current = settingsSectionFor(location.pathname);
	return (
		<nav className="wb-side__sections" aria-label="Harness">
			{SETTINGS_GROUPS.map((group) => (
				<Fragment key={group.id}>
					<h2 className="wb-side__label">{group.label}</h2>
					{SETTINGS_SECTIONS.filter((section) => section.group === group.id).map((section) => (
						<SectionLink key={section.id} section={section} active={current?.id === section.id} onNavigate={onNavigate} />
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
