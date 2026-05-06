import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ExtensionsContract } from "./contract.js";
import {
	disableExtension,
	discoverExtensionPackages,
	enabledExtensionResourceRoots,
	enableExtension,
	installExtension,
	listInstalledExtensions,
	removeExtension,
} from "./manager.js";

export function createExtensionsBundle(_context: DomainContext): DomainBundle<ExtensionsContract> {
	const extension: DomainExtension = {
		start() {
			return undefined;
		},
	};
	const contract: ExtensionsContract = {
		list(cwd, options = {}) {
			return listInstalledExtensions(cwd, options);
		},
		discover(root) {
			return discoverExtensionPackages(root);
		},
		install(root, options = {}) {
			return installExtension(root, options);
		},
		enable(id, options = {}) {
			return enableExtension(id, options);
		},
		disable(id, options = {}) {
			return disableExtension(id, options);
		},
		remove(id, options = {}) {
			return removeExtension(id, options);
		},
		resourceRoots(kind, cwd) {
			return enabledExtensionResourceRoots(kind, cwd);
		},
		async reload() {
			return undefined;
		},
	};
	return { extension, contract };
}
