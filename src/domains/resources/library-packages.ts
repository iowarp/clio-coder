import { existsSync } from "node:fs";
import path from "node:path";
import { withStateFileLockSync } from "../../core/state-file-lock.js";
import {
	extensionBaseDir,
	type InstalledExtension,
	listInstalledExtensions,
	loadManifestFromRoot,
	readExtensionInstallRecord,
} from "../extensions/index.js";
import {
	type InstalledPlugin,
	listInstalledPlugins,
	observePluginCopy,
	type PluginCandidate,
	type PluginExpectedCopy,
	type PluginInstallRecord,
	type PluginListOptions,
	type PluginManifest,
	type PluginScope,
	pluginBaseDir,
	pluginContentDigest,
	readPluginInstallRecord,
	readPluginManifest,
	withPluginScopeLock,
} from "../plugins/index.js";
import type { LibraryEntryKind } from "./library-types.js";

/** Library-only projection: a standalone extension never acquires a plugin.json or plugin install record. */
function extensionManifest(entry: Pick<InstalledExtension, "id" | "version" | "description">): PluginManifest {
	return {
		$schema: "",
		name: entry.id,
		version: entry.version,
		description: entry.description,
		clio: { manifestVersion: 1, kind: "extension", resources: {}, components: [] },
	};
}
export function readLibraryManifest(root: string): PluginCandidate {
	if (existsSync(path.join(root, "plugin.json"))) return readPluginManifest(root);
	const candidate = loadManifestFromRoot(root);
	const { manifest, ...details } = candidate;
	return {
		...details,
		...(manifest ? { manifest: extensionManifest(manifest) } : {}),
		...(candidate.valid ? { contentDigest: pluginContentDigest(root) } : {}),
	};
}
/** The library lists installed packages; a dev package is a session overlay and never one of them. */
export function extensionLibraryCopy(entry: InstalledExtension): InstalledPlugin {
	if (entry.scope === "dev") throw new Error(`dev extension ${entry.id} is not a library package`);
	const { provenance, overriddenBy, ...rest } = entry;
	return {
		...rest,
		scope: entry.scope,
		...(provenance ? { provenance: { ...provenance, scope: entry.scope } } : {}),
		...(overriddenBy !== undefined && overriddenBy !== "dev" ? { overriddenBy } : {}),
		kind: "extension",
		resources: {},
		manifest: extensionManifest(entry),
		trust: "trusted",
	};
}
export function listInstalledLibraryPackages(cwd = process.cwd(), options: PluginListOptions = {}): InstalledPlugin[] {
	return [
		...listInstalledPlugins(cwd, options),
		...listInstalledExtensions(cwd, options)
			.filter((entry) => !entry.bundle && entry.scope !== "dev")
			.map(extensionLibraryCopy),
	];
}
export function libraryPackageBaseDir(kind: LibraryEntryKind, scope: PluginScope, cwd: string): string {
	return kind === "extension" ? extensionBaseDir(scope, cwd) : pluginBaseDir(scope, cwd);
}
export function readLibraryInstallRecord(
	id: string,
	options: PluginListOptions,
	kind?: LibraryEntryKind,
): PluginInstallRecord | undefined {
	if (kind !== "extension") return readPluginInstallRecord(id, options);
	const saved = readExtensionInstallRecord(id, options);
	return saved?.contentDigest
		? {
				kind: "extension",
				installedAt: saved.installedAt,
				source: saved.source ?? "",
				contentDigest: saved.contentDigest,
			}
		: undefined;
}
export function observeLibraryCopy(
	scope: PluginScope,
	id: string,
	cwd: string,
	kind: LibraryEntryKind,
): PluginExpectedCopy {
	if (kind !== "extension") return observePluginCopy(scope, id, cwd);
	const root = path.join(extensionBaseDir(scope, cwd), id);
	const saved = readExtensionInstallRecord(id, { cwd, scope });
	const copy = listInstalledExtensions(cwd, { scope, all: true }).find((entry) => entry.id === id && !entry.bundle);
	return {
		scope,
		id,
		recorded: saved !== undefined,
		tree: existsSync(root) ? pluginContentDigest(root) : "absent",
		...(saved
			? { ...(saved.contentDigest ? { recordedDigest: saved.contentDigest } : {}), kind: "extension" as const }
			: {}),
		...(copy ? { enabled: copy.enabled, trust: "trusted" as const } : {}),
	};
}
export function withLibraryScopeLock<T>(
	kind: LibraryEntryKind,
	scope: PluginScope,
	cwd: string,
	operation: () => T,
): T {
	return kind === "extension"
		? withStateFileLockSync(path.join(extensionBaseDir(scope, cwd), "state.json"), operation)
		: withPluginScopeLock(scope, cwd, operation);
}
