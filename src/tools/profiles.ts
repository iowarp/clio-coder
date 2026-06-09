import { type BuiltinToolName, isBuiltinToolName, type ToolName, ToolNames } from "../core/tool-names.js";

export type ToolProfileName = "minimal-local" | "science-local" | "full-agent";

export const TOOL_PROFILE_NAMES: ReadonlyArray<ToolProfileName> = ["minimal-local", "science-local", "full-agent"];
export const CODEWIKI_TOOL_NAMES: ReadonlyArray<BuiltinToolName> = [
	ToolNames.FindSymbol,
	ToolNames.EntryPoints,
	ToolNames.WhereIs,
];

export interface ToolProfileContext {
	agentId?: string;
	task?: string;
}

const MINIMAL_LOCAL_TOOLS: ReadonlyArray<BuiltinToolName> = [
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Glob,
	ToolNames.Ls,
	ToolNames.GitStatus,
	ToolNames.GitDiff,
	ToolNames.GitLog,
	ToolNames.WorkspaceContext,
	ToolNames.FindSymbol,
	ToolNames.EntryPoints,
	ToolNames.WhereIs,
];

const SCIENCE_LOCAL_TOOLS: ReadonlyArray<BuiltinToolName> = [
	...MINIMAL_LOCAL_TOOLS,
	ToolNames.RunTests,
	ToolNames.RunLint,
	ToolNames.RunBuild,
	ToolNames.PackageScript,
	ToolNames.ValidateFrontend,
];

const NARROW_TOOL_PROFILES: Readonly<Record<Exclude<ToolProfileName, "full-agent">, ReadonlySet<BuiltinToolName>>> = {
	"minimal-local": new Set(MINIMAL_LOCAL_TOOLS),
	"science-local": new Set(SCIENCE_LOCAL_TOOLS),
};

export function isToolProfileName(value: string): value is ToolProfileName {
	return (TOOL_PROFILE_NAMES as ReadonlyArray<string>).includes(value);
}

export function applyToolProfile(
	tools: ReadonlyArray<ToolName>,
	profile: ToolProfileName | undefined,
	context?: ToolProfileContext,
): ReadonlyArray<ToolName> {
	const unique = uniquePreservingOrder(tools);
	let profiled: ReadonlyArray<ToolName>;
	if (profile === undefined || profile === "full-agent") {
		profiled = unique;
	} else {
		const allowed = NARROW_TOOL_PROFILES[profile];
		profiled = unique.filter((tool): tool is BuiltinToolName => isBuiltinToolName(tool) && allowed.has(tool));
	}
	return applyCodewikiWorkerPolicy(profiled, context);
}

export function toolProfileToolNames(profile: ToolProfileName): ReadonlyArray<BuiltinToolName> | null {
	if (profile === "full-agent") return null;
	return [...NARROW_TOOL_PROFILES[profile]];
}

function uniquePreservingOrder(tools: ReadonlyArray<ToolName>): ToolName[] {
	const seen = new Set<ToolName>();
	const unique: ToolName[] = [];
	for (const tool of tools) {
		if (seen.has(tool)) continue;
		seen.add(tool);
		unique.push(tool);
	}
	return unique;
}

export function isCodewikiTool(tool: ToolName): boolean {
	return (CODEWIKI_TOOL_NAMES as ReadonlyArray<ToolName>).includes(tool);
}

export function isNavigationHeavyTask(task: string | undefined): boolean {
	if (!task) return false;
	return /\b(?:codewiki|symbol|symbols|entry\s*points?|where\s+is|where_is|find_symbol|call\s*sites?|references?|imports?|exports?|map|mapping|navigate|navigation|topology|architecture|boundar(?:y|ies)|ownership|trace|locate|find\s+(?:the\s+)?(?:implementation|definition|module|file|path))\b|(?:^|\s)(?:src|tests?)\/|\.[cm]?[tj]sx?\b/i.test(
		task,
	);
}

function applyCodewikiWorkerPolicy(
	tools: ReadonlyArray<ToolName>,
	context: ToolProfileContext | undefined,
): ReadonlyArray<ToolName> {
	if (!context?.agentId) return tools;
	if (context.agentId === "scout") return tools;
	if (isNavigationHeavyTask(context.task)) return tools;
	return tools.filter((tool) => !isCodewikiTool(tool));
}
