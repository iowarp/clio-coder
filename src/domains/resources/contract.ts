import type { DomainContract } from "../../core/domain-loader.js";
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { ResourceDiagnostic } from "./collision.js";
import type { ProjectContextFile } from "./context-files/loader.js";
import type { PromptTemplate, PromptTemplateExpansion } from "./prompts/loader.js";
import type { Skill, SkillExpansion, SkillExpansionOptions } from "./skills/loader.js";

export interface ResourceList<T> {
	items: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourcesContract extends DomainContract {
	contextFiles(cwd: string): ProjectContextFile[];
	renderContextFiles(files: ReadonlyArray<ProjectContextFile>, cwd: string): string;
	skills(cwd?: string): ResourceList<Skill>;
	expandSkillInvocation(text: string, cwd?: string, options?: SkillExpansionOptions): SkillExpansion;
	parsePendingSkillRequests(
		text: string,
		cwd?: string,
		options?: SkillExpansionOptions,
	): { text: string; pendingSkillRequests: PendingSkillRequest[] };
	prompts(cwd?: string): ResourceList<PromptTemplate>;
	expandPromptTemplate(text: string, cwd?: string): PromptTemplateExpansion;
	themes(): ResourceList<never>;
	resolvePath(value: string, cwd?: string): string;
	reload(): Promise<void>;
}
