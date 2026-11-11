import { type PlaybookSource, shadowedPlaybooks } from "../domains/agents/playbook.js";
import { type AgentRecipeDiagnostic, discoverAgentRecipes } from "../domains/agents/registry.js";

interface ProjectShadow {
	kind: "agent" | "playbook";
	name: string;
	replaces: PlaybookSource;
}

const OWNER: Readonly<Record<PlaybookSource, string>> = {
	user: "your",
	builtin: "the built-in",
	plugin: "the plugin",
	project: "the project",
};

/**
 * Agents and playbooks this project's `.clio-coder/` replaces with files of the
 * same name, so `/run` and `/fleet run` reach the project copy. Both load
 * without project trust, so the session names them rather than leaving them to
 * doctor alone.
 */
function projectShadows(cwd: string): ProjectShadow[] {
	const diagnostics: AgentRecipeDiagnostic[] = [];
	discoverAgentRecipes(cwd, diagnostics);
	const agents = diagnostics.flatMap((diagnostic): ProjectShadow[] =>
		diagnostic.kind === "overridden" && diagnostic.by === "project" && diagnostic.id !== undefined
			? [{ kind: "agent", name: diagnostic.id, replaces: diagnostic.source }]
			: [],
	);
	const playbooks = shadowedPlaybooks(cwd).flatMap((entry): ProjectShadow[] =>
		entry.by === "project" ? [{ kind: "playbook", name: entry.name, replaces: entry.source }] : [],
	);
	return [...agents, ...playbooks];
}

function listed(items: ReadonlyArray<string>): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** One sentence naming what the project replaces, or null when it replaces nothing. */
export function projectShadowNotice(cwd: string): string | null {
	let shadows: ProjectShadow[];
	try {
		shadows = projectShadows(cwd);
	} catch {
		return null;
	}
	if (shadows.length === 0) return null;
	const named = shadows.map((shadow) => `${OWNER[shadow.replaces]} ${shadow.kind} ${shadow.name}`);
	return `This project replaces ${listed(named)} with its own copies; clio-coder doctor names the files.`;
}
