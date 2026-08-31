import type { DomainContract } from "../../core/domain-loader.js";
import type { ToolInstallOptions, ToolInstallResult } from "./install.js";
import type { PinnedTool, ToolResolution, ToolStatus } from "./types.js";

export interface ToolchainContract extends DomainContract {
	/** The pinned table, in registry order. */
	list(): ReadonlyArray<PinnedTool>;
	/** One row by id. */
	get(id: string): PinnedTool | null;
	/** Resolve an executable name through PATH, then the vendored pin, then none. */
	resolve(name: string): ToolResolution;
	/** Per-entry state for one row. */
	status(id: string): ToolStatus | null;
	/** Per-entry state for every row. */
	statuses(): ToolStatus[];
	/**
	 * Download and vendor one tool. Only ever called from an explicit operator
	 * command; nothing on a startup path may reach it.
	 */
	install(id: string, options?: ToolInstallOptions): Promise<ToolInstallResult>;
}
