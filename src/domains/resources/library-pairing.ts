/**
 * A plugin and the extension that serves it are separate packages. This is the
 * one place that says how they relate: which extension a plugin has, which
 * plugin an extension names, whether each is installed, and whether the plugin
 * is in effect, which is the only condition under which a takeover applies.
 * The browser, the lifecycle plan and the CLI all read the same answer.
 */

import type { PluginScope } from "../plugins/types.js";
import { discoverLibrary, type LibraryEntry, libraryEntryRef } from "./library.js";
import { type LibraryCopyState, libraryCopyState } from "./library-inventory.js";
import { type LibraryInstalledPackage, listInstalledLibraryPackages } from "./library-packages.js";
import type { LibraryRequirementRef } from "./library-types.js";

/** The other half of a pair, seen from one side. */
export interface LibraryPair {
	/** `extension:<id>` when seen from a plugin, `plugin:<name>` when seen from an extension. */
	ref: LibraryRequirementRef;
	role: "plugin" | "extension";
	name: string;
	/** A catalog row (or a registered local package) describes it, so it can be installed. */
	inCatalog: boolean;
	copies: Array<{ scope: PluginScope; state: LibraryCopyState }>;
	/** Plugin partner only: an effective, enabled copy exists, so a takeover applies. */
	inEffect: boolean;
}

export type LibraryPairs = ReadonlyMap<LibraryRequirementRef, LibraryPair[]>;

function copiesOf(installed: ReadonlyArray<LibraryInstalledPackage>, kind: "plugin" | "extension", name: string) {
	return installed
		.filter((item) => (item.kind ?? "plugin") === kind && item.id === name)
		.map((item) => ({ scope: item.scope, state: libraryCopyState(item) }));
}

/**
 * Pairs for every plugin and extension the catalog or this machine knows. A row
 * appears under both ends of its pair, so either side finds the other by ref.
 */
export function libraryPairsFrom(
	catalog: ReadonlyArray<Pick<LibraryEntry, "kind" | "name" | "plugin">>,
	installed: ReadonlyArray<LibraryInstalledPackage>,
): LibraryPairs {
	const serving = new Map<string, Set<string>>();
	const link = (extension: string, plugin: string | undefined): void => {
		if (!plugin) return;
		const set = serving.get(plugin) ?? new Set<string>();
		set.add(extension);
		serving.set(plugin, set);
	};
	for (const entry of catalog) if (entry.kind === "extension") link(entry.name, entry.plugin);
	for (const item of installed) if (item.kind === "extension") link(item.id, item.plugin);
	const known = (kind: "plugin" | "extension", name: string): boolean =>
		catalog.some((entry) => entry.kind === kind && entry.name === name);
	const pairs = new Map<LibraryRequirementRef, LibraryPair[]>();
	const add = (ref: LibraryRequirementRef, pair: LibraryPair): void => {
		pairs.set(ref, [...(pairs.get(ref) ?? []), pair]);
	};
	for (const [plugin, extensions] of serving) {
		const pluginCopies = installed.filter((item) => (item.kind ?? "plugin") === "plugin" && item.id === plugin);
		const inEffect = pluginCopies.some((item) => item.effective && item.enabled);
		for (const extension of [...extensions].sort()) {
			add(`plugin:${plugin}`, {
				ref: `extension:${extension}`,
				role: "extension",
				name: extension,
				inCatalog: known("extension", extension),
				copies: copiesOf(installed, "extension", extension),
				inEffect: false,
			});
			add(`extension:${extension}`, {
				ref: `plugin:${plugin}`,
				role: "plugin",
				name: plugin,
				inCatalog: known("plugin", plugin),
				copies: copiesOf(installed, "plugin", plugin),
				inEffect,
			});
		}
	}
	return pairs;
}

/** Read the catalog and this machine's installs once and pair them. */
export function readLibraryPairs(options: { cwd?: string; catalog?: string } = {}): LibraryPairs {
	const cwd = options.cwd ?? process.cwd();
	const discovery = discoverLibrary({ cwd, ...(options.catalog ? { catalog: options.catalog } : {}) });
	return libraryPairsFrom(discovery.entries, listInstalledLibraryPackages(cwd, { all: true }));
}

function where(pair: LibraryPair): string {
	return pair.copies.map((copy) => `${copy.scope} ${copy.state}`).join(", ");
}

/**
 * One sentence about a pair, for the browser's detail pane and the install
 * plan. It names the next step instead of assuming one: installing a plugin
 * never installs its extension.
 */
export function describeLibraryPair(self: Pick<LibraryEntry, "kind" | "name">, pair: LibraryPair): string {
	if (self.kind === "plugin") {
		if (pair.copies.length > 0)
			return `Served by extension ${pair.name}, installed (${where(pair)}). It answers /${self.name}:* prompts locally while both are in effect.`;
		return pair.inCatalog
			? `Served by extension ${pair.name}, available in the Library and not installed. Installing a plugin never installs its extension; install ${pair.ref} separately to add its commands and workspace.`
			: `Served by extension ${pair.name}, which is neither installed nor in the Library.`;
	}
	if (pair.inEffect)
		return `Serves plugin ${pair.name}, installed and in effect (${where(pair)}); this extension answers /${pair.name}:* prompts locally.`;
	if (pair.copies.length > 0)
		return `Serves plugin ${pair.name}, installed but not in effect (${where(pair)}). No /${pair.name}:* takeover applies until that plugin is enabled and effective; the extension's own /ext:${self.name}:* commands still work.`;
	return pair.inCatalog
		? `Serves plugin ${pair.name}, available in the Library and not installed. No /${pair.name}:* takeover applies until it is installed; the extension's own /ext:${self.name}:* commands still work.`
		: `Serves plugin ${pair.name}, which is not installed and not in the Library. No takeover applies; the extension's own /ext:${self.name}:* commands still work.`;
}

export { libraryEntryRef };
