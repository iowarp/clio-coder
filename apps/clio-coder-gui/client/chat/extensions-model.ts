// What the session's extensions and a reload say, before any of it is drawn. The state words are
// the terminal overlay's; a rejected reload names the generation that stays live.

import type { ExtensionReload, SessionExtensions } from "../../contracts/extensions.js";
import type { StatusTone } from "../design/status.js";

const STATES: Record<SessionExtensions["extensions"][number]["state"], [StatusTone, string]> = {
	eligible: ["success", "Loaded"],
	disabled: ["neutral", "Disabled"],
	invalid: ["fail", "Invalid"],
	incompatible: ["warn", "Incompatible"],
	shadowed: ["neutral", "Shadowed"],
};

export function extensionRows(list: SessionExtensions) {
	return list.extensions.map((extension) => {
		const [tone, word] = STATES[extension.state];
		return {
			key: `${extension.scope}:${extension.id}`,
			name: extension.name,
			detail: [
				`${extension.id} ${extension.version}`,
				`${extension.scope} scope`,
				extension.overriddenBy ? `overridden by the ${extension.overriddenBy} copy` : null,
				extension.runtime ? "runs code" : null,
				extension.problems > 0 ? `${extension.problems} ${extension.problems === 1 ? "problem" : "problems"}` : null,
			]
				.filter(Boolean)
				.join(" · "),
			tone,
			word,
			diagnostics: extension.diagnostics,
		};
	});
}

export function reloadOutcome(result: ExtensionReload): {
	tone: "success" | "warning" | "error";
	text: string;
	lines: string[];
} {
	if (result.status === "rejected")
		return {
			tone: "error",
			text: `Reload refused (${result.reason}); generation ${result.generation} stays live.`,
			lines: result.lines,
		};
	const delta = result.changed ? `+${result.added} −${result.removed} ~${result.modified}` : "no changes";
	const warnings = result.hooks.dropped + result.hooks.issues;
	return {
		tone: warnings > 0 ? "warning" : "success",
		text: `Generation ${result.generation} is live (${delta}); ${result.hooks.registered} hooks registered${
			result.hooks.dropped > 0 ? `, ${result.hooks.dropped} dropped` : ""
		}${result.hooks.issues > 0 ? `, ${result.hooks.issues} issues` : ""}.`,
		lines: result.lines,
	};
}
