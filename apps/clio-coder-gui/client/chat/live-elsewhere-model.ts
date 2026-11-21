// What the app says about a saved task another process holds open. Pure, so it is testable without a browser.

import type { LiveElsewhere } from "../../contracts/sessions.js";

const WHERE: Readonly<Record<LiveElsewhere["surface"], string>> = {
	terminal: "Live in the terminal",
	headless: "Running headless",
	app: "Open in another app",
	process: "Open in another process",
};

/** "Live in the terminal since 10:02": `since` is already formatted for this machine. */
export function liveElsewhereLabel(live: LiveElsewhere, since: string): string {
	return `${WHERE[live.surface]} since ${since}`;
}

/** What Take over does to the holder, in the words the holder itself prints when it ends. */
export function takeOverExplanation(live: LiveElsewhere): string {
	if (!live.canTakeOver) return "It cannot be asked to end from here. Close it where it runs, then resume it here.";
	if (live.stale)
		return `Its heartbeat has stopped, so Take over releases it. If pid ${live.pid} on ${live.host} wakes, it finds the release and writes nothing more.`;
	return `Take over asks pid ${live.pid} on ${live.host} to end. It says it was taken over, writes nothing more, and this task resumes here.`;
}
