import type { StoreBackend } from "./backend.js";

export type { StoreBackend } from "./backend.js";
export { type ClioCoreStoreOptions, createClioCoreStoreBackend } from "./backends/clio-core.js";
export type {
	StoreBackendFacts,
	StoreBackendKind,
	StoreBlobPut,
	StoreBlobStat,
	StoreRefusalReason,
	StoreTagClass,
} from "./types.js";
export { compileBlobPattern, StoreRefusal } from "./types.js";

/**
 * The store backend for this project, as `<dataDir>/store/backend.json` selects it.
 * No record (or one that cannot be used) means local; a clio-core record that
 * cannot attach throws `unavailable` and never falls back to local.
 */
export async function openStoreBackend(cwd: string): Promise<StoreBackend> {
	const { readStoreBackendSelection, openClioCoreBackend } = await import("./selection.js");
	const { record } = readStoreBackendSelection();
	if (record?.backend === "clio-core") return openClioCoreBackend(cwd, record);
	const { createLocalStoreBackend } = await import("./backends/local.js");
	return createLocalStoreBackend(cwd);
}
export { withStoreLock } from "./lock.js";
export { workspaceCapabilitySignals, workspaceStoreTags } from "./workspace-signal.js";
