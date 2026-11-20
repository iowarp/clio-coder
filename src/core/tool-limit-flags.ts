import type { ToolSurfaceSource } from "./turn-constraints.js";

/**
 * One `--allow-tools`/`--delegate-tools` value: comma-separated capability
 * names, or `none` for no tools. Every entry surface (`run`, the interactive
 * session, `acp`) reads the flag through this, so the three agree. It has no runtime imports, because the startup flag parser (`src/cli/argv.ts`) reads it before
 * any command graph loads.
 */
export function parseToolLimitList(flag: string, value: string): readonly string[] | { error: string } {
	const names = value === "none" ? [] : value.split(",").map((name) => name.trim());
	if (names.some((name) => !isToolLimitName(name)))
		return { error: `${flag} needs comma-separated capability names, or none` };
	return [...new Set(names)];
}

/**
 * The tool-name grammar a limit list accepts. Native template `allowed-tools`
 * and `delegated-tools` keep names by this same rule, so a template can name
 * any tool the session flags can.
 */
export function isToolLimitName(name: string): boolean {
	return /^[a-zA-Z0-9_.-]+$/.test(name);
}

/** The session-wide tool limits an interactive or ACP session was started with. */
export interface SessionToolLimits {
	allowedTools?: readonly string[];
	toolSurfaceSources?: readonly ToolSurfaceSource[];
	delegatedToolSurfaceSources?: readonly ToolSurfaceSource[];
	delegatedTools?: readonly string[];
	deniedTools?: readonly string[];
	readOnly?: true;
}

export function toolLimitConstraints(
	flag: "--allow-tools" | "--delegate-tools" | "--deny-tools",
	tools: readonly string[],
): SessionToolLimits {
	if (flag === "--deny-tools") return { deniedTools: tools };
	const sources: ToolSurfaceSource[] = [
		{
			tools,
			source: flag,
			remedy: `Restart the session with a wider ${flag} list, then resubmit.`,
		},
	];
	return flag === "--allow-tools"
		? { allowedTools: tools, toolSurfaceSources: sources }
		: { delegatedTools: tools, delegatedToolSurfaceSources: sources };
}

/**
 * A name both allowed and denied is a contradiction, never a silent win for
 * either side (SPEC 6.4): the caller refuses it as a usage error.
 */
export function toolLimitConflict(limits: {
	readonly allowedTools?: readonly string[];
	readonly deniedTools?: readonly string[];
}): string | undefined {
	const both = (limits.allowedTools ?? []).filter((name) => limits.deniedTools?.includes(name) === true);
	return both.length > 0
		? `--allow-tools and --deny-tools both name ${both.join(", ")}; pass each tool in one of them`
		: undefined;
}
