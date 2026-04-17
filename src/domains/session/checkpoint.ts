import { atomicWrite, sessionPaths } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";
import type { SessionManagerState } from "./manager.js";

/**
 * Three-stage atomic checkpoint:
 *  1. current.jsonl is already durable — the engine writer fsyncs each append.
 *  2. tree.json is written via writer.persistTree() (atomicWrite under the hood).
 *  3. meta.json is rewritten with lastCheckpointAt / lastCheckpointReason via
 *     atomicWrite so the on-disk marker survives crashes.
 *
 * The engine writer closes over the same meta reference we hold in
 * SessionManagerState.meta. Mutating it here keeps the writer's eventual
 * close() in sync with the checkpoint-enriched fields.
 */
export async function performCheckpoint(state: SessionManagerState, reason?: string): Promise<void> {
	await state.writer.persistTree();
	const paths = sessionPaths(state.meta);
	const at = new Date().toISOString();
	const enriched: SessionMeta = {
		...state.meta,
		lastCheckpointAt: at,
		lastCheckpointReason: reason ?? null,
	};
	atomicWrite(paths.meta, JSON.stringify(enriched, null, 2));
	Object.assign(state.meta, enriched);
}
