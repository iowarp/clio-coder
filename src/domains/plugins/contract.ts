import type { DomainContract } from "../../core/domain-loader.js";
import type {
	InstalledPlugin,
	PluginCandidate,
	PluginInstallOptions,
	PluginListOptions,
	PluginMutationResult,
	PluginResourceKind,
	PluginResourceRoot,
	PluginSnapshot,
} from "./types.js";

export interface PluginsContract extends DomainContract {
	list(cwd?: string, options?: PluginListOptions): InstalledPlugin[];
	discover(root: string): PluginCandidate[];
	install(source: string, options?: PluginInstallOptions): PluginMutationResult;
	update(id: string, options?: PluginInstallOptions): PluginMutationResult;
	enable(id: string, options?: PluginListOptions): PluginMutationResult;
	disable(id: string, options?: PluginListOptions): PluginMutationResult;
	remove(id: string, options?: PluginListOptions): PluginMutationResult;
	resourceRoots(kind: PluginResourceKind, cwd?: string): PluginResourceRoot[];
	snapshot(cwd?: string): PluginSnapshot;
	reload(cwd?: string): PluginSnapshot;
}
