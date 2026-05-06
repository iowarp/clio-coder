import type { DomainContract } from "../../core/domain-loader.js";
import type {
	ExtensionCandidate,
	ExtensionInstallOptions,
	ExtensionInstallResult,
	ExtensionListOptions,
	ExtensionMutationResult,
	ExtensionResourceKind,
	ExtensionResourceRoot,
	InstalledExtension,
} from "./manager.js";

export interface ExtensionsContract extends DomainContract {
	list(cwd?: string, options?: ExtensionListOptions): InstalledExtension[];
	discover(path: string): ExtensionCandidate[];
	install(path: string, options?: ExtensionInstallOptions): ExtensionInstallResult;
	enable(id: string, options?: ExtensionListOptions): ExtensionMutationResult;
	disable(id: string, options?: ExtensionListOptions): ExtensionMutationResult;
	remove(id: string, options?: ExtensionListOptions): ExtensionMutationResult;
	resourceRoots(kind: ExtensionResourceKind, cwd?: string): ExtensionResourceRoot[];
	reload(): Promise<void>;
}
