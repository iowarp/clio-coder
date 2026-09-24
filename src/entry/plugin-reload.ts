import type { PluginsReloadedPayload } from "../core/bus-events.js";
import { committedPluginSnapshot, type PluginSnapshot, reloadPluginResources } from "../domains/plugins/index.js";

/** Publish data-only plugin resources before asking session caches to refresh. */
export function reloadPluginResourcesAndNotify(
	cwd: string,
	notify: (event: PluginsReloadedPayload) => void,
): PluginSnapshot {
	// Only a committed generation can be compared. Building an uncommitted one
	// here would verify every installed tree just to learn it is generation 0.
	const previous = committedPluginSnapshot(cwd);
	const next = reloadPluginResources(cwd);
	notify({
		generation: next.generation,
		previousGeneration: previous?.generation ?? 0,
		changed: previous === undefined || previous.digest !== next.digest,
		digest: next.digest,
	});
	return next;
}
