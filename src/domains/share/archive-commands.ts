import { resolve } from "node:path";
import type { ShareImportPlan } from "./archive.js";
import type { ShareContract } from "./contract.js";

/**
 * `/archive export` and `/archive import` as every host wires them: paths
 * resolve against the process cwd, an export takes the project scope, and a
 * dry run plans without writing. The terminal and ACP hosts both bind this, so
 * a GUI archive and a terminal archive are the same archive.
 */
export function archiveCommandHost(share: ShareContract | undefined): {
	exportShareArchive(outPath: string): { fileCount: number; path: string };
	importShareArchive(archivePath: string, options: { dryRun?: boolean; force?: boolean }): ShareImportPlan;
} {
	return {
		exportShareArchive: (outPath) => {
			if (!share) throw new Error("share domain is not loaded");
			const path = resolve(outPath);
			const archive = share.writeArchive(path, { scope: "project" });
			return { fileCount: archive.files.length, path };
		},
		importShareArchive: (archivePath, options) => {
			if (!share) {
				return {
					archive: null,
					actions: [],
					diagnostics: [{ type: "error", message: "share domain is not loaded" }],
				};
			}
			const importOptions = {
				...(options.dryRun ? { dryRun: true } : {}),
				...(options.force ? { force: true } : {}),
			};
			return options.dryRun
				? share.planImport(resolve(archivePath), importOptions)
				: share.importArchive(resolve(archivePath), importOptions);
		},
	};
}
