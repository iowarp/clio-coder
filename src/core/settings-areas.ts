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
		id: "models",
		label: "Models",
		description:
			"Where models come from and which one answers: connections, the chat model, reasoning, speed, and quick switching.",
		aliases: [
			"targets",
			"target",
			"connections",
			"connection",
			"auth",
			"providers",
			"model",
			"inference",
			"orchestrator",
			"thinking",
		],
	},
	{
		id: "chat",
		label: "Chat and display",
		description: "How replies show up and recover: output detail, streaming, alerts, retries, transcript, and guidance.",
		aliases: ["interface", "appearance", "terminal", "layout", "display", "retry"],
	},
	{
		id: "workers",
		label: "Workers",
		description: "Workers and agents: default worker, profiles, agent routes, machines, limits, run history, and loops.",
		aliases: ["agents", "agent", "fleet", "delegation", "delegate", "scouts", "routing", "worker", "loops"],
	},
	{
		id: "context",
		label: "Context and memory",
		description: "How Clio keeps long conversations useful and whether a background model records task memory.",
		aliases: ["compaction", "memory"],
	},
	{
		id: "safety",
		label: "Safety and limits",
		description: "What Clio may do without asking: autonomy, the safety judge, sandbox, approvals, review, and spending.",
		aliases: ["permissions", "autonomy", "budget", "watchdog", "limits", "judge", "sandbox"],
	},
	{
		id: "workspace",
		label: "Workspace",
		description: "Panes, files, Git, task copies, the library, external agents, and plugins.",
		aliases: [
			"panes",
			"pane",
			"files",
			"file",
			"git",
			"worktrees",
			"integrations",
			"library",
			"plugins",
			"skills",
			"skill",
			"extensions",
			"interop",
			"music",
		],
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
	models: ["Connections", "Chat model", "Reasoning & length", "Speed", "Quick switch"],
	chat: ["Replies", "Alerts", "Recovery", "Transcript", "Guidance", "Updates", "Graphical app"],
	workers: [
		"Default worker",
		"Profiles",
		"Agent routes",
		"Automatic routing",
		"Machines",
		"Limits & retries",
		"Run history",
		"Loops",
		"Before Clio answers",
	],
	context: ["Compaction", "Context cleanup", "Proactive memory", "Semantic search"],
	safety: ["Autonomy", "Safety judge", "Worker approvals", "Sandbox", "Review", "Spending & tool limits"],
	workspace: ["Files pane", "Panes", "Git", "Task copies", "Library", "External agents", "Plugins"],
	advanced: [
		"Maintenance",
		"Retry timing",
		"Worker timing",
		"External agent timing",
		"Size limits",
		"Context tuning",
		"Experimental",
		"Telemetry",
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
	if (id === "targets" || id === "targets.add-cta" || under(path, "targets")) return place("models", "Connections");
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
		case "chat.cacheKeepalive":
			return place("models", "Speed");
		case "chat.retry.enabled":
		case "chat.retry.maxRetries":
			return place("chat", "Recovery");
		case "chat.loopsUntilStopped":
			return place("workers", "Loops");
		case "interface.outputDetail":
		case "interface.smoothStreaming":
			return place("chat", "Replies");
		case "interface.desktopNotifications":
		case "interface.terminalProgress":
			return place("chat", "Alerts");
		case "interface.mode":
		case "interface.exitSummary":
		case "interface.fullscreenScrollbar":
			return place("chat", "Transcript");
		case "interface.demo":
			return place("chat", "Guidance");
		case "interface.autoUpdate":
			return place("chat", "Updates");
		case "interface.guiTurnCapacity":
			return place("chat", "Graphical app");
		case "fleet.worktrees.root":
			return place("workspace", "Task copies");
		case "fleet.concurrency":
		case "fleet.staggerSharedPrefix":
			return place("workers", "Machines");
		case "fleet.limits.toolCallsPerRun":
		case "fleet.retry.maxRetries":
			return place("workers", "Limits & retries");
		case "fleet.limits.internalRunTimeoutMs":
		case "safety.limits.workerResponseSeconds":
		case "fleet.retry.routeCooldownMs":
		case "fleet.retry.breakerThreshold":
			return place("advanced", "Worker timing");
		case "fleet.adaptiveRouting.roles":
		case "fleet.adaptiveRouting.postures":
			return place("workers", "Automatic routing");
		case "integrations.externalAgents.defaults.toolGovernance":
			return place("safety", "Worker approvals");
		case "integrations.externalAgents.entries":
			return place("workspace", "External agents");
		case "integrations.externalAgents.defaults.connectTimeoutMs":
		case "integrations.externalAgents.defaults.turnTimeoutMs":
		case "integrations.externalAgents.defaults.permissionTimeoutMs":
			return place("advanced", "External agent timing");
		case "integrations.runtimePlugins":
			return place("workspace", "Plugins");
		case "context.toolResultMaxBytes":
		case "safety.limits.readBytesPerCall":
		case "safety.limits.observationBytesPerTurn":
			return place("advanced", "Size limits");
		case "context.compaction.auto":
		case "context.compaction.threshold":
		case "context.compaction.maxTokens":
		case "context.compaction.provider":
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
		case "context.semantic.enabled":
		case "context.semantic.target":
		case "context.semantic.model":
		case "context.semantic.assetIdentity":
		case "context.semantic.projectorIdentity":
		case "context.semantic.canaryFingerprint":
		case "context.semantic.modalities":
		case "context.semantic.background":
		case "context.semantic.inboxes":
			return place("context", "Semantic search");
		case "safety.autonomy":
		case "safety.snapshots":
		case "safety.unattendedAfterSeconds":
		case "safety.yoloAccepted":
		case "safety.yoloConfinement":
		case "safety.yoloUnconfinedAccepted":
		case "safetyNet":
			return place("safety", "Autonomy");
		case "safety.limits.sessionCostUsd":
		case "safety.limits.chatToolCallsPerTurn":
		case "safety.limits.autonomousToolCalls":
		case "safety.limits.autonomousMinutes":
		case "safety.limits.autonomousTokens":
			return place("safety", "Spending & tool limits");
		case "safety.sandbox":
		case "safety.sandboxNetwork":
		case "safety.sandboxPassEnv":
		case "safety.sandboxUnixSockets":
		case "safety.scratchRoots":
			return place("safety", "Sandbox");
		default:
	}
	if (under(path, "chat.modelPicker")) return place("models", "Quick switch");
	if (under(path, "chat.retry")) return place("advanced", "Retry timing");
	if (under(path, "interface.panes.files")) return place("workspace", "Files pane");
	if (under(path, "interface.panes")) return place("workspace", "Panes");
	// The music player lives in a pane dock, so its switches sit with the other panes.
	if (under(path, "integrations.music")) return place("workspace", "Panes");
	if (under(path, "integrations.git")) return place("workspace", "Git");
	if (under(path, "integrations.projectResources")) return place("workspace", "Library");
	if (under(path, "integrations.library")) return place("workspace", "Library");
	if (under(path, "turnControl")) return place("workers", "Before Clio answers");
	if (under(path, "fleet.agentProfiles")) return place("workers", "Agent routes");
	if (under(path, "fleet.default")) return place("workers", "Default worker");
	if (under(path, "fleet.profiles")) return place("workers", "Profiles");
	if (path === "fleet.defaultNode" || under(path, "fleet.nodes") || under(path, "fleet.endpoints"))
		return place("workers", "Machines");
	if (under(path, "fleet.history")) return place("workers", "Run history");
	if (under(path, "fleet.permissions")) return place("safety", "Worker approvals");
	if (under(path, "safety.review")) return place("safety", "Review");
	if (under(path, "safety.judge")) return place("safety", "Safety judge");
	if (under(path, "systemOne") || under(path, "chat.steering")) return place("advanced", "Experimental");
	if (under(path, "telemetry")) return place("advanced", "Telemetry");
	if (under(path, "report")) return place("chat", "Guidance");
	if (under(path, "prompts")) return place("advanced", "Experimental");
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
