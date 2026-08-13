import { stateRootRemoved } from "../../core/xdg.js";
import { atomicWrite, sessionPaths } from "../../engine/session.js";
import type { SessionMeta } from "./contract.js";
import type { SessionManagerState } from "./manager.js";

/**
 * Three-stage atomic checkpoint:
 *  1. current.jsonl appends are fsync'd by writer.persistTree() (the engine
 *     writer debounces fsync between checkpoints).
 *  2. tree.json is written via writer.persistTree() (atomicWrite under the hood).
 *  3. meta.json is rewritten with lastCheckpointAt / lastCheckpointReason via
 *     atomicWrite so the on-disk marker survives crashes.
 *
 * The engine writer closes over the same meta reference we hold in
 * SessionManagerState.meta. Mutating it here keeps the writer's eventual
 * close() in sync with the checkpoint-enriched fields.
 *
 * Nothing is written, and no checkpoint is claimed in memory, once `clio
 * uninstall` has taken the state root away. The check sits before
 * `sessionPaths()`, which mkdirs the session directory and so rebuilds the
 * whole root on its way to a meta.json the operator just deleted. This is the
 * writer that undid an uninstall roughly two minutes after it reported success,
 * leaving behind a root holding meta.json and tree.json with
 * `lastCheckpointReason: shutdown`.
 */
export async function performCheckpoint(state: SessionManagerState, reason?: string): Promise<void> {
	await state.writer.persistTree();
	if (stateRootRemoved()) return;
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
