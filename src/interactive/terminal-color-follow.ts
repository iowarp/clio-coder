import { reportTerminalColors, terminalThemeForced } from "../core/terminal-background.js";
import { colorDisabled } from "../core/terminal-preferences.js";
import type { ThemeBackground } from "../core/theme-token-hex.js";
import type { TUI } from "../engine/tui.js";

const QUERY_TIMEOUT_MS = 500;

export interface TerminalColorFollower {
	/** Ask again, for when the terminal was out of our hands and a report could have been missed. */
	refresh(): void;
	dispose(): void;
}

type FollowedTui = Pick<
	TUI,
	| "onTerminalColorSchemeChange"
	| "setTerminalColorSchemeNotifications"
	| "queryTerminalColors"
	| "invalidate"
	| "requestRender"
>;

/**
 * Keep the theme on the terminal's real background. A scheme report only says
 * something moved, so each one is followed by an OSC 11 query for the actual
 * color; a terminal that reports a scheme but no color still switches palettes.
 * Painting reads the new palette through skinEpoch, and a forced repaint rebuilds
 * the frame in place, so focus, overlays and the draft are not touched. With a
 * forced theme or no color at all there is nothing to follow and nothing is asked.
 */
export function followTerminalColors(tui: FollowedTui, env: NodeJS.ProcessEnv = process.env): TerminalColorFollower {
	if (terminalThemeForced(env) || colorDisabled(env) || process.stdout.isTTY !== true) {
		return { refresh() {}, dispose() {} };
	}
	let disposed = false;
	let latest = 0;
	const query = (scheme?: ThemeBackground): void => {
		latest += 1;
		const asked = latest;
		const settle = (colors: { background?: { r: number; g: number; b: number } | undefined }): void => {
			if (disposed || asked !== latest) return;
			const color = colors.background;
			const changed = reportTerminalColors({
				background: color === undefined ? undefined : [color.r, color.g, color.b],
				scheme,
			});
			if (!changed) return;
			tui.invalidate();
			tui.requestRender(true);
		};
		void tui.queryTerminalColors({ timeoutMs: QUERY_TIMEOUT_MS, onLateReply: settle }).then(settle);
	};
	const unsubscribe = tui.onTerminalColorSchemeChange((scheme) => query(scheme));
	tui.setTerminalColorSchemeNotifications(true);
	return {
		refresh: () => query(),
		dispose() {
			disposed = true;
			unsubscribe();
			tui.setTerminalColorSchemeNotifications(false);
		},
	};
}
