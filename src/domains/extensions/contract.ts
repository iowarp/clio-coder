import type { DomainContract } from "../../core/domain-loader.js";
import type {
	ExtensionCandidate,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionMutationResult,
	ExtensionReloadCandidate,
	ExtensionReloadPrepareResult,
	ExtensionReloadResult,
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
	 * still burns its reserved generation number.
	 */
	prepareReload(): ExtensionReloadPrepareResult;
	/**
	 * Publish a prepared candidate with one reference assignment. Never throws
	 * and never yields. A candidate that is not the in-flight one, or whose
	 * generation is not strictly newer than the committed one, is refused as
	 * stale with no visible change.
	 */
	commitReload(candidate: ExtensionReloadCandidate): ExtensionReloadResult;
	/** Release a prepared candidate without publishing it. Never throws. */
	discardReload(candidate: ExtensionReloadCandidate): void;
}
