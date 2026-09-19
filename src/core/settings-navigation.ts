/** Shared navigation for configure and /settings. Keep this module free of UI and I/O imports. */
export const SETTINGS_SECTIONS = [
	{
		id: "targets",
		label: "Connections",
		description: "Providers, endpoints, credentials, and available models.",
		aliases: ["connections", "connection", "auth", "target", "providers"],
	},
	{
		id: "chat",
		label: "Chat",
		description: "Chat model, thinking, model favorites, response length, and retries.",
		aliases: ["orchestrator", "models", "model", "thinking", "retry"],
	},
	{
		id: "fleet",
		label: "Fleet",
		description: "Worker models, profiles, routing, concurrency, retries, and run limits.",
		aliases: ["workers"],
	},
	{
		id: "context",
		label: "Context & Memory",
		description: "Context size, compaction, working set, and proactive memory.",
		aliases: ["compaction", "memory"],
	},
	{
		id: "safety",
		label: "Permissions & Limits",
		description: "Autonomy, approval rules, spending limits, and safety review.",
		aliases: ["permissions", "autonomy", "budget", "watchdog"],
	},
	{
		id: "interface",
		label: "Appearance",
		description: "Display, streaming, notifications, panes, and keyboard shortcuts.",
		aliases: ["appearance", "terminal", "panes", "pane", "layout"],
	},
	{
		id: "integrations",
		label: "Integrations",
		description: "Project skills, external agents, plugins, library, and Git attribution.",
		aliases: ["skills", "skill", "extensions", "interop"],
	},
	{
		id: "advanced",
		label: "Advanced",
		description: "Diagnostics, configuration files, and the full settings editor.",
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
