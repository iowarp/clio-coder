import type { InteropAgentId, InteropAgentKind } from "./types.js";

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
			args: ["-y", "@zed-industries/claude-code-acp"],
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
			args: ["-y", "@agentclientprotocol/codex-acp"],
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
		projectDir: ".gemini",
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
];

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
		if (kind.projectDir !== undefined) dirs.push(`${kind.projectDir}/`);
	}
	return [...new Set(dirs)];
}
