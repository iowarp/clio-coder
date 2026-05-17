import { type BuiltinToolName, isBuiltinToolName, type ToolName, ToolNames } from "../core/tool-names.js";

export type ToolProfileName = "minimal-local" | "science-local" | "full-agent";

export const TOOL_PROFILE_NAMES: ReadonlyArray<ToolProfileName> = ["minimal-local", "science-local", "full-agent"];

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
): ReadonlyArray<ToolName> {
	if (profile === undefined || profile === "full-agent") return uniquePreservingOrder(tools);
	const allowed = NARROW_TOOL_PROFILES[profile];
	return uniquePreservingOrder(tools).filter(
		(tool): tool is BuiltinToolName => isBuiltinToolName(tool) && allowed.has(tool),
	);
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
