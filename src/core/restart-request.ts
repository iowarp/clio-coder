/**
 * A restart the model asked for through `restart_session`. The tool never
 * restarts mid-turn: it records the request here, and the interactive
 * application, the only host that can restart, takes it when the turn ends and
 * runs it through the same path as `/restart <text>`.
 */

/** Automatic restarts a session may chain before the operator types again. */
export const MODEL_RESTART_LIMIT = 3;

type RestartHost = (continuation: string) => void;

let host: RestartHost | null = null;
let pending: string | null = null;
/** Model-requested restarts chained into this process; an operator `/restart` starts the count over. */
let chain = 0;

/** Set from the continuation record the restarted session consumed. */
export function noteRestartChain(count: number): void {
	chain = Number.isInteger(count) && count > 0 ? count : 0;
}

/** The chain count the next model-requested restart hands to its child. */
export function nextModelRestartChain(): number {
	return chain + 1;
}

/** Installed by the interactive application; absent in headless, ACP and worker runs. */
export function setRestartHost(next: RestartHost | null): void {
	host = next;
	if (!next) pending = null;
}

/** Why a model-requested restart cannot be recorded here; null when it can. */
export function restartRequestUnavailable(): string | null {
	if (!host) return "only an interactive terminal session can restart";
	if (chain >= MODEL_RESTART_LIMIT)
		return `${MODEL_RESTART_LIMIT} restarts in a row were requested without the operator; ask the operator to type /restart`;
	return null;
}

export function requestModelRestart(continuation: string): void {
	pending = continuation;
}

/** Runs the request recorded during the turn that just ended, once. */
export function firePendingModelRestart(): boolean {
	const continuation = pending;
	pending = null;
	if (continuation === null || !host) return false;
	host(continuation);
	return true;
}
