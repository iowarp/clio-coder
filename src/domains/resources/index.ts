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
export type { ResourceList, ResourcesContract } from "./contract.js";
export { createResourcesLoader } from "./loader.js";
export { ResourcesManifest } from "./manifest.js";
export {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
	type PromptTemplateList,
	type PromptTemplateRoot,
} from "./prompts/loader.js";
export { parseCommandArgs, substituteArgs } from "./prompts/substitute.js";
export {
	expandSkillInvocationInput,
	loadSkills,
	type Skill,
	type SkillExpansion,
	type SkillList,
	type SkillRoot,
} from "./skills/loader.js";
