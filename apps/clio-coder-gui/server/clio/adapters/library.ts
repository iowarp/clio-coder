import { listInstalledExtensions } from "../../../../../src/domains/extensions/manager.js";
import { readLibraryInventory } from "../../../../../src/domains/resources/library-inventory.js";

export function readLibrary(input: { cwd: string; kind: "inventory" | "extensions" }) {
	if (input.kind === "inventory") return readLibraryInventory({ cwd: input.cwd });
	return {
		extensions: listInstalledExtensions(input.cwd, { all: true }).map((row) => ({
			id: row.id,
			name: row.name,
			version: row.version,
			description: row.description,
			scope: row.scope,
			enabled: row.enabled,
			valid: row.valid,
			compatible: row.compatible,
			effective: row.effective,
			loadable: row.loadable,
			capabilities: row.capabilities ?? null,
			runtime: row.runtime ?? null,
			provenance: row.provenance ?? null,
			diagnostics: row.diagnostics,
		})),
	};
}
