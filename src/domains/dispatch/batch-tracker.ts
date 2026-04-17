/**
 * Immutable batch tracker for a group of dispatched runs. Every mutation
 * returns a new state object; the caller holds a reference and threads it
 * through event handlers.
 */

export interface BatchState {
	id: string;
	runIds: ReadonlyArray<string>;
	completed: ReadonlySet<string>;
	failed: ReadonlySet<string>;
	startedAt: string;
}

function makeId(): string {
	return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createBatch(runIds: ReadonlyArray<string>): BatchState {
	return {
		id: makeId(),
		runIds: [...runIds],
		completed: new Set<string>(),
		failed: new Set<string>(),
		startedAt: new Date().toISOString(),
	};
}

export function onRunComplete(batch: BatchState, runId: string, failed: boolean): BatchState {
	if (!batch.runIds.includes(runId)) return batch;
	const completed = new Set(batch.completed);
	const failedSet = new Set(batch.failed);
	if (failed) failedSet.add(runId);
	else completed.add(runId);
	return {
		id: batch.id,
		runIds: batch.runIds,
		completed,
		failed: failedSet,
		startedAt: batch.startedAt,
	};
}

export function isBatchDone(batch: BatchState): boolean {
	return batch.runIds.every((id) => batch.completed.has(id) || batch.failed.has(id));
}
