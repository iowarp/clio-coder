/** NO_COLOR disables color only when its value is nonempty. */
export function colorDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return (env.NO_COLOR?.length ?? 0) > 0;
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
