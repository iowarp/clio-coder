/**
 * Loads out-of-tree runtime descriptors into the registry. Two surfaces:
 *
 *   1. `~/.config/clio-coder/runtimes/`: any `.js` file whose default export is a valid
 *      RuntimeDescriptor. Resolved from `clioConfigDir()` so CLIO_CODER_HOME /
 *      CLIO_CODER_CONFIG_DIR overrides flow through.
 *   2. npm packages listed under `settings.integrations.runtimePlugins`.
 *      Each package must export a `clioRuntimes: RuntimeDescriptor[]` array.
 *
 * Missing directories, import failures, and descriptor conflicts are logged
 * to stderr but never throw. The providers domain still boots with whatever
 * subset loaded cleanly.
 */

import { join } from "node:path";

import type { ClioSettings } from "../../core/config.js";
import { clioConfigDir } from "../../core/xdg.js";
import { activateExternalPluginApiBridge } from "../../engine/api-registry.js";
import type { RuntimeRegistry } from "./registry.js";

export async function loadPluginRuntimes(
	registry: RuntimeRegistry,
	settings?: Pick<ClioSettings, "integrations">,
): Promise<ReadonlyArray<string>> {
	const loaded: string[] = [];

	const pluginDir = join(clioConfigDir(), "runtimes");
	const packages = settings?.integrations.runtimePlugins ?? [];
	try {
		const ids = await registry.loadFromDir(pluginDir, activateExternalPluginApiBridge);
		loaded.push(...ids);
	} catch (err) {
		process.stderr.write(
			`[providers] loadFromDir ${pluginDir} failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}

	for (const packageName of packages) {
		try {
			const ids = await registry.loadFromPackage(packageName, activateExternalPluginApiBridge);
			loaded.push(...ids);
		} catch (err) {
			process.stderr.write(
				`[providers] loadFromPackage ${packageName} failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	return loaded;
}
