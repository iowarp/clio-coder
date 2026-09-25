import type { DomainContract } from "../../core/domain-loader.js";
import type {
	ExtensionListOptions,
	ExtensionReloadPrepareResult,
	ExtensionSnapshot,
	InstalledExtension,
} from "./manager.js";

export interface ExtensionsContract extends DomainContract {
	list(cwd?: string, options?: ExtensionListOptions): InstalledExtension[];
	snapshot(): ExtensionSnapshot | null;
	/**
	 * Build and validate the next generation from disk without publishing it.
	 * Never throws: a build failure or an in-flight candidate is reported as a
	 * rejection and the committed generation is untouched. A rejected build
	 * still burns its reserved generation number. The candidate publishes
	 * itself with one assignment-only call after the caller has confirmed
	 * `current()` on the same stack. Nothing is published at start(); the
	 * composition root publishes the boot generation together with its hooks.
	 */
	prepareReload(): ExtensionReloadPrepareResult;
}
