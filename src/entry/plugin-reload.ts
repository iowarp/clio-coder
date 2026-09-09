import type { PluginsReloadedPayload } from "../core/bus-events.js";
import { type PluginSnapshot, pluginSnapshotFor, reloadPluginResources } from "../domains/plugins/index.js";

/** Publish data-only plugin resources before asking session caches to refresh. */
export function reloadPluginResourcesAndNotify(
	cwd: string,
	notify: (event: PluginsReloadedPayload) => void,
): PluginSnapshot {
	const previous = pluginSnapshotFor(cwd);
	const next = reloadPluginResources(cwd);
	notify({
		generation: next.generation,
		previousGeneration: previous.generation,
		changed: previous.generation === 0 || previous.digest !== next.digest,
		digest: next.digest,
	});
	return next;
}
