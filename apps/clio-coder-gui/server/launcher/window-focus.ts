import { APP_TITLE } from "../../contracts/meta.js";

/** Window tools that can bring a window forward from a launcher process on a Linux desktop. */
export type FocusTool = "swaymsg" | "wmctrl" | "xdotool";

/**
 * Tools worth trying in this session, most specific first. GNOME, KDE and other Wayland compositors
 * expose no general command for raising another program's window, so they get none and a launch opens
 * a tab as before. X11 tools under XWayland see only XWayland windows; a native Wayland browser window
 * is not found and the launch falls back the same way.
 */
export function focusTools(env: NodeJS.ProcessEnv): FocusTool[] {
	const tools: FocusTool[] = [];
	if (env.SWAYSOCK) tools.push("swaymsg");
	if (env.DISPLAY) tools.push("wmctrl", "xdotool");
	return tools;
}

/** " - Google Chrome", " — Mozilla Firefox": the name a browser appends to the page title of its front tab. */
const BROWSER_SUFFIX = / [-—] [A-Za-z][A-Za-z0-9 .]*$/;

/**
 * Whether a window shows the app: the page titles the app composes (`Clio Coder`, `Tasks · Clio Coder`,
 * `● Approval needed — Tasks · Clio Coder`), alone in an installed app window or followed by the browser's
 * name when the app is the front tab of a browser window.
 */
export function isAppWindowTitle(title: string) {
	const page = title.endsWith(APP_TITLE) ? title : title.replace(BROWSER_SUFFIX, "");
	return page === APP_TITLE || page.endsWith(` · ${APP_TITLE}`) || page.endsWith(`— ${APP_TITLE}`);
}

/** The first app window in `wmctrl -l` output, whose lines read `<id> <desktop> <host> <title>`. */
export function wmctrlAppWindow(listing: string): string | null {
	for (const line of listing.split("\n")) {
		const match = /^(0x[0-9a-f]+)\s+-?\d+\s+\S+\s(.*)$/i.exec(line.trimEnd());
		if (match?.[1] && isAppWindowTitle(match[2] ?? "")) return match[1];
	}
	return null;
}

/** The same titles as sway criteria (PCRE), so sway finds and focuses the window in one command. */
export const SWAY_APP_CRITERIA = `[title="(^|· |— )${APP_TITLE}( [-—] [A-Za-z][A-Za-z0-9 .]*)?$"]`;
