/**
 * The interactive /settings taxonomy. `settings-navigation.ts` keeps the eight
 * sections that `clio-coder configure` and the GUI share; this module groups
 * the same controls by what a person expects to find, so a schema prefix never
 * decides where a row lives. Keep it free of UI and I/O imports.
 */
export const SETTINGS_AREAS = [
	{
		id: "recent",
		label: "Recent & Pinned",
		description: "Shortcuts to settings you pinned or changed lately, plus a few suggestions until you build your own.",
		aliases: ["pinned", "shortcuts", "recents"],
	},
	{
		id: "targets",
		label: "Connections",
		description: "Where models come from: apps, providers, sign-in, server addresses, and discovered models.",
		aliases: ["connections", "connection", "auth", "target", "providers"],
	},
	{
		id: "models",
		label: "Models & Inference",
		description: "Which model answers in chat, how much it reasons, how long it may write, and how you switch models.",
		aliases: ["model", "inference", "orchestrator", "thinking"],
	},
	{
		id: "chat",
		label: "Chat",
		description: "How replies show up and recover: output detail, streaming, alerts, and retrying a failed reply.",
		aliases: ["retry"],
	},
	{
		id: "agents",
		label: "Agents & Delegation",
		description: "Which profile each agent uses, automatic routing, and the scouts that prepare an answer.",
		aliases: ["agent", "delegation", "delegate", "scouts", "routing"],
	},
	{
		id: "fleet",
		label: "Fleet",
		description: "The worker fleet: default model, profiles, machines, parallelism, limits, and run history.",
		aliases: ["workers"],
	},
	{
		id: "context",
		label: "Context & Memory",
		description: "How Clio keeps long conversations useful and whether a background model records task memory.",
		aliases: ["compaction", "memory"],
	},
	{
		id: "workspace",
		label: "Workspace & Files",
		description: "The files pane, where task copies live, and how Git commits credit Clio.",
		aliases: ["files", "file", "git", "worktrees"],
	},
	{
		id: "safety",
		label: "Permissions & Limits",
		description: "What Clio may do without asking, plus approval, spending, tool, and review limits.",
		aliases: ["permissions", "autonomy", "budget", "watchdog", "limits"],
	},
	{
		id: "interface",
		label: "Appearance",
		description: "What the terminal looks like: transcript layout, scrollbar, guidance, and companion panes.",
		aliases: ["appearance", "terminal", "panes", "pane", "layout"],
	},
	{
		id: "integrations",
		label: "Integrations",
		description:
			"Optional connections to other coding agents, startup plugins, the resource library, and project imports.",
		aliases: ["skills", "skill", "extensions", "interop", "library", "plugins"],
	},
	{
		id: "advanced",
		label: "Advanced",
		description:
			"Rarely changed: timing and size limits, context tuning, experimental engines, raw collections, and setup tools.",
		aliases: ["all", "settings", "diagnostics", "doctor", "diag", "timing", "experimental", "raw"],
	},
] as const;

export type SettingsAreaId = (typeof SETTINGS_AREAS)[number]["id"];
export type SettingsAreaAlias = (typeof SETTINGS_AREAS)[number]["aliases"][number];
export type SettingsAreaName = SettingsAreaId | SettingsAreaAlias;

export function resolveSettingsArea(name: string): SettingsAreaId | undefined {
	const normalized = name.trim().toLowerCase();
	return SETTINGS_AREAS.find(
		(area) => area.id === normalized || (area.aliases as readonly string[]).includes(normalized),
	)?.id;
}

/** Group labels in display order, per area. A row's group is the one its placement names. */
export const SETTINGS_AREA_GROUPS: Readonly<Record<SettingsAreaId, readonly string[]>> = {
	recent: ["Pinned", "Recent", "Suggested"],
	targets: [],
	models: ["Chat model", "Reasoning & length", "Speed", "Quick switch"],
	chat: ["Replies", "Alerts", "Recovery"],
	agents: ["Agent routes", "Automatic routing", "Before Clio answers"],
	fleet: ["Default worker", "Profiles", "Capacity & placement", "Limits & retries", "Run history"],
	context: ["Compaction", "Context cleanup", "Proactive memory"],
	workspace: ["Files pane", "Task copies", "Git"],
	safety: ["Autonomy", "Worker approvals", "External agents", "Review", "Spending & tool limits"],
	interface: ["Transcript", "Guidance", "Panes"],
	integrations: ["External agents", "Startup plugins", "Project resources", "Resource library"],
	advanced: [
		"Maintenance",
		"Retry timing",
		"Fleet timing",
		"External agent timing",
		"Size limits",
		"Context tuning",
		"Experimental",
		"Raw collections",
		"Other",
	],
};

export interface SettingsPlacement {
	area: SettingsAreaId;
	group: string;
}

/**
 * Whole-value JSON editors that a guided row already fronts, or that no person
 * should meet before the rest of a section. The guided row keeps the human
 * area; the raw twin lands in Advanced.
 */
const RAW_COLLECTIONS: ReadonlySet<string> = new Set([
	"fleet.rosters",
	"fleet.nodes",
	"fleet.profiles",
	"fleet.agentProfiles",
	"fleet.adaptiveRouting.agentRoles",
	"interface.keybindings",
	"integrations.externalAgents.entries",
]);
const GUIDED_ROW_IDS: ReadonlySet<string> = new Set(["workers.profiles", "workers.agentBindings", "delegation.agents"]);

const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}.`);
const place = (area: SettingsAreaId, group = ""): SettingsPlacement => ({ area, group });

/**
 * Where one row lives. `id` is the row id and `path` its canonical settings
 * path; both are needed because a guided row and its raw JSON twin share a
 * path. Anything unplaced falls into Advanced "Other" so no row is unreachable.
 */
export function settingsPlacementForRow(id: string, path: string): SettingsPlacement {
	if (id === "targets" || id === "targets.add-cta" || under(path, "targets")) return place("targets");
	if (id.startsWith("maintenance.")) return place("advanced", "Maintenance");
	if (RAW_COLLECTIONS.has(path) && !GUIDED_ROW_IDS.has(id)) return place("advanced", "Raw collections");
	switch (path) {
		case "chat.target":
		case "chat.model":
			return place("models", "Chat model");
		case "chat.thinkingLevel":
		case "chat.maxOutputTokens":
			return place("models", "Reasoning & length");
		case "chat.prewarm":
			return place("models", "Speed");
		case "chat.retry.enabled":
		case "chat.retry.maxRetries":
			return place("chat", "Recovery");
		case "interface.outputDetail":
		case "interface.smoothStreaming":
			return place("chat", "Replies");
		case "interface.desktopNotifications":
		case "interface.terminalProgress":
			return place("chat", "Alerts");
		case "interface.mode":
		case "interface.fullscreenScrollbar":
			return place("interface", "Transcript");
		case "interface.demo":
			return place("interface", "Guidance");
		case "fleet.worktrees.root":
			return place("workspace", "Task copies");
		case "fleet.concurrency":
			return place("fleet", "Capacity & placement");
		case "fleet.limits.toolCallsPerRun":
		case "fleet.retry.maxRetries":
			return place("fleet", "Limits & retries");
		case "fleet.limits.internalRunTimeoutMs":
		case "fleet.retry.routeCooldownMs":
		case "fleet.retry.breakerThreshold":
			return place("advanced", "Fleet timing");
		case "fleet.speculativeDispatch":
			return place("advanced", "Experimental");
		case "fleet.adaptiveRouting.roles":
		case "fleet.adaptiveRouting.postures":
			return place("agents", "Automatic routing");
		case "integrations.externalAgents.defaults.toolGovernance":
			return place("safety", "External agents");
		case "integrations.externalAgents.entries":
			return place("integrations", "External agents");
		case "integrations.externalAgents.defaults.connectTimeoutMs":
		case "integrations.externalAgents.defaults.turnTimeoutMs":
		case "integrations.externalAgents.defaults.permissionTimeoutMs":
			return place("advanced", "External agent timing");
		case "integrations.runtimePlugins":
			return place("integrations", "Startup plugins");
		case "context.toolResultMaxBytes":
		case "safety.limits.readBytesPerCall":
		case "safety.limits.observationBytesPerTurn":
			return place("advanced", "Size limits");
		case "context.compaction.auto":
		case "context.compaction.threshold":
		case "context.compaction.model":
			return place("context", "Compaction");
		case "context.workingSet.enabled":
		case "context.workingSet.profile":
		case "context.workingSet.target":
		case "context.workingSet.protectLastTurns":
			return place("context", "Context cleanup");
		case "context.memory.enabled":
		case "context.memory.target":
		case "context.memory.model":
		case "context.memory.cadenceToolCalls":
			return place("context", "Proactive memory");
		case "safety.autonomy":
		case "safetyNet":
			return place("safety", "Autonomy");
		case "safety.limits.sessionCostUsd":
		case "safety.limits.chatToolCallsPerTurn":
			return place("safety", "Spending & tool limits");
		default:
	}
	if (under(path, "chat.modelPicker")) return place("models", "Quick switch");
	if (under(path, "chat.retry")) return place("advanced", "Retry timing");
	if (under(path, "interface.panes.files")) return place("workspace", "Files pane");
	if (under(path, "interface.panes")) return place("interface", "Panes");
	if (under(path, "integrations.git")) return place("workspace", "Git");
	if (under(path, "integrations.projectResources")) return place("integrations", "Project resources");
	if (under(path, "integrations.library")) return place("integrations", "Resource library");
	if (under(path, "turnControl")) return place("agents", "Before Clio answers");
	if (under(path, "fleet.agentProfiles")) return place("agents", "Agent routes");
	if (under(path, "fleet.default")) return place("fleet", "Default worker");
	if (under(path, "fleet.profiles")) return place("fleet", "Profiles");
	if (under(path, "fleet.nodes") || under(path, "fleet.endpoints")) return place("fleet", "Capacity & placement");
	if (under(path, "fleet.history")) return place("fleet", "Run history");
	if (under(path, "fleet.permissions")) return place("safety", "Worker approvals");
	if (under(path, "safety.review")) return place("safety", "Review");
	if (under(path, "systemOne")) return place("advanced", "Experimental");
	if (under(path, "context.workingSet") || under(path, "context.memory") || under(path, "context.compaction"))
		return place("advanced", "Context tuning");
	return place("advanced", "Other");
}

const GUIDED_ROW_ID_BY_PATH: Readonly<Record<string, string>> = {
	"fleet.profiles": "workers.profiles",
	"fleet.agentProfiles": "workers.agentBindings",
	"integrations.externalAgents.entries": "delegation.agents",
};

/** The area a person is sent to for a setting path, which is its guided row when one exists. */
export function settingsAreaForPath(path: string): SettingsAreaId {
	return settingsPlacementForRow(GUIDED_ROW_ID_BY_PATH[path] ?? `setting.${path}`, path).area;
}
