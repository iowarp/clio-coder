// What a launch does when the background app is already running, kept free of processes and sockets so
// node:test can exercise every branch. A window left on screen by a server that restarted only says it
// lost the connection, so the app, not the window title, decides whether a window is there to reuse.

/** The app's answer to a launch: a window can hear it, none can, or the app did not say (an older app). */
export type WindowAnswer = "shown" | "no-window" | "unknown";

export interface RelaunchSteps {
	/** Asks the app whether a window is live and, with a path, to show that page in the focused one. */
	ask(path?: string): Promise<WindowAnswer>;
	/** Raises an app window on this desktop; false when no tool could. */
	focus(): Promise<boolean>;
	/** Opens the fresh launch link; `reuse` says a launcher that owns its window may focus it instead. */
	open(reuse: boolean): Promise<unknown>;
}

export async function relaunchWindow(
	path: string,
	steps: RelaunchSteps,
): Promise<"focused" | "page-not-shown" | "opened"> {
	const live = await steps.ask().catch((): WindowAnswer => "unknown");
	if (live !== "no-window" && (await steps.focus())) {
		if (path === "/") return "focused";
		return (await steps.ask(path).catch((): WindowAnswer => "unknown")) === "shown" ? "focused" : "page-not-shown";
	}
	// Reusing a window cannot show it a named page, so such a launch opens the link that names it.
	await steps.open(live === "shown" && path === "/");
	return "opened";
}
