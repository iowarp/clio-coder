// A second window is something the operator asks for. The launcher only ever focuses the window that
// is already open, so this is the one place the app opens another.

/**
 * Open a page of this app in its own window. The launch token travels in the fragment, as it does in
 * a launch link, because a private server's token lives in this window's own storage and a new window
 * starts without it.
 */
export function openAppWindow(path: string, token: string): void {
	window.open(
		`${path}#token=${encodeURIComponent(token)}`,
		"_blank",
		`popup,noopener,width=${window.outerWidth},height=${window.outerHeight}`,
	);
}

/** The path a relaunch of the installed app asked for, when it is somewhere other than where the window is. */
export function launchedPath(targetUrl: string | undefined, origin: string, current: string): string | null {
	if (!targetUrl) return null;
	let target: URL;
	try {
		target = new URL(targetUrl);
	} catch {
		return null;
	}
	// A bare launch asks for the app, not its start page, so the window keeps the task it is showing.
	if (target.origin !== origin || target.pathname === "/" || target.pathname === current) return null;
	return target.pathname;
}
