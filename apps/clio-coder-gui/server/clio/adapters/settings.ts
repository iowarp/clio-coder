import { readLayeredSettings, type SettingsOrigin } from "../../../../../src/core/settings-layers.js";
import type { SettingRow, SettingsReport } from "../../../contracts/settings.js";

/** Environment maps and executable argument vectors never enter the public projection. */
const privateSegment =
	/^(?:env|environment|argv|args|command|auth|authorization|headers|credentials|api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password)$/i;
export function inspectSettings(cwd: string): SettingsReport {
	const layered = readLayeredSettings(cwd),
		rows: SettingRow[] = [];
	function visit(value: unknown, key: string, arrayOrigin?: SettingsOrigin) {
		// Object parents are also present in sources; they do not set absent default children.
		// Arrays replace wholesale, so their origin applies to every contained leaf.
		const source = layered.sources[key] ?? arrayOrigin ?? "built-in";
		if (key.split(".").some((part) => privateSegment.test(part))) {
			rows.push({ key, source, value: "[redacted]", redacted: true });
			return;
		}
		if (value && typeof value === "object") {
			const entries = Object.entries(value);
			if (!entries.length) rows.push({ key, source, value: Array.isArray(value) ? [] : {}, redacted: false });
			else
				for (const [child, item] of entries)
					visit(item, key ? `${key}.${child}` : child, Array.isArray(value) ? source : arrayOrigin);
			return;
		}
		if (typeof value === "string") {
			// URLs can carry credentials outside an auth-shaped key.
			try {
				const url = new URL(value);
				if (url.username || url.password || url.search || url.hash) {
					url.username = "";
					url.password = "";
					url.search = "";
					url.hash = "";
					rows.push({ key, source, value: url.href, redacted: true });
					return;
				}
			} catch {
				/* ordinary setting string */
			}
			rows.push({ key, source, value: value.slice(0, 4096), redacted: value.length > 4096 });
		} else if (value === null || typeof value === "boolean" || typeof value === "number")
			rows.push({ key, source, value, redacted: false });
	}
	visit(layered.settings, "");
	return {
		rows: rows.sort((a, b) => a.key.localeCompare(b.key)),
		layers: layered.layers,
		issues: layered.issues.map((issue) => ({
			origin: issue.origin,
			path: issue.path,
			kind: issue.kind ?? "schema",
			message: "This settings source reported an issue. Inspect the named source locally for details.",
		})),
	};
}
