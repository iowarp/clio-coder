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
import { buildExtensionSnapshot } from "./snapshot.js";
import { bindExtensionSnapshotStore, createExtensionSnapshotStore } from "./snapshot-store.js";

export function createExtensionsBundle(_context: DomainContext): DomainBundle<ExtensionsContract> {
	const store = createExtensionSnapshotStore();
	const extension: DomainExtension = {
		start() {
			const snapshot = buildExtensionSnapshot({ cwd: process.cwd(), generation: store.nextGeneration() });
			if (!store.commit(snapshot)) throw new Error("initial extension snapshot generation was stale");
			bindExtensionSnapshotStore(store);
		},
		stop() {
			bindExtensionSnapshotStore(null);
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
		snapshot() {
			return store.current();
		},
		generation() {
			return store.current()?.generation ?? 0;
		},
		async reload() {
			return undefined;
		},
	};
	return { extension, contract };
}
