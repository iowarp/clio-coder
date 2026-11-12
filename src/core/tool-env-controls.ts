import {
	autonomyRank,
	isAutonomyLevel,
	YOLO_CONFINEMENT_PIN_ENV,
	yoloConfinementPinned,
} from "../domains/safety/autonomy.js";

/**
 * Names the autonomy a `clio-coder` started from a tool command may take at most, so a delegated run never gets more
 * autonomy than the session that started it. `run`, `research` and `arena` refuse `--autonomy yolo` under it.
 */
export const AUTONOMY_CEILING_ENV = "CLIO_CODER_AUTONOMY_CEILING";

// Non-interactive bash sources BASH_ENV before the script admission read, and
// an inherited CDPATH sends a relative cd somewhere the command does not name,
// while admission resolves cds from the command's text alone. ENV stays: no
// non-interactive shell sources it, and apps read it as ENV=production.
const CLIO_CONTROL_ENV_KEYS = ["CLIO_CODER_INTERACTIVE", "BASH_ENV", "CDPATH"] as const;

/** The keys Clio writes into a command's environment from its live state; only `process.env` may carry inherited ones. */
export const GENERATED_TOOL_ENV_KEYS = [AUTONOMY_CEILING_ENV, YOLO_CONFINEMENT_PIN_ENV] as const;

let toolEnvAutonomy: (() => string) | null = null;
let toolEnvContainedYolo: (() => boolean) | null = null;

/**
 * Registers the live autonomy of this process's session, and whether it runs contained yolo, read on every command so
 * a level change lands at once.
 */
export function setToolEnvAutonomy(read: (() => string) | null, containedYolo: (() => boolean) | null = null): void {
	toolEnvAutonomy = read;
	toolEnvContainedYolo = containedYolo;
}

/** A session below yolo sets its own level; one at yolo passes on only a ceiling it inherited itself. */
function toolEnvAutonomyCeiling(): string | undefined {
	const live = toolEnvAutonomy?.();
	if (live !== undefined && live !== "yolo") return live;
	const inherited = process.env[AUTONOMY_CEILING_ENV];
	return inherited !== undefined && inherited !== "" ? inherited : undefined;
}

/** The stricter of two ceilings: a caller's is kept only when it names a level below the live one. */
function stricterCeiling(live: string | undefined, given: string | undefined): string | undefined {
	if (given === undefined || !isAutonomyLevel(given)) return live;
	if (live === undefined) return given;
	if (isAutonomyLevel(live) && autonomyRank(given) < autonomyRank(live)) return given;
	return live;
}

/**
 * Drops the keys that steer a shell or Clio itself from a tool command's environment, then sets the autonomy ceiling
 * and contained-yolo pin from the live state. The environment given may only tighten them: its ceiling stays when it
 * is stricter than the live one, and its pin stays (any value reads as contained), as arena sets for its contenders.
 * Bash commands, run_script, verify and every other safe-exec child share it.
 */
export function applyToolEnvControls(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const givenCeiling = env[AUTONOMY_CEILING_ENV];
	const givenPin = yoloConfinementPinned(env);
	for (const key of CLIO_CONTROL_ENV_KEYS) Reflect.deleteProperty(env, key);
	for (const key of GENERATED_TOOL_ENV_KEYS) Reflect.deleteProperty(env, key);
	const ceiling = stricterCeiling(toolEnvAutonomyCeiling(), givenCeiling);
	if (ceiling !== undefined) env[AUTONOMY_CEILING_ENV] = ceiling;
	// A contained-yolo session, one launched pinned, or a caller pinning its child holds every clio-coder to contained yolo.
	if (givenPin || toolEnvContainedYolo?.() === true || yoloConfinementPinned())
		env[YOLO_CONFINEMENT_PIN_ENV] = "contained";
	return env;
}
