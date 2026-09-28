/** Shared navigation for configure and /settings. Keep this module free of UI and I/O imports. */
export const SETTINGS_SECTIONS = [
	{
		id: "targets",
		label: "Connections",
		description: "Where models come from: apps, providers, sign-in, server addresses, and discovered models.",
		aliases: ["connections", "connection", "auth", "target", "providers"],
	},
	{
		id: "chat",
		label: "Chat",
		description: "The model that answers you, how much it reasons, response length, and retry behavior.",
		aliases: ["orchestrator", "models", "model", "thinking", "retry"],
	},
	{
		id: "fleet",
		label: "Fleet",
		description: "Models and limits for delegated work, including profiles, parallelism, placement, and recovery.",
		aliases: ["workers"],
	},
	{
		id: "context",
		label: "Context & Memory",
		description: "How Clio keeps long conversations useful and whether a background model records task memory.",
		aliases: ["compaction", "memory"],
	},
	{
		id: "safety",
		label: "Permissions & Limits",
		description: "What Clio may do without asking, plus approval, spending, tool, and review limits.",
		aliases: ["permissions", "autonomy", "budget", "watchdog"],
	},
	{
		id: "interface",
		label: "Appearance",
		description: "What the terminal looks and feels like: detail, streaming, notifications, panes, and keys.",
		aliases: ["appearance", "terminal", "panes", "pane", "layout"],
	},
	{
		id: "integrations",
		label: "Integrations",
		description: "Optional connections to project resources, coding agents, plugins, the library, and Git.",
		aliases: ["skills", "skill", "extensions", "interop"],
	},
	{
		id: "advanced",
		label: "Advanced",
		description: "Health checks, file locations, and the validated settings-file editor.",
		aliases: ["all", "settings", "diagnostics", "doctor", "diag"],
	},
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];
export type SettingsSectionAlias = (typeof SETTINGS_SECTIONS)[number]["aliases"][number];
export type SettingsSectionName = SettingsSectionId | SettingsSectionAlias;

export function resolveSettingsSection(name: string): SettingsSectionId | undefined {
	const normalized = name.trim().toLowerCase();
	return SETTINGS_SECTIONS.find(
		(section) => section.id === normalized || (section.aliases as readonly string[]).includes(normalized),
	)?.id;
}

/** Specific exceptions precede schema roots: policy belongs together even when its consumer is a worker or plugin. */
export function settingsSectionForPath(path: string): SettingsSectionId {
	if (
		path === "safetyNet" ||
		path === "fleet.permissions" ||
		path.startsWith("fleet.permissions.") ||
		path === "integrations.externalAgents.defaults.toolGovernance"
	)
		return "safety";
	// The turn controller starts read-only Scout runs, so it lives with delegated work.
	if (path === "turnControl" || path.startsWith("turnControl.")) return "fleet";
	const root = path.split(".")[0];
	switch (root) {
		case "targets":
		case "chat":
		case "fleet":
		case "context":
		case "safety":
		case "interface":
		case "integrations":
			return root;
		default:
			return "advanced";
	}
}

/** Small groups within each area keep related controls together on narrow terminals too. */
export function settingsGroupForPath(path: string): string {
	if (path.startsWith("chat.modelPicker")) return "Model picker";
	if (path.startsWith("chat.retry")) return "Recovery";
	if (path.startsWith("chat.")) return "Model & responses";
	if (path.startsWith("context.memory")) return "Proactive memory";
	if (path.startsWith("context.compaction")) return "Compaction";
	if (path.startsWith("context.workingSet")) return "Working set";
	if (path.startsWith("context.")) return "Context limits";
	if (path.startsWith("fleet.permissions")) return "Worker approvals";
	if (path.startsWith("fleet.default")) return "Default model";
	if (path.startsWith("fleet.profiles")) return "Profiles";
	if (path.startsWith("fleet.agentProfiles")) return "Agent routes";
	if (path.startsWith("turnControl")) return "Turn control";
	if (path.startsWith("fleet.adaptiveRouting")) return "Automatic routing";
	if (path.startsWith("fleet.nodes") || path.startsWith("fleet.endpoints")) return "Placement & capacity";
	if (path.startsWith("fleet.history")) return "Run history";
	if (path.startsWith("fleet.")) return "Execution limits & recovery";
	if (path.startsWith("safety.review")) return "Safety review";
	if (path.startsWith("safety.limits")) return "Spending & tool limits";
	if (path === "integrations.externalAgents.defaults.toolGovernance") return "External agent permissions";
	if (path.startsWith("safety") || path === "safetyNet") return "Autonomy";
	if (path.startsWith("interface.panes.files")) return "Files pane";
	if (path.startsWith("interface.panes")) return "Panes & layout";
	if (path.startsWith("interface.")) return "Display & keyboard";
	if (path.startsWith("integrations.library")) return "Resource library";
	if (path.startsWith("integrations.externalAgents")) return "External agents";
	if (path.startsWith("integrations.")) return "Skills, plugins & Git";
	return "";
}
