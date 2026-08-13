/**
 * Per-process switch for the RETRIEVE plane, the only builtin plane that
 * leaves the machine.
 *
 * There is no per-run tool allowlist on the main-agent path: a headless
 * `clio run` gets whatever `registerAllTools` registered, and the registry
 * answers an unregistered name with a `not_visible` verdict. So the existing
 * lever for "this run has no network" is registration itself, the same lever
 * that already keeps `ask_user` out of headless and worker registries. This
 * module carries the switch that lever reads.
 *
 * The channel is an environment variable because the process that needs the
 * policy is a child: the skill-eval harness spawns `clio run` for each arm,
 * and any worker those runs dispatch is a grandchild. Env inherits down the
 * whole tree, so one setting at spawn time covers every registry built below
 * it (`src/tools/bootstrap.ts`, `src/engine/worker-tools.ts`) without a flag
 * threaded through four call layers.
 *
 * What this does not cover: a runtime that executes its own tool surface
 * outside Clio's mediation (an external CLI subprocess) never consults this
 * registry, so its network access is its own to answer for.
 */

/** Set to "1" to strip network tools from every registry built in this process. */
export const NO_NETWORK_TOOLS_ENV = "CLIO_NO_NETWORK_TOOLS";

export function networkToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[NO_NETWORK_TOOLS_ENV] === "1";
}
