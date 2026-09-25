import type { DomainContract } from "../../core/domain-loader.js";
import type { ClioShareArchive, ShareExportOptions, ShareImportOptions, ShareImportPlan } from "./archive.js";

export interface ShareContract extends DomainContract {
	writeArchive(outPath: string, options?: ShareExportOptions): ClioShareArchive;
	planImport(filePath: string, options?: ShareImportOptions): ShareImportPlan;
	importArchive(filePath: string, options?: ShareImportOptions): ShareImportPlan;
}
