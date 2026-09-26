import { Link, useLocation } from "react-router";
import { publicHelpUrl } from "./public-help.js";

/** Compatibility destination only; bundled Markdown is not read or rendered here. */
export function LegacyHelp() {
	const location = useLocation();
	return (
		<main className="route-error">
			<p className="eyebrow">Help</p>
			<h1>Documentation is on the public site.</h1>
			<p>
				Open the guide in your browser. The installed package also includes the Markdown reference for offline reading.
			</p>
			<a href={publicHelpUrl(location.pathname)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
				Open documentation ↗
			</a>
			<p>
				<Link to="/">Back to Overview</Link>
			</p>
		</main>
	);
}
