import type { DomainContract } from "../../core/domain-loader.js";
import type { ResourceDiagnostic } from "./collision.js";
import type { ProjectContextFile } from "./context-files/loader.js";
import type { PromptTemplate, PromptTemplateExpansion } from "./prompts/loader.js";

export interface ResourceList<T> {
	items: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourcesContract extends DomainContract {
	contextFiles(cwd: string): ProjectContextFile[];
	renderContextFiles(files: ReadonlyArray<ProjectContextFile>, cwd: string): string;
	skills(cwd?: string): ResourceList<never>;
	prompts(cwd?: string): ResourceList<PromptTemplate>;
	expandPromptTemplate(text: string, cwd?: string): PromptTemplateExpansion;
	themes(): ResourceList<never>;
	resolvePath(value: string, cwd?: string): string;
	reload(): Promise<void>;
}
