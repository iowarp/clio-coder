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
	/**
	 * Opens the fresh launch link; `reuse` says a launcher that owns its window may focus it instead. True when it
	 * did, so the link, and the page it names, did not open.
	 */
	open(reuse: boolean): Promise<boolean>;
}

export async function relaunchWindow(
	path: string,
	steps: RelaunchSteps,
): Promise<"focused" | "page-not-shown" | "opened"> {
	const live = await steps.ask().catch((): WindowAnswer => "unknown");
	const showPage = async () => {
		if (path === "/") return "focused";
		return (await steps.ask(path).catch((): WindowAnswer => "unknown")) === "shown" ? "focused" : "page-not-shown";
	};
	if (live !== "no-window" && (await steps.focus())) return showPage();
	// The WSL launcher owns its window and focuses it while the app says one is live; a named page then goes to it
	// as above. An opener that cannot reuse a window opens the link, which names the page itself.
	return (await steps.open(live === "shown")) ? showPage() : "opened";
}
