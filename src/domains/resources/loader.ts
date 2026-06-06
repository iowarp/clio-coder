import { expandConfigPath } from "../../core/resolve-config-value.js";
import type { ResourceDiagnostic } from "./collision.js";
import {
	type LoadProjectContextFilesInput,
	loadProjectContextFiles,
	type ProjectContextFile,
	renderProjectContextFiles,
} from "./context-files/loader.js";
import {
	expandPromptTemplateInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
} from "./prompts/loader.js";
import {
	expandSkillInvocationInput,
	formatSkillsCatalogForPrompt,
	type LoadSkillsInput,
	loadSkills,
	type Skill,
	type SkillExpansion,
} from "./skills/loader.js";

export interface ResourceList<T> {
	items: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourceLoaderOptions {
	cwd?: string;
	noContextFiles?: boolean;
	skills?: () => Pick<LoadSkillsInput, "trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths">;
}

export interface ResourcesLoader {
	contextFiles(cwd?: string, options?: Omit<LoadProjectContextFilesInput, "cwd">): ProjectContextFile[];
	renderContextFiles(files: ReadonlyArray<ProjectContextFile>, cwd?: string): string;
	skills(cwd?: string): ResourceList<Skill>;
	skillsCatalog(cwd?: string): string;
	expandSkillInvocation(text: string, cwd?: string): SkillExpansion;
	prompts(cwd?: string): ResourceList<PromptTemplate>;
	expandPromptTemplate(text: string, cwd?: string): PromptTemplateExpansion;
	themes(): ResourceList<never>;
	resolvePath(value: string, cwd?: string): string;
	reload(): Promise<void>;
}

export function createResourcesLoader(options: ResourceLoaderOptions = {}): ResourcesLoader {
	const defaultCwd = options.cwd ?? process.cwd();
	const noContextFiles = options.noContextFiles === true;
	const skillOptions = (): Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	> => options.skills?.() ?? {};
	return {
		contextFiles(cwd = defaultCwd, contextOptions = {}) {
			if (noContextFiles) return [];
			return loadProjectContextFiles({ cwd, ...contextOptions });
		},
		renderContextFiles(files, cwd = defaultCwd) {
			return renderProjectContextFiles(files, cwd);
		},
		skills(cwd = defaultCwd) {
			return loadSkills({ cwd, ...skillOptions() });
		},
		skillsCatalog(cwd = defaultCwd) {
			return formatSkillsCatalogForPrompt(loadSkills({ cwd, ...skillOptions() }));
		},
		expandSkillInvocation(text, cwd = defaultCwd) {
			return expandSkillInvocationInput(text, loadSkills({ cwd, ...skillOptions() }));
		},
		prompts(cwd = defaultCwd) {
			return loadPromptTemplates({ cwd });
		},
		expandPromptTemplate(text, cwd = defaultCwd) {
			return expandPromptTemplateInput(text, loadPromptTemplates({ cwd }));
		},
		themes() {
			return { items: [], diagnostics: [] };
		},
		resolvePath(value, cwd = defaultCwd) {
			return expandConfigPath(value, { cwd });
		},
		async reload() {
			return undefined;
		},
	};
}
