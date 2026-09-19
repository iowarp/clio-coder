import type { ClioSettings } from "./config.js";
import { getAtPath } from "./session-routing.js";
import { SETTING_CONTROLS } from "./settings-controls.js";
import { resolveSettingsSection, settingsSectionForPath } from "./settings-navigation.js";

export const AUTONOMY_HELP = {
	"read-only": "Inspect the workspace and answer questions. Edits, execution, and dispatch are refused.",
	suggest: "Inspect freely; ask before edits, execution, or dispatch. Useful when reviewing an unfamiliar project.",
	"auto-edit":
		"Edit the workspace, run recognized checks, and delegate routine work without repeated approval. Ask for unfamiliar commands, reads outside the workspace, declared outward actions, and larger dispatch plans. Safety rules still apply.",
	"full-auto":
		"Skip autonomy approvals, including unfamiliar commands and outward actions. Safety rules can still block or require approval. Choose this only for work you are prepared to let run unattended.",
} as const;

function describeSettingsPosture(settings: Readonly<ClioSettings>): string {
	const worker =
		settings.fleet.permissions.mode === "escalate"
			? "Workers ask you when a call needs approval; unanswered requests follow the configured timeout and fallback."
			: settings.fleet.permissions.mode === "fail"
				? "Workers stop their run when a call needs approval."
				: "Workers follow their allowed tool and safety policy; a call needing approval is denied and the worker can continue with allowed work.";
	const budget =
		settings.safety.limits.sessionCostUsd === 0
			? "Tracked spending has no session ceiling."
			: `Tracked session spending is capped at $${settings.safety.limits.sessionCostUsd}; unknown provider prices are not a guaranteed dollar limit.`;
	return `${AUTONOMY_HELP[settings.safety.autonomy]} ${worker} ${budget}`;
}

const SAFE_STRING_VALUES = new Set([
	"chat.target",
	"chat.model",
	"fleet.default.target",
	"fleet.default.model",
	"context.memory.target",
	"context.memory.model",
	"fleet.concurrency",
]);

/** An allowlisted projection: never serialize targets, auth, URLs, external-agent commands, or arbitrary JSON. */
export function settingsAwareness(settings: Readonly<ClioSettings>, query = "", offset = 0, limit = 12) {
	const area = resolveSettingsSection(query);
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	const controls = SETTING_CONTROLS.filter((control) =>
		area
			? settingsSectionForPath(control.path) === area
			: terms.every((term) => `${control.path} ${control.label} ${control.description}`.toLowerCase().includes(term)),
	);
	const rows = controls.slice(offset, offset + limit).map((control) => {
		const disclose =
			control.kind === "number" ||
			control.kind === "boolean" ||
			Boolean(control.choices) ||
			SAFE_STRING_VALUES.has(control.path);
		return {
			path: control.path,
			label: control.label,
			description: control.description,
			...(disclose
				? { value: getAtPath(settings, control.path) ?? null }
				: { valueOmitted: "Free-form or structured value; inspect through the user settings UI." }),
			...(control.choices ? { choices: control.choices } : {}),
			tui: `/settings ${settingsSectionForPath(control.path)}`,
			cli: `clio-coder configure --section ${settingsSectionForPath(control.path)}`,
		};
	});
	return {
		scope: "effective settings for the running session; includes its overrides",
		posture: describeSettingsPosture(settings),
		limits: {
			sessionCostUsd: settings.safety.limits.sessionCostUsd,
			chatToolCallsPerTurn: settings.safety.limits.chatToolCallsPerTurn,
			workerToolCallsPerRun: settings.fleet.limits.toolCallsPerRun,
			workerPermissionMode: settings.fleet.permissions.mode,
			concurrency: settings.fleet.concurrency,
		},
		note:
			"These are configured ceilings, not remaining budgets. This read changes nothing. Guide the user to the listed UI controls; do not edit settings files or relax safety, trust, credentials, or spending limits to get past a denial. /settings supports session-only changes where available; configure saves global defaults.",
		rows,
		total: controls.length,
		nextOffset: offset + rows.length < controls.length ? offset + rows.length : null,
	};
}
