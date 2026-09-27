/** Nonempty NO_COLOR or a terminal declaring no capabilities disables color. */
export function colorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.NO_COLOR?.length ?? 0) > 0 || env.TERM === "dumb" || env.TERM === "unknown";
}

/** Shared by every terminal animation; static labels still convey active work. */
export function motionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env.CLIO_CODER_REDUCE_MOTION !== "1" &&
		env.CLIO_CODER_SCREEN_READER !== "1" &&
		env.TERM !== "dumb" &&
		!colorDisabled(env)
	);
}

/** Font coverage cannot be inferred from TERM, SSH, or color support. */
export function nerdFontEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (
		env.CLIO_CODER_NERD_FONT === "1" &&
		env.CLIO_CODER_SCREEN_READER !== "1" &&
		env.TERM !== "dumb" &&
		env.TERM !== "unknown"
	);
}
