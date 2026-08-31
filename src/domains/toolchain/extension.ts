import type { DomainBundle, DomainContext, DomainExtension } from "../../core/domain-loader.js";
import type { ToolchainContract } from "./contract.js";
import type { ToolInstallOptions } from "./install.js";
import { findPinnedTool, PINNED_TOOLS } from "./registry.js";
import { removeTool, type ToolRemoveOptions } from "./remove.js";
import { resolveToolBinary, toolStatus, toolStatuses } from "./resolve.js";

export function createToolchainBundle(_context: DomainContext): DomainBundle<ToolchainContract> {
	const extension: DomainExtension = {
		start() {
			// Nothing to start. Resolution is on demand and installs are operator
			// commands, so loading the domain touches neither the network nor disk.
			return undefined;
		},
	};
	const contract: ToolchainContract = {
		list() {
			return PINNED_TOOLS;
		},
		get(id) {
			return findPinnedTool(id);
		},
		resolve(name) {
			return resolveToolBinary(name);
		},
		status(id) {
			const entry = findPinnedTool(id);
			return entry === null ? null : toolStatus(entry);
		},
		statuses() {
			return toolStatuses();
		},
		async install(id: string, options: ToolInstallOptions = {}) {
			// Imported lazily so the installer's archive readers stay out of every
			// graph that only ever resolves a binary.
			const { installTool } = await import("./install.js");
			return installTool(id, options);
		},
		remove(id: string, options: ToolRemoveOptions = {}) {
			// Statically imported, unlike install: removal is a readdir and an
			// unlink, so it carries none of the archive readers that keep the
			// installer off graphs which only ever resolve a binary.
			return removeTool(id, options);
		},
	};
	return { extension, contract };
}
