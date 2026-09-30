/** Presentation metadata only. Clio's settings parser remains the authority for every write. */
export type StructuredField = { key: string; label: string; kind?: "number" | "list"; choices?: readonly string[] };
export type StructuredSettingEditor = {
	kind: "map" | "values" | "list" | "rosters";
	name: string;
	fields: readonly StructuredField[];
};
const thinking = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const STRUCTURED_SETTINGS: Readonly<Record<string, StructuredSettingEditor>> = {
	"fleet.profiles": {
		kind: "map",
		name: "Profile",
		fields: [
			{ key: "target", label: "Connection" },
			{ key: "model", label: "Model" },
			{ key: "thinkingLevel", label: "Thinking", choices: thinking },
			{ key: "node", label: "Worker machine" },
		],
	},
	"fleet.agentProfiles": {
		kind: "values",
		name: "Agent assignment",
		fields: [{ key: "value", label: "Worker profile" }],
	},
	"fleet.rosters": {
		kind: "rosters",
		name: "Roster",
		fields: [
			{ key: "label", label: "Member label" },
			{ key: "target", label: "Connection" },
			{ key: "model", label: "Model" },
			{ key: "thinkingLevel", label: "Thinking", choices: thinking },
			{ key: "color", label: "Member color" },
		],
	},
	"fleet.nodes": {
		kind: "list",
		name: "Worker machine",
		fields: [
			{ key: "id", label: "Machine ID" },
			{ key: "host", label: "SSH host" },
			{ key: "user", label: "SSH user" },
			{ key: "port", label: "SSH port", kind: "number" },
			{ key: "identityFile", label: "Identity file path" },
			{ key: "clioCoderEntry", label: "Clio Coder executable path" },
			{ key: "labels", label: "Machine labels", kind: "list" },
			{ key: "maxWorkers", label: "Worker slots", kind: "number" },
			{ key: "residency", label: "Residency", choices: ["observe", "manage"] },
		],
	},
	"fleet.adaptiveRouting.agentRoles": {
		kind: "list",
		name: "Agent role",
		fields: [
			{ key: "agentId", label: "Agent ID" },
			{
				key: "executionRole",
				label: "Execution role",
				choices: ["builder", "researcher", "verifier", "reviewer", "judge"],
			},
		],
	},
};
