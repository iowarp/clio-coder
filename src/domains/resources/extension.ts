import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ResourcesContract } from "./contract.js";
import { createResourcesLoader } from "./loader.js";

export function createResourcesBundle(_context: DomainContext): DomainBundle<ResourcesContract> {
	const loader = createResourcesLoader();
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
