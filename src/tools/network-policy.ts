/**
 * Process-wide registration switch for the RETRIEVE tool plane (web_fetch).
 * This removes retrieval tools from main and worker registries. It does not
 * restrict bash, hooks, external CLIs, or provider traffic. Hermetic execution
 * requires an OS network sandbox supplied by the operator or eval harness.
 * The environment setting propagates to child registries without per-run wiring.
 */
export const NO_NETWORK_TOOLS_ENV = "CLIO_CODER_DISABLE_RETRIEVE_TOOLS";

/** Legacy spelling remains accepted for existing harnesses; neither is a sandbox. */
export function networkToolsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[NO_NETWORK_TOOLS_ENV] === "1" || env.CLIO_CODER_NO_NETWORK_TOOLS === "1";
}

/** Operator process opt-in; never accepted from model arguments or project settings. */
export const WEB_FETCH_ALLOW_PRIVATE_NETWORK_ENV = "CLIO_CODER_WEB_FETCH_ALLOW_PRIVATE_NETWORK";
