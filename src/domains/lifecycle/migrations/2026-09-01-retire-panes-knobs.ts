import { existsSync, readFileSync } from "node:fs";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { settingsPath, withSettingsLock } from "../../../core/config.js";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import type { Migration } from "./index.js";

/**
 * `panes.agents` and `panes.keepFailed` are retired, and the schema refuses
 * them by name rather than ignoring them. That refusal is right for a file
 * written today and wrong as an upgrade experience: an operator whose settings
 * predate 0.4.0 did nothing but keep a key two releases honored, and the first
 * thing the new version would do is refuse to start.
 *
 * This is the sanctioned exception the settings lock exists for. It cannot go
 * through `readSettings` or `updateSettings`, because those run the strict
 * validator that rejects exactly the keys being removed, so it reads and writes
 * the raw document under the same lock every other writer takes.
 */
const RETIRED_PANE_KEYS = ["agents", "keepFailed"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const migration: Migration = {
	id: "2026-09-01-retire-panes-knobs",
	async up(): Promise<void> {
		withSettingsLock(() => {
			const path = settingsPath();
			if (!existsSync(path)) return;
			let parsed: unknown;
			try {
				parsed = parseYaml(readFileSync(path, "utf8"));
			} catch {
				// A document this cannot parse is one it must not rewrite: writing a
				// re-serialized guess over an operator's malformed or transiently
				// unreadable file would destroy the original they still have to fix.
				// The strict reader already names the syntax error on the next boot.
				return;
			}
			if (!isPlainObject(parsed)) return;
			const panes = parsed.panes;
			if (!isPlainObject(panes)) return;
			const present = RETIRED_PANE_KEYS.filter((key) => key in panes);
			// Rewriting is not free: the document is re-serialized from the parse, so
			// comments and formatting the operator wrote do not survive. A file that
			// never named these keys must therefore never be touched.
			if (present.length === 0) return;
			for (const key of present) delete panes[key];
			// A `panes` map that held nothing but the retired knobs is left naming no
			// setting at all, so it goes with them rather than staying as `panes: {}`.
			if (Object.keys(panes).length === 0) delete parsed.panes;
			safeResourceWrite(path, stringifyYaml(parsed), { encoding: "utf8", mode: 0o644 });
		});
	},
};

export default migration;
