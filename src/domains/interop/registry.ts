import type { InteropAgentId, InteropAgentKind, InteropInventoryLayout } from "./types.js";

const MARKDOWN_ROOTS: InteropInventoryLayout["roots"] = [
	{ path: "skills", kind: "skill", extensions: [".md"] },
	{ path: "agents", kind: "agent", extensions: [".md", ".toml"] },
	{ path: "commands", kind: "prompt", extensions: [".md"] },
];
const INVENTORIES: Partial<Record<InteropAgentId, InteropInventoryLayout>> = {
	"claude-code": {
		userDeclarations: [{ path: ".claude.json", kind: "mcp", key: "mcpServers" }],
		projectDeclarations: [{ path: ".mcp.json", kind: "mcp", key: "mcpServers" }],
		userRoot: ".claude",
		homeEnv: "CLAUDE_CONFIG_DIR",
		projectRoots: [".claude"],
		roots: [...MARKDOWN_ROOTS, { path: "output-styles", kind: "output-style", extensions: [".md"] }],
		declarations: [
			{ path: "settings.json", kind: "hook", key: "hooks" },
			{ path: "settings.local.json", kind: "hook", key: "hooks" },
			{ path: "hooks/hooks.json", kind: "hook", key: "hooks" },
			{ path: ".mcp.json", kind: "mcp", key: "mcpServers" },
		],
		pluginDirs: [],
		pluginManifests: ["plugin.json", ".claude-plugin/plugin.json"],
		installedRegistry: "plugins/installed_plugins.json",
		listCommand: ["plugin", "list", "--json"],
	},
	codex: {
		additionalUserRoots: [".agents"],
		settingsRegistry: "codex",
		cacheMarketplace: true,
		userRoot: ".codex",
		homeEnv: "CODEX_HOME",
		projectRoots: [".codex", ".agents"],
		roots: [
			...MARKDOWN_ROOTS.filter((r) => r.kind !== "prompt"),
			{ path: "prompts", kind: "prompt", extensions: [".md"] },
		],
		declarations: [
			{ path: "config.toml", kind: "mcp" },
			{ path: "mcp.json", kind: "mcp", key: "mcpServers" },
			{ path: "hooks/hooks.json", kind: "hook", key: "hooks" },
		],
		pluginDirs: ["plugins/cache"],
		pluginManifests: ["plugin.json", ".codex-plugin/plugin.json"],
		listCommand: ["plugin", "list", "--json"],
	},
	antigravity: {
		settingsRegistry: "antigravity",
		userRoot: ".gemini/config",
		homeEnv: "ANTIGRAVITY_HOME",
		projectRoots: [".agents"],
		roots: MARKDOWN_ROOTS,
		declarations: [
			{ path: "hooks.json", kind: "hook", key: "hooks" },
			{ path: "mcp_config.json", kind: "mcp", key: "mcpServers" },
		],
		pluginDirs: ["plugins"],
		pluginManifests: ["plugin.json"],
		listCommand: ["plugin", "list"],
	},
	copilot: {
		settingsRegistry: "copilot",
		userRoot: ".copilot",
		homeEnv: "COPILOT_HOME",
		projectRoots: [".github", ".copilot"],
		roots: [...MARKDOWN_ROOTS, { path: "hooks", kind: "hook", extensions: [".json"] }],
		declarations: [
			{ path: "mcp-config.json", kind: "mcp", key: "mcpServers" },
			{ path: ".mcp.json", kind: "mcp", key: "mcpServers" },
		],
		pluginDirs: ["installed-plugins", "plugins"],
		pluginManifests: ["plugin.json", ".claude-plugin/plugin.json"],
		listCommand: ["plugin", "list"],
	},
	opencode: {
		projectDeclarations: [
			{ path: "opencode.json", kind: "mcp", key: "mcp" },
			{ path: "opencode.jsonc", kind: "mcp", key: "mcp" },
		],
		projectModuleConfig: "opencode.json",
		xdgConfigSubdir: "opencode",
		moduleConfig: "opencode.json",
		userRoot: ".config/opencode",
		homeEnv: "OPENCODE_CONFIG_DIR",
		projectRoots: [".opencode"],
		roots: [
			...MARKDOWN_ROOTS,
			{ path: "agent", kind: "agent", extensions: [".md"] },
			{ path: "command", kind: "prompt", extensions: [".md"] },
			{ path: "plugins", kind: "executable", extensions: [".js", ".ts", ".mjs"] },
			{ path: "tools", kind: "executable", extensions: [".js", ".ts"] },
		],
		declarations: [
			{ path: "opencode.json", kind: "mcp", key: "mcp" },
			{ path: "opencode.jsonc", kind: "mcp", key: "mcp" },
		],
		pluginDirs: [],
		pluginManifests: [],
		listCommand: ["agent", "list"],
	},
};

/**
 * The known agents, in preference order. Order is load-bearing: equal-precedence
 * skill roots break their tie by this index rather than by path spelling, so a
 * symlinked skill resolves to the same winner on every machine.
 */
export const INTEROP_AGENT_KINDS: ReadonlyArray<InteropAgentKind> = [
	{
		id: "claude-code",
		label: "Claude Code",
		binaryNames: ["claude"],
		userDir: ".claude",
		projectDir: ".claude",
		userSkillRoot: ".claude/skills",
		projectSkillRoot: ".claude/skills",
		userPromptRoot: ".claude/commands",
		projectPromptRoot: ".claude/commands",
		instructionFiles: ["CLAUDE.md", ".claude/CLAUDE.md"],
		acp: {
			command: "npx",
			args: ["-y", "@zed-industries/claude-code-acp@0.16.2"],
			npmPackage: "@zed-industries/claude-code-acp",
			npmPackageBin: "claude-code-acp",
		},
		adoptionProvider: "claude-code",
		skillSource: "claude",
	},
	{
		id: "codex",
		label: "Codex",
		binaryNames: ["codex"],
		userDir: ".codex",
		projectDir: ".codex",
		userSkillRoot: ".codex/skills",
		projectSkillRoot: ".codex/skills",
		userPromptRoot: ".codex/prompts",
		projectPromptRoot: ".codex/prompts",
		instructionFiles: ["AGENTS.md", "CODEX.md", ".codex/AGENTS.md"],
		acp: {
			command: "npx",
			args: ["-y", "@agentclientprotocol/codex-acp@1.10.0"],
			npmPackage: "@agentclientprotocol/codex-acp",
			npmPackageBin: "codex-acp",
		},
		adoptionProvider: "codex",
		skillSource: "codex",
	},
	{
		id: "opencode",
		label: "OpenCode",
		binaryNames: ["opencode"],
		userDir: ".config/opencode",
		projectDir: ".opencode",
		userSkillRoot: ".config/opencode/skills",
		projectSkillRoot: ".opencode/skills",
		userPromptRoot: ".config/opencode/command",
		projectPromptRoot: ".opencode/command",
		instructionFiles: [],
		acp: { command: "opencode", args: ["acp", "--cwd", "."] },
		adoptionProvider: "opencode",
		skillSource: "opencode",
	},
	{
		id: "gemini",
		label: "Gemini",
		binaryNames: ["gemini"],
		userDir: ".gemini",
		projectDir: ".gemini",
		instructionFiles: ["GEMINI.md", ".gemini/GEMINI.md"],
		adoptionProvider: "gemini",
	},
	{
		id: "copilot",
		label: "GitHub Copilot",
		binaryNames: ["copilot"],
		userDir: ".copilot",
		userSkillRoot: ".copilot/skills",
		projectSkillRoot: ".github/skills",
		instructionFiles: [".github/copilot-instructions.md"],
		adoptionProvider: "copilot",
		skillSource: "copilot",
	},
	{
		id: "cursor",
		label: "Cursor",
		binaryNames: ["cursor-agent"],
		userDir: ".cursor",
		projectDir: ".cursor",
		instructionFiles: [],
		adoptionProvider: "cursor",
	},
	{
		id: "antigravity",
		label: "Antigravity CLI",
		binaryNames: ["agy"],
		userDir: ".gemini/antigravity-cli",
		legacyUserDirs: [".antigravitycli", ".gemini/config"],
		projectDir: ".gemini/antigravity-cli",
		legacyProjectDirs: [".antigravitycli"],
		instructionFiles: [],
	},
	{
		id: "agents",
		label: "Agent Skills",
		binaryNames: [],
		userDir: ".agents",
		projectDir: ".agents",
		userSkillRoot: ".agents/skills",
		projectSkillRoot: ".agents/skills",
		instructionFiles: [],
		adoptionProvider: "agents",
		skillSource: "agents",
	},
].map((kind) => ({
	...kind,
	...(INVENTORIES[kind.id as InteropAgentId] ? { inventory: INVENTORIES[kind.id as InteropAgentId] } : {}),
})) as ReadonlyArray<InteropAgentKind>;

const BY_ID = new Map<InteropAgentId, InteropAgentKind>(INTEROP_AGENT_KINDS.map((kind) => [kind.id, kind]));

export function interopAgentKind(id: InteropAgentId): InteropAgentKind | undefined {
	return BY_ID.get(id);
}

/** Rank of a skill source in the registry order; unknown sources sort last. */
export function interopSourceRank(source: string): number {
	const index = INTEROP_AGENT_KINDS.findIndex((kind) => kind.skillSource === source);
	return index === -1 ? INTEROP_AGENT_KINDS.length : index;
}

/**
 * Directories Clio must never write into: every registered agent's own home
 * and project directory. Clio reads these roots for skills, prompts, and rule
 * prose; it has no reason to author another agent's configuration.
 */
export function foreignAgentDirs(): ReadonlyArray<string> {
	const dirs: string[] = [];
	for (const kind of INTEROP_AGENT_KINDS) {
		dirs.push(`~/${kind.userDir}/`);
		for (const legacy of kind.legacyUserDirs ?? []) dirs.push(`~/${legacy}/`);
		if (kind.projectDir !== undefined) dirs.push(`${kind.projectDir}/`);
		for (const legacy of kind.legacyProjectDirs ?? []) dirs.push(`${legacy}/`);
	}
	return [...new Set(dirs)];
}
