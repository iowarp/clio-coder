import { listInstalledExtensions } from "../../../../../src/domains/extensions/manager.js";
import { readLibraryInventory } from "../../../../../src/domains/resources/library-inventory.js";

/**
 * `os.homedir()` inside a worker thread reads the process's real environment, not the environment the
 * worker was started with. The home directory therefore comes from the worker's own `process.env`,
 * which is the same value in normal use and the scratch home under test.
 */
function workerHome(): string | undefined {
	return process.env.HOME || process.env.USERPROFILE || undefined;
}

export function readLibrary(input: { cwd: string; kind: "inventory" | "extensions" }) {
	const home = workerHome();
	if (input.kind === "inventory") return readLibraryInventory({ cwd: input.cwd, ...(home ? { home } : {}) });
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
