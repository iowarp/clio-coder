/**
 * Immutable batch tracker for a group of logical dispatch assignments. Every
 * mutation returns a new state object; the caller holds a reference and
 * threads it through event handlers.
 */

export interface BatchState {
	id: string;
	assignmentIds: ReadonlyArray<string>;
	completed: ReadonlySet<string>;
	failed: ReadonlySet<string>;
	startedAt: string;
}

function makeId(): string {
	return `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createBatch(assignmentIds: ReadonlyArray<string>): BatchState {
	return {
		id: makeId(),
		assignmentIds: [...assignmentIds],
		completed: new Set<string>(),
		failed: new Set<string>(),
		startedAt: new Date().toISOString(),
	};
}

export interface BatchSnapshot {
	id: string;
	/** Compatibility name: each assignment id equals its first-attempt run id. */
	runIds: ReadonlyArray<string>;
	completed: ReadonlyArray<string>;
	failed: ReadonlyArray<string>;
	startedAt: string;
	done: boolean;
}

export function onRunComplete(batch: BatchState, assignmentId: string, failed: boolean): BatchState {
	if (!batch.assignmentIds.includes(assignmentId)) return batch;
	const completed = new Set(batch.completed);
	const failedSet = new Set(batch.failed);
	if (failed) failedSet.add(assignmentId);
	else completed.add(assignmentId);
	return {
		id: batch.id,
		assignmentIds: batch.assignmentIds,
		completed,
		failed: failedSet,
		startedAt: batch.startedAt,
	};
}

export function isBatchDone(batch: BatchState): boolean {
	return batch.assignmentIds.every((id) => batch.completed.has(id) || batch.failed.has(id));
}

export function snapshotBatch(batch: BatchState): BatchSnapshot {
	return {
		id: batch.id,
		runIds: batch.assignmentIds,
		completed: [...batch.completed],
		failed: [...batch.failed],
		startedAt: batch.startedAt,
		done: isBatchDone(batch),
	};
}
