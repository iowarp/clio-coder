import { Link, useLocation } from "react-router";
import { Icon } from "../design/icons.js";
import { useShell } from "../shell/shell-context.js";
import { publicHelpUrl } from "./public-help.js";
import "./help.css";

const GUIDES = [
	{ path: "gui", title: "Your workspace", detail: "Projects, sessions and working with Clio", icon: "sessions" },
	{
		path: "configuration-and-targets",
		title: "Connect your models",
		detail: "Providers, subscriptions and lab servers",
		icon: "models",
	},
	{ path: "fleet-dispatch", title: "Work with a team", detail: "Agents, delegation and shared research", icon: "fleet" },
	{
		path: "context-continuity",
		title: "Continue longer work",
		detail: "Context, memory and session continuity",
		icon: "layers",
	},
	{
		path: "resource-library",
		title: "Extend your workflow",
		detail: "Skills, tools and reusable capabilities",
		icon: "library",
	},
	{ path: "troubleshooting", title: "Find a way forward", detail: "Connection problems and recovery", icon: "system" },
] as const;

export function LegacyHelp() {
	const location = useLocation();
	const shell = useShell();
	return (
		<section className="help-landing">
			<header>
				<p className="eyebrow">Help and learning</p>
				<h1>
					Make yourself <em>at home.</em>
				</h1>
				<p>Find your way around Clio, connect your research tools, and keep your work moving.</p>
			</header>
			<div className="help-landing__actions">
				<button type="button" className="primary" onClick={() => shell?.openHelp()}>
					<Icon name="docs" />
					In-app help and shortcuts
				</button>
				<a href={publicHelpUrl(location.pathname)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
					Browse documentation <Icon name="external" />
				</a>
			</div>
			<div className="help-landing__guides">
				{GUIDES.map((guide) => (
					<a
						key={guide.path}
						href={publicHelpUrl(`/docs/guide/${guide.path}.md`)}
						target="_blank"
						rel="noopener noreferrer"
						referrerPolicy="no-referrer"
					>
						<Icon name={guide.icon} />
						<div>
							<h2>{guide.title}</h2>
							<p>{guide.detail}</p>
						</div>
						<Icon name="external" />
					</a>
				))}
			</div>
			<footer>
				<p>
					Quick help and keyboard shortcuts are available inside the app. Full guides open on Clio’s documentation site. The
					installed package also includes a reference for offline reading.
				</p>
				<Link to="/">
					Back to your workspace
					<Icon name="arrowLeft" />
				</Link>
			</footer>
		</section>
	);
}
