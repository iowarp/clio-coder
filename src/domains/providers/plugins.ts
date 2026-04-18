/**
 * Loads out-of-tree runtime descriptors into the registry. Two surfaces:
 *
 *   1. `~/.clio/runtimes/`: any `.js` file whose default export is a valid
 *      RuntimeDescriptor. Resolved from `clioConfigDir()` so CLIO_HOME /
 *      CLIO_CONFIG_DIR overrides flow through.
 *   2. npm packages listed under `settings.runtimePlugins` (optional field).
 *      Each package must export a `clioRuntimes: RuntimeDescriptor[]` array.
 *
 * Missing directories, import failures, and descriptor conflicts are logged
 * to stderr but never throw — the providers domain still boots with whatever
 * subset loaded cleanly.
 */

import { join } from "node:path";

import { clioConfigDir } from "../../core/xdg.js";
import type { RuntimeRegistry } from "./registry.js";

interface PluginSettings {
	runtimePlugins?: unknown;
}

function extractPluginPackages(settings: unknown): string[] {
	if (!settings || typeof settings !== "object") return [];
	const raw = (settings as PluginSettings).runtimePlugins;
	if (!Array.isArray(raw)) return [];
	return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

export async function loadPluginRuntimes(
	registry: RuntimeRegistry,
	settings?: unknown,
): Promise<ReadonlyArray<string>> {
	const loaded: string[] = [];

	const pluginDir = join(clioConfigDir(), "runtimes");
	try {
		const ids = await registry.loadFromDir(pluginDir);
		loaded.push(...ids);
	} catch (err) {
		process.stderr.write(
			`[providers] loadFromDir ${pluginDir} failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
	}

	for (const packageName of extractPluginPackages(settings)) {
		try {
			const ids = await registry.loadFromPackage(packageName);
			loaded.push(...ids);
		} catch (err) {
			process.stderr.write(
				`[providers] loadFromPackage ${packageName} failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
		}
	}

	return loaded;
}
