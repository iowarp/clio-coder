// A leaf module: the task route reads it, and importing the eager Home draft store there would pull Home's code along.

interface Started {
	readonly sessionId: string;
	readonly text: string;
	acknowledge: (() => void) | null;
}

let started: Started | null = null;

/**
 * Records the task this tab just started. Its words show on the task screen before the first snapshot, and
 * `acknowledge` (clearing the Home draft) waits until that screen has mounted, so the request never leaves the
 * screen: clearing first would repaint Home empty before the navigation commits.
 */
export function rememberStarted(sessionId: string, text: string, acknowledge: () => void): void {
	settleStarted();
	started = { sessionId, text, acknowledge };
}

/** Runs the deferred acknowledgement once, for this session's screen or before the next start. */
export function settleStarted(sessionId?: string): void {
	if (!started?.acknowledge || (sessionId !== undefined && started.sessionId !== sessionId)) return;
	const acknowledge = started.acknowledge;
	started.acknowledge = null;
	acknowledge();
}

/**
 * The started request's text for this session only. It is not consumed on read: the loading screen may
 * render more than once before the first snapshot, and the next started task replaces it.
 */
export const startedRequest = (sessionId: string | undefined): string | null =>
	started !== null && started.sessionId === sessionId ? started.text : null;
