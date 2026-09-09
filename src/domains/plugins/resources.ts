import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { clioConfigDir } from "../../core/xdg.js";
import { PLUGIN_RESOURCE_KINDS, pluginResourcePath } from "./discovery.js";
import { listInstalledPlugins } from "./state.js";
import type { PluginResourceKind, PluginResourceRoot, PluginSnapshot } from "./types.js";

const snapshots = new Map<string, PluginSnapshot>();
let generation = 0;

function keyFor(cwd: string): string {
	return `${path.resolve(clioConfigDir())}\0${realpathSync(path.resolve(cwd))}`;
}

function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

export function buildPluginSnapshot(cwd = process.cwd(), snapshotGeneration = 0): PluginSnapshot {
	const canonicalCwd = realpathSync(path.resolve(cwd));
	const packages = listInstalledPlugins(canonicalCwd, { all: true });
	const resourceRoots: Record<PluginResourceKind, PluginResourceRoot[]> = {
		skills: [],
		prompts: [],
		agents: [],
		fleets: [],
		themes: [],
	};
	for (const item of packages) {
		if (!item.loadable || !item.provenance) continue;
		for (const kind of PLUGIN_RESOURCE_KINDS) {
			const relative = item.resources[kind];
			if (!relative) continue;
			resourceRoots[kind].push({
				id: item.id,
				scope: item.scope,
				path: pluginResourcePath(item.rootPath, relative, item.kind === "skill" && relative === "."),
				rootPath: item.rootPath,
				source: `plugin:${item.scope}:${item.id}`,
				provenance: item.provenance,
				generation: snapshotGeneration,
				trust: item.trust ?? "trusted",
			});
		}
	}
	const identity = packages.map((item) => ({
		id: item.id,
		scope: item.scope,
		rootPath: item.rootPath,
		enabled: item.enabled,
		loadable: item.loadable,
		contentDigest: item.observedContentDigest,
	}));
	return freeze({
		version: 1,
		generation: snapshotGeneration,
		cwd: canonicalCwd,
		digest: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
		packages,
		resourceRoots,
	});
}

export function pluginSnapshotFor(cwd = process.cwd()): PluginSnapshot {
	return snapshots.get(keyFor(cwd)) ?? buildPluginSnapshot(cwd);
}

/** Build completely before replacing the committed projection. */
export function reloadPluginResources(cwd = process.cwd()): PluginSnapshot {
	const key = keyFor(cwd);
	const next = buildPluginSnapshot(cwd, ++generation);
	snapshots.set(key, next);
	return next;
}

export function clearPluginSnapshots(): void {
	snapshots.clear();
}

export function enabledPluginResourceRoots(kind: PluginResourceKind, cwd = process.cwd()): PluginResourceRoot[] {
	const snapshot = pluginSnapshotFor(cwd);
	if (snapshot.generation === 0) return [...snapshot.resourceRoots[kind]];
	// A reload controls additions and replacements. Revocation and content drift
	// take effect on the next read, including before a planned session reload.
	const current = listInstalledPlugins(cwd, { all: true });
	return snapshot.resourceRoots[kind].filter((root) =>
		current.some(
			(item) =>
				item.loadable &&
				item.id === root.id &&
				item.scope === root.scope &&
				item.provenance?.canonicalRoot === root.provenance.canonicalRoot &&
				item.provenance?.manifestDigest === root.provenance.manifestDigest &&
				item.provenance?.contentDigest === root.provenance.contentDigest,
		),
	);
}
