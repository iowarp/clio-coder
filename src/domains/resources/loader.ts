import type { ModelTier } from "../../core/model-tier.js";
import type { PendingSkillRequest } from "../../core/skill-activation.js";
import { enabledPluginResourceRootsFor, withPluginDiscoveryPass } from "../plugins/index.js";
import type { ResourceDiagnostic } from "./collision.js";
import {
	expandPromptTemplateInput,
	type LoadPromptTemplatesInput,
	loadPromptTemplates,
	type PromptTemplate,
	type PromptTemplateExpansion,
	type PromptTemplateExpansionOptions,
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
	/** The tier of the model a submitted turn runs on, for template variants; absent reads as `standard`. */
	modelTier?: () => ModelTier | undefined;
}

export interface ResourcesLoader {
	skills(cwd?: string): ResourceList<Skill>;
	/** Skills for naming only; see {@link ResourcesContract.skillsForDisplay}. */
	skillsForDisplay(cwd?: string): ResourceList<Skill>;
	/** See {@link ResourcesContract.skillsStillVerified}. */
	skillsStillVerified(skills: ReadonlyArray<Skill>, cwd?: string): Skill[];
	parsePendingSkillRequests(
		text: string,
		cwd?: string,
		options?: SkillExpansionOptions,
	): { text: string; pendingSkillRequests: PendingSkillRequest[] };
	prompts(cwd?: string): ResourceList<PromptTemplate>;
	/** Prompt templates for display only; see {@link ResourcesContract.promptsForDisplay}. */
	promptsForDisplay(cwd?: string): ResourceList<PromptTemplate>;
	expandPromptTemplate(text: string, cwd?: string, options?: PromptTemplateExpansionOptions): PromptTemplateExpansion;
	reload(): Promise<void>;
}

/**
 * A plugin template the session listed at its last reload but whose tree no
 * longer verifies, almost always because the plugin was reinstalled or edited
 * under the running session. Saying "not a command" for a name autocomplete
 * still offers sent operators looking for a typo, while the plugin's extension
 * kept running the copy it started from (WTF-P, 2026-11-15). The refusal names
 * the reload instead, and keeps the literal line away from the model.
 */
function driftedPluginTemplate(
	expansion: Extract<PromptTemplateExpansion, { expanded: false }>,
	template: PromptTemplate,
): PromptTemplateExpansion {
	const owner = template.sourceInfo.owner;
	if (owner?.kind !== "plugin") return expansion;
	return {
		...expansion,
		refusal: {
			template,
			message: `/${template.name}: plugin ${owner.id} changed on disk since this session loaded it. Run /reload library to load the new copy, or /reload all to also restart its extension.`,
		},
	};
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
		skillsStillVerified(skills, cwd = defaultCwd) {
			const owners = new Set(skills.flatMap((skill) => (skill.sourceInfo.owner ? [skill.sourceInfo.owner.id] : [])));
			if (owners.size === 0) return skills.filter((skill) => skill.source !== "plugin");
			const roots = withPluginDiscoveryPass(() => enabledPluginResourceRootsFor("skills", owners, cwd));
			return skills.filter((skill) => {
				const owner = skill.sourceInfo.owner;
				if (owner === undefined) return skill.source !== "plugin";
				return roots.some(
					(root) => root.id === owner.id && root.scope === owner.scope && root.provenance.contentDigest === owner.digest,
				);
			});
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
		expandPromptTemplate(text, cwd = defaultCwd, expansionOptions = {}) {
			// Only `/name` can expand, and no caller reads an unexpanded result's
			// diagnostics, so text without the prefix skips the template listing.
			const command = parsePromptCommand(text);
			if (command === null) return { expanded: false, text, args: [], diagnostics: [] };
			const tier = expansionOptions.tier ?? options.modelTier?.();
			const variant: PromptTemplateExpansionOptions = tier !== undefined ? { tier } : {};
			return withPluginDiscoveryPass(() => {
				// A verified read only narrows the committed snapshot's roots, so a name
				// absent from the listing cannot expand and needs no tree walk. Unknown
				// commands reach here on every typo, before anything has painted.
				const listed = loadPromptTemplates({ ...promptOptions(cwd), verifyPluginTrees: false });
				const listedTemplate = listed.items.find((template) => template.name === command.name);
				if (listedTemplate === undefined) return expandPromptTemplateInput(text, listed, variant);
				const expansion = expandPromptTemplateInput(text, loadPromptTemplates(promptOptions(cwd)), variant);
				return expansion.expanded || expansion.refusal || expansion.display
					? expansion
					: driftedPluginTemplate(expansion, listedTemplate);
			});
		},
		async reload() {
			return undefined;
		},
	};
}
