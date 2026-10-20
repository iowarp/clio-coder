import { existsSync, readFileSync } from "node:fs";
import { isScalar, parseDocument } from "yaml";
import { settingsPath, withSettingsLock } from "../../../core/config.js";
import { SETTINGS_FILE_MODE } from "../../../core/defaults.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Migration, MigrationReport } from "./index.js";

const MODE_PATH = ["fleet", "permissions", "mode"] as const;

/**
 * `fleet.permissions.mode` defaults to `judge` from 0.6.4, but the earlier
 * settings template wrote `mode: deny` into each new home, so the new default
 * never reached an existing one and its workers kept spending their refusals
 * on asks the safety judge would answer. The file cannot tell the template's
 * deny from one the operator chose, so every user-layer deny moves once and
 * the operator is told how to restore it. Project layers are the repository's
 * choice and are never read here. The value is spliced at its source range,
 * keeping its quoting, so comments, key order and every other byte of the
 * file stay as written.
 */
const migration: Migration = {
	id: "2026-10-20-fleet-permissions-judge",
	async up(): Promise<MigrationReport> {
		return withSettingsLock(() => {
			const report: MigrationReport = { changed: [], attention: [] };
			const file = settingsPath();
			if (!existsSync(file)) return report;
			const text = readFileSync(file, "utf8");
			const document = parseDocument(text);
			if (document.errors.length > 0) throw new Error(`fleet permissions migration: ${document.errors[0]?.message}`);
			const node = document.getIn(MODE_PATH, true);
			const range =
				isScalar(node) && node.value === "deny" && node.anchor === undefined && Array.isArray(node.range)
					? node.range
					: null;
			const source = range === null ? null : text.slice(range[0], range[1]);
			if (range === null || source === null || !/^(["']?)deny\1$/u.test(source)) {
				// An anchored deny may feed other keys, and an aliased one lives elsewhere, so neither is rewritten.
				const resolved = (document.toJS() as { fleet?: { permissions?: { mode?: unknown } } } | null)?.fleet?.permissions
					?.mode;
				if (resolved === "deny")
					report.attention.push(
						"fleet.permissions.mode is deny through a YAML anchor, alias or escape and was left as written. Set it to judge to let the safety judge answer ordinary worker asks at autonomy default.",
					);
				return report;
			}
			const next = `${text.slice(0, range[0])}${source.replace("deny", "judge")}${text.slice(range[1])}`;
			if (parseDocument(next).getIn(MODE_PATH) !== "judge")
				throw new Error("fleet permissions migration: the rewritten settings no longer read fleet.permissions.mode");
			safeResourceWrite(file, next, { encoding: "utf8", mode: SETTINGS_FILE_MODE });
			report.changed.push(
				"fleet.permissions.mode: deny → judge. The safety judge now answers ordinary worker asks at autonomy default; set it back to deny to refuse them.",
			);
			return report;
		});
	},
};

export default migration;
