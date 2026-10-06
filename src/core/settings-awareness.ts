import type { ClioSettings } from "./config.js";
import { type RouteName, type RouteProvenance, routeFields } from "./route-provenance.js";
import { getAtPath } from "./session-routing.js";
import { settingsAreaForPath } from "./settings-areas.js";
import { SETTING_CONTROLS } from "./settings-controls.js";
import { resolveSettingsSection, settingsSectionForPath } from "./settings-navigation.js";

export const AUTONOMY_HELP = {
	default:
		"Edit the workspace, run recognized checks, and delegate routine work without repeated approval. Ask for unfamiliar commands, reads outside the workspace, declared outward actions, and larger dispatch plans. Safety rules still apply.",
	yolo:
		"Run without ordinary approval prompts, including unfamiliar commands and outward actions. Damage-control rules and hard path protections still apply.",
} as const;

function describeSettingsPosture(settings: Readonly<ClioSettings>): string {
	const worker =
		settings.fleet.permissions.mode === "escalate"
			? "Workers ask you when a call needs approval; unanswered requests follow the configured timeout and fallback."
			: settings.fleet.permissions.mode === "main"
				? "Native local workers route ordinary asks to the main agent, which grants them at yolo and forwards them to you otherwise; operator rails always come to you, and a request nobody can answer is denied."
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
export function settingsAwareness(
	settings: Readonly<ClioSettings>,
	query = "",
	offset = 0,
	limit = 12,
	provenance?: RouteProvenance,
) {
	const area = resolveSettingsSection(query);
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

	const controls = SETTING_CONTROLS.map((control, index) => {
		const text = `${control.path} ${control.label} ${control.description}`.toLowerCase();
		const score = terms.filter((term) => text.includes(term)).length;
		return { control, index, score };
	})
		.filter(({ control, score }) =>
			area ? settingsSectionForPath(control.path) === area : terms.length === 0 || score > 0,
		)
		.sort((a, b) => (area ? a.index - b.index : b.score - a.score || a.index - b.index))
		.map(({ control }) => control);
	const route = (value: ClioSettings["fleet"]["default"]) => ({
		target: value.target ?? null,
		model: value.model ?? null,
		thinkingLevel: value.thinkingLevel,
		...(value.node ? { node: value.node } : {}),
	});
	// Active value, its source, and the saved route a session override hides (DF-7).
	const sourced = (route: RouteName, value: Record<string, unknown>) => {
		if (!provenance) return value;
		const saved = provenance.savedRoutes[route];
		return {
			...value,
			source: provenance.active[route],
			...(saved ? { saved: { ...saved, source: provenance.saved[route] } } : {}),
		};
	};

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
			tui: `/settings ${settingsAreaForPath(control.path)}`,
			cli: `clio-coder configure --section ${settingsSectionForPath(control.path)}`,
		};
	});
	return {
		scope: "effective settings for the running session; includes its overrides",
		routing: {
			chat: sourced("chat", route(settings.chat)),
			memory: sourced("memory", routeFields("memory", settings)),
			compaction: sourced("compaction", routeFields("compaction", settings)),
			fleetDefault: sourced("fleet", route(settings.fleet.default)),
			profiles: Object.fromEntries(Object.entries(settings.fleet.profiles).map(([name, value]) => [name, route(value)])),
			agentProfiles: { ...settings.fleet.agentProfiles },
			targets: settings.targets.map((target) => ({
				id: target.id,
				runtime: target.runtime,
				defaultModel: target.defaultModel ?? null,
			})),
			note:
				"These are configured routes, not backend health or a guarantee of a particular dispatch. Shadow helpers use fleet routing; do not substitute the chat model for the fleet default. Agent/profile bindings, explicit requests, recipe requirements and admission can affect a run. Null means not explicitly configured; a null compaction model uses the chat route. When no memory target and model are set, the memory tier uses the active chat route because no memory model is set. context.memory.enabled: false turns proactive memory off." +
				(provenance
					? " source says where each active route comes from: session = applied for this session only and not saved; user = saved user settings; project = this workspace's .clio-coder settings; built-in = default; chat = follows the chat route. saved is the saved route a session override hides; when absent, the active route is the saved one. fleetDefault is the worker route, never the saved chat route."
					: ""),
		},
		posture: describeSettingsPosture(settings),
		limits: {
			sessionCostUsd: settings.safety.limits.sessionCostUsd,
			chatToolCallsPerTurn: settings.safety.limits.chatToolCallsPerTurn,
			workerToolCallsPerRun: settings.fleet.limits.toolCallsPerRun,
			workerPermissionMode: settings.fleet.permissions.mode,
			concurrency: settings.fleet.concurrency,
		},
		note:
			"Answer current-configuration questions from this live snapshot; documentation describes behavior, not this session’s configured values. For zero search matches, retry this settings scope with a short key or no query instead of reading whole guides. These are configured ceilings, not remaining budgets. This read changes nothing. When the user explicitly asks to change Clio routing or fleet settings, discover configure_clio through gateway, preview the exact change, then apply only through its direct operator approval. Never edit settings files with bash or write to bypass that approval. /settings supports session-only changes where available; configure saves global defaults.",
		rows,
		total: controls.length,
		nextOffset: offset + rows.length < controls.length ? offset + rows.length : null,
	};
}
