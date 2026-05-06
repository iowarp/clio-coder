import type { DomainContract } from "../../core/domain-loader.js";
import type { ClioShareArchive, ShareExportOptions, ShareImportOptions, ShareImportPlan } from "./archive.js";

export interface ShareContract extends DomainContract {
	createArchive(options?: ShareExportOptions): ClioShareArchive;
	writeArchive(outPath: string, options?: ShareExportOptions): ClioShareArchive;
	planImport(filePath: string, options?: ShareImportOptions): ShareImportPlan;
	importArchive(filePath: string, options?: ShareImportOptions): ShareImportPlan;
}
