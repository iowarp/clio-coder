import { readLayeredSettings } from "../../../../../src/core/settings-layers.js";
import type { TrustSurface } from "../../../contracts/review.js";
import type { SettingsReport } from "../../../contracts/settings.js";
import { projectSettingsRows } from "./settings-inspection-model.js";

/** The harness's own notice for a project file it ignored until trusted; it names the command that reviews it. */
const TRUST_NOTICE =
	/; project \S+ ignored\. Review with clio-coder config trust (safety|hooks|settings|extensions|plugins|handbook)\.$/u;
const GENERIC = "This settings source reported an issue. Inspect the named source locally for details.";

function issueRow(issue: ReturnType<typeof readLayeredSettings>["issues"][number]): SettingsReport["issues"][number] {
	const trust = issue.kind === undefined ? TRUST_NOTICE.exec(issue.message) : null;
	const surface = trust?.[1] as TrustSurface | undefined;
	if (surface !== undefined)
		return { origin: issue.origin, path: issue.path, kind: "trust", message: issue.message.slice(0, 512), surface };
	return { origin: issue.origin, path: issue.path, kind: issue.kind ?? "schema", message: GENERIC };
}

export function inspectSettings(cwd: string | null): SettingsReport {
	const layered = readLayeredSettings(cwd);
	return {
		rows: projectSettingsRows(layered.settings, layered.sources),
		layers: layered.layers,
		issues: layered.issues.map(issueRow),
	};
}
