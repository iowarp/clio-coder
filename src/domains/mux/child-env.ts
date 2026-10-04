/**
 * The environment a Clio that Clio starts in a pane is given explicitly.
 *
 * A pane is spawned by the pane host's server, so without this it runs under
 * the environment that server was started with, which may be another terminal's
 * or an earlier launch's. A parent running against its own directories or with
 * a key exported in its shell would then open a peer that resolves the default
 * home, cannot see the key, and reads a different state directory from the one
 * the peer inbox is written under.
 *
 * Only what decides where Clio keeps its files and how its configured targets
 * authenticate is passed: Clio's own variables, the temp and XDG base
 * directories when the parent defines them, and the credential variables its
 * targets name. Nothing else is set, so the pane's HOME, PATH and shell stay
 * the host's. The parent's `HERDR_*` coordinates are never passed: the host
 * gives the new pane its own identity, and a forwarded pane id would make the
 * child report and listen as its parent.
 */

import { findBuiltinRuntimeBootMetadata } from "../providers/runtimes/boot-manifest.js";

const BASE_DIRECTORY_VARS = ["TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];

export function clioPaneEnv(
	env: NodeJS.ProcessEnv,
	targets: ReadonlyArray<{ runtime: string; auth?: { apiKeyEnvVar?: string } }>,
): Record<string, string> {
	const names = new Set<string>(BASE_DIRECTORY_VARS);
	for (const name of Object.keys(env)) {
		if (name.startsWith("CLIO_CODER_")) names.add(name);
	}
	for (const target of targets) {
		const declared = target.auth?.apiKeyEnvVar?.trim();
		if (declared) names.add(declared);
		const runtimeDefault = findBuiltinRuntimeBootMetadata(target.runtime)?.credentialsEnvVar;
		if (runtimeDefault) names.add(runtimeDefault);
	}
	const out: Record<string, string> = {};
	for (const name of names) {
		const value = env[name];
		if (typeof value === "string" && value.length > 0 && !name.startsWith("HERDR_")) out[name] = value;
	}
	return out;
}
