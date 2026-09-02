import type { DomainContract } from "../../core/domain-loader.js";
import type {
	ExtensionCandidate,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionMutationResult,
	ExtensionReloadPrepareResult,
	ExtensionResourceKind,
	ExtensionResourceRoot,
	ExtensionSnapshot,
	InstalledExtension,
} from "./manager.js";

export interface ExtensionsContract extends DomainContract {
	list(cwd?: string, options?: ExtensionListOptions): InstalledExtension[];
	discover(path: string): ExtensionCandidate[];
	install(path: string, options?: ExtensionInstallOptions): ExtensionInstallResult;
	enable(id: string, options?: ExtensionListOptions): ExtensionMutationResult;
	disable(id: string, options?: ExtensionListOptions): ExtensionMutationResult;
	remove(id: string, options?: ExtensionListOptions): ExtensionMutationResult;
	/** Committed projection for the bundle's cwd; ephemeral generation-0 build for any other cwd. */
	resourceRoots(kind: ExtensionResourceKind, cwd?: string): ExtensionResourceRoot[];
	snapshot(): ExtensionSnapshot | null;
	generation(): number;
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
