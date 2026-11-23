import { existsSync, readFileSync } from "node:fs";
import { isAlias, isScalar, parseDocument } from "yaml";
import {
	SETTINGS_V2_RETIRED_VALUE_SPELLINGS,
	settingsPath,
	validateSettings,
	withSettingsLock,
} from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Migration, MigrationReport } from "./index.js";

/**
 * `interface.exitSummary` became on or off; the output detail sizes the summary. This rewrites the older spellings
 * (`auto`, `brief`, `standard`, `report`, `full`) to `on` in the user file, the way `2026-11-21-retired-settings`
 * rewrites its value spellings: the change is reported, the previous file is kept beside it, and project layers are
 * the repository's. A home that has not applied `2026-11-21-retired-settings` gets the same rewrite from it first.
 */

const ID = "2026-11-23-exit-summary-on-off";

const PATH = ["interface", "exitSummary"] as const;
const SPELLINGS = SETTINGS_V2_RETIRED_VALUE_SPELLINGS["interface.exitSummary"] ?? {};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const migration: Migration = {
	id: ID,
	projectSettings(raw: unknown): unknown {
		if (!isRecord(raw) || (raw.version !== undefined && raw.version !== 2)) return raw;
		const ui = raw.interface;
		if (!isRecord(ui) || typeof ui.exitSummary !== "string" || !Object.hasOwn(SPELLINGS, ui.exitSummary)) return raw;
		return { ...raw, interface: { ...ui, exitSummary: SPELLINGS[ui.exitSummary] } };
	},
	async up(): Promise<MigrationReport> {
		return withSettingsLock(() => {
			const report: MigrationReport = { changed: [], attention: [] };
			const file = settingsPath();
			if (!existsSync(file)) return report;
			const doc = parseDocument(readFileSync(file, "utf8"));
			if (doc.errors.length > 0) throw new Error(`exit summary migration: ${doc.errors[0]?.message}`);
			const before = doc.toJS() as unknown;
			if (!isRecord(before) || (before.version !== undefined && before.version !== 2)) return report;
			const node = doc.getIn(PATH, true);
			const resolved = isRecord(before.interface) ? before.interface.exitSummary : undefined;
			if (isAlias(node)) {
				if (typeof resolved === "string" && Object.hasOwn(SPELLINGS, resolved))
					report.attention.push(
						`interface.exitSummary is ${resolved} through a YAML anchor, alias or merge key and was left as written; set it to on or off by hand.`,
					);
				return report;
			}
			if (!isScalar(node) || typeof node.value !== "string" || !Object.hasOwn(SPELLINGS, node.value)) return report;
			const from = node.value;
			if (node.anchor !== undefined) {
				report.attention.push(
					`interface.exitSummary is ${from} through a YAML anchor, alias or merge key and was left as written; set it to on or off by hand.`,
				);
				return report;
			}
			const to = SPELLINGS[from] as string;
			node.value = to;
			const next = doc.toString({ lineWidth: 0 });
			// The rewrite only renames a value; an issue it introduces means it misread the file.
			const known = new Set(validateSettings(before).issues.map((issue) => issue.path));
			const introduced = validateSettings(parseDocument(next).toJS()).issues.filter((issue) => !known.has(issue.path));
			if (introduced.length > 0)
				throw new Error(
					`exit summary migration left settings.yaml unchanged: the rewrite would introduce ${introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
				);
			const backupPath = `${file}.exit-summary.bak`;
			safeResourceWrite(file, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE, backup: { path: backupPath } });
			report.changed.push(
				`What changed for you in settings.yaml (the previous file is ${backupPath}):`,
				`interface.exitSummary: ${from} → ${to}. The summary is now on or off, and output detail sizes it.`,
			);
			return report;
		});
	},
};

export default migration;
