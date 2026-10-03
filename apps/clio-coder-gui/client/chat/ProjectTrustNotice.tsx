import type { SessionTelemetry } from "../../contracts/session-telemetry.js";
import "./artifacts.css";

export function ProjectTrustNotice({ trust }: { trust: SessionTelemetry["trust"] }) {
	if (!trust?.ignored.length) return null;
	return (
		<details className="project-trust">
			<summary>Project files were ignored</summary>
			<p>
				Clio has not trusted these project files. Run the named command to inspect them, then approve the reviewed hash in
				this workspace. Clio reloads an idle task when approval changes.
			</p>
			<ul>
				{trust.ignored.map((surface) => (
					<li key={`${surface.surface}:${surface.file}`}>
						<span className="project-trust__file">{surface.file}</span>
						<span>
							{surface.surface} · {surface.verdict.replaceAll("-", " ")}
						</span>
						<code>{surface.fix}</code>
					</li>
				))}
			</ul>
		</details>
	);
}
