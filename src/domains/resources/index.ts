import type { DomainModule } from "../../core/domain-loader.js";
import { createResourcesBundle } from "./extension.js";
import { ResourcesManifest } from "./manifest.js";

export const ResourcesDomainModule: DomainModule = {
	manifest: ResourcesManifest,
	createExtension: createResourcesBundle,
};

export type { ResourceDiagnostic, ResourceScope, ResourceSourceInfo } from "./collision.js";
export { resolveResourceCollisions } from "./collision.js";
export {
	DEFAULT_CONTEXT_FILE_NAMES,
	loadDevContextFile,
	loadProjectContextFiles,
	type ProjectContextFile,
	renderProjectContextFiles,
} from "./context-files/loader.js";
export type { ResourcesContract } from "./contract.js";
export { createResourcesLoader } from "./loader.js";
export { ResourcesManifest } from "./manifest.js";
