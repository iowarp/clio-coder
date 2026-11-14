/** A task as the project lists it: its id and the title the task list shows. */
export interface ScopeTask {
	readonly id: string;
	readonly title: string;
}

const LISTED = 5;

/** Recorded sessions are named by their task's title; the id stands in only when no task lists that session. */
export function sessionTitle(sessionId: string, titles: ReadonlyMap<string, string>) {
	return titles.get(sessionId) ?? sessionId.slice(0, 12);
}

function quoted(tasks: readonly ScopeTask[]) {
	const shown = tasks.slice(0, LISTED).map((task) => `“${task.title}”`);
	const more = tasks.length - shown.length;
	return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function tasksWord(count: number) {
	return count === 1 ? "task" : "tasks";
}

/**
 * Which of the scope's tasks the recorded metrics cover, in plain words. A task without a usage record is named,
 * so a short table never reads as the whole project. Null while the scope lists no tasks.
 */
export function metricsScopeNote(input: {
	readonly recorded: readonly string[];
	readonly recordedCount: number;
	readonly tasks: readonly ScopeTask[];
	readonly project: boolean;
}): string | null {
	const { tasks } = input;
	if (!tasks.length) return null;
	const recorded = new Set(input.recorded);
	const missing = tasks.filter((task) => !recorded.has(task.id));
	const whole = input.project ? `this project's ${tasks.length}` : `the ${tasks.length} listed`;
	if (!missing.length) return `Covers all of ${whole} ${tasksWord(tasks.length)}.`;
	if (input.recorded.length < input.recordedCount)
		return `Shows the ${input.recorded.length} most recent of ${input.recordedCount} recorded sessions. Not shown here, because they are older or have no usage record yet: ${quoted(missing)}.`;
	const counted = tasks.length - missing.length;
	return `Covers ${counted} of ${whole} ${tasksWord(tasks.length)}. Not counted, because CLIO Coder has no usage record for ${missing.length === 1 ? "it" : "them"} yet: ${quoted(missing)}.`;
}

/** The metrics header count: how many recorded sessions the table lists, out of all recorded in scope. */
export function recordedSessionsLabel(shown: number, recorded: number) {
	return shown === recorded
		? `${recorded} recorded ${recorded === 1 ? "session" : "sessions"}`
		: `${shown} most recent of ${recorded} recorded sessions`;
}
