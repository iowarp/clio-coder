import type { StoreBackend } from "./backend.js";

export type { StoreBackend } from "./backend.js";
export type {
	StoreBackendFacts,
	StoreBackendKind,
	StoreBlobStat,
	StoreRefusalReason,
	StoreTagClass,
} from "./types.js";
export { StoreRefusal } from "./types.js";

/** The store backend for this project. Only the local backend ships today; clio-core drops in here later. */
export async function openStoreBackend(cwd: string): Promise<StoreBackend> {
	const { createLocalStoreBackend } = await import("./backends/local.js");
	return createLocalStoreBackend(cwd);
}
export { withStoreLock } from "./lock.js";
