/**
 * The session and task overrides of `systemOne.use`. Precedence runs built-in
 * off, user settings, trusted project settings, session, task. A task override
 * covers the next submitted task and its continuations and expires when the
 * operator submits another; a model's reading of the conversation never ends it.
 */

export type RuntimeScope = "task" | "session";

export type SystemOneScopeName = RuntimeScope | "project" | "user";

export interface SystemOneCommand {
	readonly action: "status" | "use" | "off";
	readonly name?: string;
	readonly scope?: SystemOneScopeName;
}

export interface SystemOneScopes {
	/** The override in force, if any, narrowest scope first. */
	current(): { readonly use: string; readonly scope: RuntimeScope } | null;
	set(scope: RuntimeScope, use: string): void;
	clear(scope: RuntimeScope): void;
	/** An operator submitted: a task override that already covered a task expires here. */
	noteOperatorTurn(): void;
	/** Another session or a resume: the task override goes, the session override comes from that session's record. */
	resetSession(session: string | null): void;
}

export function createSystemOneScopes(): SystemOneScopes {
	let session: string | null = null;
	let task: { use: string; started: boolean } | null = null;
	return {
		current() {
			if (task !== null) return { use: task.use, scope: "task" };
			return session !== null ? { use: session, scope: "session" } : null;
		},
		set(scope, use) {
			if (scope === "task") task = { use, started: false };
			else session = use;
		},
		clear(scope) {
			if (scope === "task") task = null;
			else session = null;
		},
		noteOperatorTurn() {
			if (task === null) return;
			if (task.started) task = null;
			else task.started = true;
		},
		resetSession(next) {
			session = next;
			task = null;
		},
	};
}
