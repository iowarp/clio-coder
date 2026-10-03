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

/** How long a launch waits for this window to become the one the launcher brought forward. */
const LAUNCH_FOCUS_MS = 1_500;

/**
 * Run `act` if this is the window a launch focused. Every window hears the launch and the launcher
 * focuses one just before sending it, so that window has the focus now or gains it within a moment.
 */
export function whenFocused(act: () => void): void {
	if (document.hasFocus()) {
		act();
		return;
	}
	const settle = () => {
		clearTimeout(timer);
		window.removeEventListener("focus", arrive);
	};
	const arrive = () => {
		settle();
		act();
	};
	const timer = setTimeout(settle, LAUNCH_FOCUS_MS);
	window.addEventListener("focus", arrive);
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
