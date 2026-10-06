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
/** An installed package as the library lists it; an extension copy also names the plugin it serves. */
export type LibraryInstalledPackage = InstalledPlugin & { plugin?: string };

/** The library lists installed packages; a dev package is a session overlay and never one of them. */
export function extensionLibraryCopy(entry: InstalledExtension): LibraryInstalledPackage {
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
export function listInstalledLibraryPackages(
	cwd = process.cwd(),
	options: PluginListOptions = {},
): LibraryInstalledPackage[] {
	return [
		...listInstalledPlugins(cwd, options),
		...listInstalledExtensions(cwd, options)
			.filter((entry) => entry.scope !== "dev")
			.map(extensionLibraryCopy),
	];
}
/**
 * Plugin-format packages share one id space per scope; a standalone extension
 * has its own directory and never competes with a plugin of the same name.
 */
export function libraryNamespace(kind: LibraryEntryKind | undefined): "extension" | "plugin" {
	return kind === "extension" ? "extension" : "plugin";
}
/** The source id the loaders and the inventory carry for a copy's own resources. */
export function libraryCopySourceId(copy: {
	kind?: LibraryEntryKind | undefined;
	scope: PluginScope;
	name: string;
}): string {
	return `${libraryNamespace(copy.kind)}:${copy.scope}:${copy.name}`;
}
/**
 * The installed copies a ref names, project scope first. `kind:name` is exact.
 * A bare name that both a plugin-format package and an extension carry is
 * refused with both refs, as install refuses an ambiguous catalog name.
 */
export function installedCopiesNamed<T extends Pick<LibraryInstalledPackage, "id" | "kind" | "scope">>(
	copies: ReadonlyArray<T>,
	ref: string,
): T[] {
	const exact = ref.includes(":");
	const named = copies.filter((item) => (exact ? `${item.kind ?? "plugin"}:${item.id}` === ref : item.id === ref));
	if (!exact && new Set(named.map((item) => libraryNamespace(item.kind))).size > 1) {
		const refs = [...new Set(named.map((item) => `${item.kind ?? "plugin"}:${item.id}`))].sort();
		throw new Error(`ambiguous package: ${ref}; use ${refs.join(" or ")}`);
	}
	return named.sort((a, b) => Number(b.scope === "project") - Number(a.scope === "project"));
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
				...(saved.origin ? { origin: saved.origin } : {}),
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
	const copy = listInstalledExtensions(cwd, { scope, all: true }).find((entry) => entry.id === id);
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
