export interface AutoPacingEnvironment {
	isTTY: boolean;
	term?: string;
	sshConnection?: string;
	sshTty?: string;
	tmux?: string;
	sty?: string;
	ci?: string;
	reducedMotion?: string;
	screenReader?: string;
	backpressureObserved: boolean;
}

/**
 * Auto is intentionally conservative. Terminal/screen-reader detection is not
 * reliable, so persisted `off` remains the release default and explicit
 * accessibility markers always bypass pacing. Remote/multiplexed and already
 * saturated outputs keep the proven coalescer behavior.
 */
function autoPacingAllowed(environment: AutoPacingEnvironment): boolean {
	if (!environment.isTTY || environment.backpressureObserved) return false;
	const term = environment.term?.trim().toLowerCase();
	if (!term || term === "dumb" || term === "unknown") return false;
	if (environment.sshConnection || environment.sshTty || environment.tmux || environment.sty || environment.ci)
		return false;
	if (environment.reducedMotion === "1" || environment.screenReader === "1") return false;
	return true;
}

export function processAutoPacingAllowed(backpressureObserved: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
	return autoPacingAllowed({
		isTTY: process.stdout.isTTY === true,
		...(env.TERM === undefined ? {} : { term: env.TERM }),
		...(env.SSH_CONNECTION === undefined ? {} : { sshConnection: env.SSH_CONNECTION }),
		...(env.SSH_TTY === undefined ? {} : { sshTty: env.SSH_TTY }),
		...(env.TMUX === undefined ? {} : { tmux: env.TMUX }),
		...(env.STY === undefined ? {} : { sty: env.STY }),
		...(env.CI === undefined ? {} : { ci: env.CI }),
		...(env.CLIO_CODER_REDUCE_MOTION === undefined ? {} : { reducedMotion: env.CLIO_CODER_REDUCE_MOTION }),
		...(env.CLIO_CODER_SCREEN_READER === undefined ? {} : { screenReader: env.CLIO_CODER_SCREEN_READER }),
		backpressureObserved,
	});
}
