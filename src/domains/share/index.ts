import type { DomainModule } from "../../core/domain-loader.js";
import { createShareBundle } from "./extension.js";
import { ShareManifest } from "./manifest.js";

export const ShareDomainModule: DomainModule = {
	manifest: ShareManifest,
	createExtension: createShareBundle,
};

export {
	type ClioShareArchive,
	createShareArchive,
	importShareArchive,
	planShareImport,
	readShareArchive,
	type ShareArchiveFile,
	type ShareArchiveManifest,
	type ShareDiagnostic,
	type ShareEntryType,
	type ShareExportOptions,
	type ShareImportAction,
	type ShareImportOptions,
	type ShareImportPlan,
	type ShareScope,
	writeShareArchive,
} from "./archive.js";
export type { ShareContract } from "./contract.js";
export { ShareManifest } from "./manifest.js";
