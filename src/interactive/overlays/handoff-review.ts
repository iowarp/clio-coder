/**
 * `/handoff` review: the document, before anything is written anywhere.
 *
 * The operator reads the rendered Markdown here and chooses. Enter accepts the
 * document as it stands, `e` hands it to `$EDITOR` through the same external
 * editor flow the composer uses and comes back with whatever was saved, and Esc
 * cancels the whole handoff. Cancel is the important one: nothing has been
 * written at the point this overlay opens, so leaving it costs the extraction
 * round and nothing else.
 */

import {
	type Component,
	isKeyRelease,
	matchesKey,
	type OverlayHandle,
	type TUI,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import { buildResponsiveHint, FocusBox, showClioOverlayFrame } from "../overlay-frame.js";
import { clioTheme, rule } from "../theme/index.js";

export const HANDOFF_REVIEW_OVERLAY_TITLE = "Handoff review";

const HANDOFF_REVIEW_MIN_WIDTH = 44;
const HANDOFF_REVIEW_MAX_WIDTH = 100;
/** Rows of document shown at once. Anything longer scrolls. */
export const HANDOFF_REVIEW_VISIBLE_ROWS = 20;

function handoffReviewOverlayWidth(columns: number): number {
	return Math.max(HANDOFF_REVIEW_MIN_WIDTH, Math.min(HANDOFF_REVIEW_MAX_WIDTH, columns - 4));
}

export interface OpenHandoffReviewOverlayOptions {
	document: string;
	goal: string;
	/** Live terminal width, so the box tracks the window it opened in. */
	columns: number;
	/**
	 * Hand the current document to `$EDITOR` and return what came back, or null
	 * when the edit was cancelled or no editor is configured. The caller owns
	 * stopping and restarting the TUI around the child process.
	 */
	onEdit: (current: string) => string | null;
	/** Enter: the operator accepts this exact text. */
	onAccept: (document: string) => void;
	/** Esc: the whole handoff is abandoned and nothing is written. */
	onCancel: () => void;
}

export interface HandoffReviewOverlaySession extends OverlayHandle {
	/** The document as it currently stands, including any external edit. */
	document(): string;
}

/**
 * Render the body. Pure so the layout is testable without a TUI: the goal, a
 * rule, then the scrolled document window.
 */
function formatHandoffReviewBody(goal: string, document: string, width: number, scroll: number): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const lines: string[] = [];
	for (const line of wrapTextWithAnsi(theme.fg("dim", `goal: ${goal}`), contentWidth)) lines.push(line);
	lines.push(rule(theme, contentWidth));

	const wrapped: string[] = [];
	for (const raw of document.split("\n")) {
		if (raw.length === 0) {
			wrapped.push("");
			continue;
		}
		for (const line of wrapTextWithAnsi(theme.fg("muted", raw), contentWidth)) wrapped.push(line);
	}
	const maxScroll = Math.max(0, wrapped.length - HANDOFF_REVIEW_VISIBLE_ROWS);
	const start = Math.max(0, Math.min(scroll, maxScroll));
	const window = wrapped.slice(start, start + HANDOFF_REVIEW_VISIBLE_ROWS);
	for (const line of window) lines.push(line);
	if (wrapped.length > HANDOFF_REVIEW_VISIBLE_ROWS) {
		lines.push(theme.fg("dim", `(${start + 1}-${start + window.length} of ${wrapped.length} lines)`));
	}
	return lines;
}

class HandoffReviewBody implements Component {
	scroll = 0;

	constructor(
		private readonly goal: string,
		private text: string,
	) {}

	setDocument(next: string): void {
		this.text = next;
		this.scroll = 0;
	}

	document(): string {
		return this.text;
	}

	lineCount(): number {
		return this.text.split("\n").length;
	}

	render(width: number): string[] {
		return formatHandoffReviewBody(this.goal, this.text, width, this.scroll);
	}

	invalidate(): void {}
}

export function openHandoffReviewOverlay(
	tui: TUI,
	options: OpenHandoffReviewOverlayOptions,
): HandoffReviewOverlaySession {
	const body = new HandoffReviewBody(options.goal, options.document);
	let settled = false;

	const accept = (): void => {
		if (settled) return;
		settled = true;
		options.onAccept(body.document());
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		options.onCancel();
	};

	const focus = new FocusBox(body, {
		// Keys are matched by name, never by raw bytes: under the kitty keyboard
		// protocol Esc arrives as CSI 27 u, and a byte comparison against "\x1b"
		// left the overlay unanswerable. Everything unmatched is swallowed.
		onInput: (data: string): void => {
			if (settled || isKeyRelease(data)) return;
			if (matchesKey(data, "up")) {
				body.scroll = Math.max(0, body.scroll - 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "down")) {
				body.scroll = Math.min(body.lineCount(), body.scroll + 1);
				tui.requestRender();
				return;
			}
			if (matchesKey(data, "enter")) {
				accept();
				return;
			}
			if (matchesKey(data, "escape")) {
				cancel();
				return;
			}
			if (matchesKey(data, "e") || matchesKey(data, "shift+e")) {
				const edited = options.onEdit(body.document());
				if (edited !== null) body.setDocument(edited);
				tui.requestRender(true);
			}
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: handoffReviewOverlayWidth(options.columns),
		markerId: "handoff-review",
		title: HANDOFF_REVIEW_OVERLAY_TITLE,
		footerHint: buildResponsiveHint(
			[
				{ key: "Enter", verb: "accept" },
				{ key: "e", verb: "edit" },
				{ key: "↑↓", verb: "scroll" },
			],
			{ key: "Esc", verb: "cancel" },
		),
	});

	return {
		...handle,
		document: () => body.document(),
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
