import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ConfigContract } from "../config/contract.js";
import type { ResourcesContract } from "./contract.js";
import { createResourcesLoader, type ResourceLoaderOptions } from "./loader.js";

export function createResourcesBundle(
	context: DomainContext,
	options: ResourceLoaderOptions = {},
): DomainBundle<ResourcesContract> {
	const config = (): ConfigContract | undefined => context.getContract<ConfigContract>("config");
	const loader = createResourcesLoader({
		...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
		...(options.noContextFiles !== undefined ? { noContextFiles: options.noContextFiles } : {}),
		skills: () => ({
			...skillOptions(config()?.get().skills.trustProjectCompatRoots === true, options),
		}),
	});
	const extension: DomainExtension = {
		start() {
			return undefined;
		},
	};
	const contract: ResourcesContract = {
		contextFiles(cwd) {
			return loader.contextFiles(cwd);
		},
		renderContextFiles(files, cwd) {
			return loader.renderContextFiles(files, cwd);
		},
		skills(cwd) {
			return loader.skills(cwd);
		},
		expandSkillInvocation(text, cwd, options) {
			return loader.expandSkillInvocation(text, cwd, options);
		},
		parsePendingSkillRequests(text, cwd, options) {
			return loader.parsePendingSkillRequests(text, cwd, options);
		},
		prompts(cwd) {
			return loader.prompts(cwd);
		},
		expandPromptTemplate(text, cwd) {
			return loader.expandPromptTemplate(text, cwd);
		},
		themes() {
			return loader.themes();
		},
		resolvePath(value, cwd) {
			return loader.resolvePath(value, cwd);
		},
		reload() {
			return loader.reload();
		},
	};
	return { extension, contract };
}

function skillOptions(
	trustProjectCompatRoots: boolean,
	options: ResourceLoaderOptions,
): ReturnType<NonNullable<ResourceLoaderOptions["skills"]>> {
	const runtime = options.skills?.() ?? {};
	return {
		trustProjectCompatRoots: runtime.trustProjectCompatRoots ?? trustProjectCompatRoots,
		...(runtime.disableDiscovery !== undefined ? { disableDiscovery: runtime.disableDiscovery } : {}),
		...(runtime.explicitSkillPaths !== undefined ? { explicitSkillPaths: runtime.explicitSkillPaths } : {}),
	};
}
