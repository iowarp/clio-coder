/**
 * One `--allow-tools`/`--delegate-tools` value: comma-separated capability
 * names, or `none` for no tools. Every entry surface (`run`, the interactive
 * session, `acp`) reads the flag through this, so the three agree. It imports
 * nothing, because the startup flag parser (`src/cli/argv.ts`) reads it before
 * any command graph loads.
 */
export function parseToolLimitList(flag: string, value: string): readonly string[] | { error: string } {
	const names = value === "none" ? [] : value.split(",").map((name) => name.trim());
	if (names.some((name) => !/^[a-zA-Z0-9_.-]+$/.test(name)))
		return { error: `${flag} needs comma-separated capability names, or none` };
	return [...new Set(names)];
}

/** The session-wide tool limits an interactive or ACP session was started with. */
export interface SessionToolLimits {
	allowedTools?: readonly string[];
	delegatedTools?: readonly string[];
}
