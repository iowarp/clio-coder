import { readLayeredSettings } from "../../../../../src/core/settings-layers.js";
import type { SettingsReport } from "../../../contracts/settings.js";
import { projectSettingsRows } from "./settings-inspection-model.js";

export function inspectSettings(cwd: string): SettingsReport {
	const layered = readLayeredSettings(cwd);
	return {
		rows: projectSettingsRows(layered.settings, layered.sources),
		layers: layered.layers,
		issues: layered.issues.map((issue) => ({
			origin: issue.origin,
			path: issue.path,
			kind: issue.kind ?? "schema",
			message: "This settings source reported an issue. Inspect the named source locally for details.",
		})),
	};
}
