import type { DomainContract } from "../../core/domain-loader.js";
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import type { ResourceDiagnostic } from "./collision.js";
import type { PromptTemplate, PromptTemplateExpansion } from "./prompts/loader.js";
import type { Skill, SkillExpansion, SkillExpansionOptions } from "./skills/loader.js";

export interface ResourceList<T> {
	items: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourcesContract extends DomainContract {
	skills(cwd?: string): ResourceList<Skill>;
	expandSkillInvocation(text: string, cwd?: string, options?: SkillExpansionOptions): SkillExpansion;
	parsePendingSkillRequests(
		text: string,
		cwd?: string,
		options?: SkillExpansionOptions,
	): { text: string; pendingSkillRequests: PendingSkillRequest[] };
	prompts(cwd?: string): ResourceList<PromptTemplate>;
	/**
	 * Prompt templates listed from the committed plugin snapshot without
	 * re-verifying plugin trees, so a keystroke does not pay a plugin walk. For
	 * display only: a template revoked or drifted since the last reload may be
	 * listed, and expandPromptTemplate still verifies before anything runs.
	 */
	promptsForDisplay(cwd?: string): ResourceList<PromptTemplate>;
	expandPromptTemplate(text: string, cwd?: string): PromptTemplateExpansion;
	resolvePath(value: string, cwd?: string): string;
	reload(): Promise<void>;
}
