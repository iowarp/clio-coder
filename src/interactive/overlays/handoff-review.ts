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

import { isKeyRelease, Markdown, matchesKey, type OverlayHandle, type TUI } from "../../engine/tui.js";
import { buildResponsiveHint, createCachedBody, FocusBox, showClioOverlayFrame, windowRows } from "../overlay-frame.js";
import { choiceRows, clioTheme, factRows, markdownTheme, positionRow, sectionRule } from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";

export const HANDOFF_REVIEW_OVERLAY_TITLE = "Handoff review";

const HANDOFF_REVIEW_MIN_WIDTH = 44;
const HANDOFF_REVIEW_MAX_WIDTH = 100;
/** Rows of document shown at once when the frame has not said how many it has. */
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

const CHOICES = [
	{ key: "Enter", verb: "accept", consequence: "writes this handoff exactly as shown", tone: "action" },
	{ key: "e", verb: "edit", consequence: "opens it in $EDITOR; what you save comes back here" },
	{ key: "Esc", verb: "cancel", consequence: "writes nothing" },
] as const;

/**
 * Render the body. Pure so the layout is testable without a TUI: the goal, the
 * document as rendered Markdown windowed to `rows`, and the three keys with
 * what each one does, pinned beneath. Zero rows means the frame has not said.
 */
function formatHandoffReviewBody(
	goal: string,
	document: string,
	width: number,
	scroll: number,
	rows = 0,
): { lines: string[]; maxScroll: number } {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const rendered = new Markdown(document, 0, 0, markdownTheme(theme))
		.render(contentWidth)
		.map((line) => theme.base("decisionExplanation", line));
	const choices = choiceRows(theme, [...CHOICES], contentWidth);
	const head = factRows(theme, [{ label: "goal", value: goal }], contentWidth);
	const budget = rows > 0 ? Math.max(4, rows - head.length - 1 - choices.length) : HANDOFF_REVIEW_VISIBLE_ROWS;
	const fits = rendered.length <= budget;
	const pane = windowRows(rendered, scroll, fits ? budget : budget - 1);
	const count = `${rendered.length} line${rendered.length === 1 ? "" : "s"}`;
	return {
		lines: [
			...head,
			sectionRule(theme, contentWidth, "Document", { meta: fits ? count : "" }),
			...pane.window,
			...(pane.position === null ? [] : [positionRow(theme, { ...pane.position, unit: "lines" }, contentWidth)]),
			...choices,
		],
		maxScroll: pane.maxScroll,
	};
}

export function openHandoffReviewOverlay(
	tui: TUI,
	options: OpenHandoffReviewOverlayOptions,
): HandoffReviewOverlaySession {
	let text = options.document;
	let scroll = 0;
	let maxScroll = 0;
	let settled = false;
	// One Markdown render per (document, width, skin): the review is read for
	// a while and the document changes only through the editor.
	let memo: { key: string; lines: string[]; maxScroll: number } | null = null;
	const body = createCachedBody((width, rows) => {
		const key = `${width}|${rows}|${scroll}|${skinEpoch()}|${text}`;
		if (memo?.key !== key) {
			const built = formatHandoffReviewBody(options.goal, text, width, scroll, rows);
			memo = { key, lines: built.lines, maxScroll: built.maxScroll };
		}
		maxScroll = memo.maxScroll;
		return memo.lines;
	});

	const accept = (): void => {
		if (settled) return;
		settled = true;
		options.onAccept(text);
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		options.onCancel();
	};
	const scrollBy = (delta: number): void => {
		scroll = Math.max(0, Math.min(maxScroll, scroll + delta));
		body.touch();
		tui.requestRender();
	};

	const focus = new FocusBox(body, {
		// Keys are matched by name, never by raw bytes: under the kitty keyboard
		// protocol Esc arrives as CSI 27 u, and a byte comparison against "\x1b"
		// left the overlay unanswerable. Everything unmatched is swallowed.
		onInput: (data: string): void => {
			if (settled || isKeyRelease(data)) return;
			if (matchesKey(data, "up")) {
				scrollBy(-1);
				return;
			}
			if (matchesKey(data, "down")) {
				scrollBy(1);
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
				const edited = options.onEdit(text);
				if (edited !== null) {
					text = edited;
					scroll = 0;
					body.touch();
				}
				tui.requestRender(true);
			}
		},
	});

	const handle = showClioOverlayFrame(tui, focus, {
		anchor: "center",
		width: handoffReviewOverlayWidth(options.columns),
		markerId: "handoff-review",
		title: HANDOFF_REVIEW_OVERLAY_TITLE,
		// The body's own rows name Enter, e and Esc with what they do; the rail
		// carries only the key they do not.
		footerHint: buildResponsiveHint([{ key: "↑↓", verb: "scroll" }], null),
	});

	return {
		...handle,
		document: () => text,
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
