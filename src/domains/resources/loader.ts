import type { PendingSkillRequest } from "../../core/skill-activation.js";
import { withPluginDiscoveryPass } from "../plugins/index.js";
import type { ResourceDiagnostic } from "./collision.js";
import {
	expandPromptTemplateInput,
	type LoadPromptTemplatesInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
	parsePromptCommand,
} from "./prompts/loader.js";
import {
	type LoadSkillsInput,
	loadSkills,
	parsePendingSkillRequests,
	parseSkillCommand,
	type Skill,
	type SkillExpansionOptions,
} from "./skills/loader.js";

export interface ResourceList<T> {
	items: T[];
	diagnostics: ResourceDiagnostic[];
}

export interface ResourceLoaderOptions {
	cwd?: string;
	/** Slash-command names prompt templates may not claim. */
	reservedPromptNames?: ReadonlySet<string>;
	skills?: () => Pick<LoadSkillsInput, "trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths">;
}

export interface ResourcesLoader {
	skills(cwd?: string): ResourceList<Skill>;
	/** Skills for naming only; see {@link ResourcesContract.skillsForDisplay}. */
	skillsForDisplay(cwd?: string): ResourceList<Skill>;
	parsePendingSkillRequests(
		text: string,
		cwd?: string,
		options?: SkillExpansionOptions,
	): { text: string; pendingSkillRequests: PendingSkillRequest[] };
	prompts(cwd?: string): ResourceList<PromptTemplate>;
	/** Prompt templates for display only; see {@link ResourcesContract.promptsForDisplay}. */
	promptsForDisplay(cwd?: string): ResourceList<PromptTemplate>;
	expandPromptTemplate(text: string, cwd?: string): PromptTemplateExpansion;
	reload(): Promise<void>;
}

export function createResourcesLoader(options: ResourceLoaderOptions = {}): ResourcesLoader {
	const defaultCwd = options.cwd ?? process.cwd();
	const skillOptions = (): Pick<
		LoadSkillsInput,
		"trustProjectCompatRoots" | "disableDiscovery" | "explicitSkillPaths"
	> => options.skills?.() ?? {};
	// Prompts share the skills opt-in: a project compatibility root is the same
	// trust decision whichever kind is read out of it.
	const promptOptions = (cwd: string): LoadPromptTemplatesInput => ({
		cwd,
		...(options.reservedPromptNames !== undefined ? { reservedNames: options.reservedPromptNames } : {}),
		...(skillOptions().trustProjectCompatRoots !== undefined
			? { trustProjectCompatRoots: skillOptions().trustProjectCompatRoots === true }
			: {}),
	});
	return {
		skills(cwd = defaultCwd) {
			return loadSkills({ cwd, ...skillOptions() });
		},
		skillsForDisplay(cwd = defaultCwd) {
			return loadSkills({ cwd, ...skillOptions(), verifyPluginTrees: false });
		},
		parsePendingSkillRequests(text, cwd = defaultCwd, expansionOptions = {}) {
			// Plain text names no skill. Checking the prefix first keeps an ordinary
			// submit from paying a full plugin walk for a catalog it never reads.
			if (parseSkillCommand(text) === null) return { text, pendingSkillRequests: [] };
			// A name no skill claims goes on to the installed-name and marketplace
			// lookups, and one pass verifies each plugin tree once across all three.
			return withPluginDiscoveryPass(() =>
				parsePendingSkillRequests(text, loadSkills({ cwd, ...skillOptions() }), { cwd, ...expansionOptions }),
			);
		},
		prompts(cwd = defaultCwd) {
			return loadPromptTemplates(promptOptions(cwd));
		},
		promptsForDisplay(cwd = defaultCwd) {
			return loadPromptTemplates({ ...promptOptions(cwd), verifyPluginTrees: false });
		},
		expandPromptTemplate(text, cwd = defaultCwd) {
			// Only `/name` can expand, and no caller reads an unexpanded result's
			// diagnostics, so text without the prefix skips the template listing.
			const command = parsePromptCommand(text);
			if (command === null) return { expanded: false, text, args: [], diagnostics: [] };
			return withPluginDiscoveryPass(() => {
				// A verified read only narrows the committed snapshot's roots, so a name
				// absent from the listing cannot expand and needs no tree walk. Unknown
				// commands reach here on every typo, before anything has painted.
				const listed = loadPromptTemplates({ ...promptOptions(cwd), verifyPluginTrees: false });
				if (!listed.items.some((template) => template.name === command.name))
					return expandPromptTemplateInput(text, listed);
				return expandPromptTemplateInput(text, loadPromptTemplates(promptOptions(cwd)));
			});
		},
		async reload() {
			return undefined;
		},
	};
}
