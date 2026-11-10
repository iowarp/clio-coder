import { type BuiltinToolName, isBuiltinToolName, type ToolName, ToolNames } from "../core/tool-names.js";

export type ToolProfileName = "minimal-local" | "science-local" | "full-agent" | "council-read-only";

export const TOOL_PROFILE_NAMES: ReadonlyArray<Exclude<ToolProfileName, "council-read-only">> = [
	"minimal-local",
	"science-local",
	"full-agent",
];
const ALL_TOOL_PROFILE_NAMES: ReadonlyArray<ToolProfileName> = [...TOOL_PROFILE_NAMES, "council-read-only"];

const MINIMAL_LOCAL_TOOLS: ReadonlyArray<BuiltinToolName> = [
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.Git,
	ToolNames.Context,
	ToolNames.CodeNav,
	// A narrowed read-only scout swarm is the surface that most needs to see
	// what its peers already staked.
	ToolNames.Ledger,
];

const SCIENCE_LOCAL_TOOLS: ReadonlyArray<BuiltinToolName> = [...MINIMAL_LOCAL_TOOLS, ToolNames.Verify];
const COUNCIL_READ_ONLY_TOOLS: ReadonlyArray<BuiltinToolName> = [
	ToolNames.Read,
	ToolNames.Grep,
	ToolNames.Find,
	ToolNames.Ls,
	ToolNames.Git,
	ToolNames.CodeNav,
	ToolNames.Context,
];

const NARROW_TOOL_PROFILES: Readonly<Record<Exclude<ToolProfileName, "full-agent">, ReadonlySet<BuiltinToolName>>> = {
	"minimal-local": new Set(MINIMAL_LOCAL_TOOLS),
	"science-local": new Set(SCIENCE_LOCAL_TOOLS),
	"council-read-only": new Set(COUNCIL_READ_ONLY_TOOLS),
};

export function isToolProfileName(value: string): value is ToolProfileName {
	return (ALL_TOOL_PROFILE_NAMES as ReadonlyArray<string>).includes(value);
}

/**
 * True when the profile narrows the builtin tool surface below the recipe's
 * declared set. Black-box external CLI runtimes that cannot mediate per-tool
 * calls use this to refuse a profile they would otherwise silently ignore.
 * `full-agent` and `undefined` impose no narrowing.
 */
function narrowsToolSurface(profile: ToolProfileName | undefined): boolean {
	return profile !== undefined && profile in NARROW_TOOL_PROFILES;
}

/**
 * Fail closed when a narrowing profile is requested on a runtime that cannot
 * enforce it. Black-box external CLIs run their own tool surface and never see
 * Clio's per-tool mediation, so honoring a narrowing profile is impossible;
 * refusing is safer than running the full surface under a profile that promised
 * to restrict it.
 */
export function assertToolProfileEnforceable(profile: ToolProfileName | undefined, runtimeLabel: string): void {
	if (narrowsToolSurface(profile)) {
		throw new Error(
			`${runtimeLabel} runtime cannot enforce tool_profile '${profile}': it runs its own tool surface without Clio per-tool mediation. Dispatch to a native or claude-sdk worker, or use tool_profile full-agent.`,
		);
	}
}

export function applyToolProfile(
	tools: ReadonlyArray<ToolName>,
	profile: ToolProfileName | undefined,
): ReadonlyArray<ToolName> {
	const unique = uniquePreservingOrder(tools);
	if (profile === undefined || profile === "full-agent") return unique;
	const allowed = NARROW_TOOL_PROFILES[profile];
	return unique.filter((tool): tool is BuiltinToolName => isBuiltinToolName(tool) && allowed.has(tool));
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
