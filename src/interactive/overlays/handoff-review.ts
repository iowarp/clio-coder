/**
 * `/handoff` review: the document, before anything is written anywhere.
 *
 * The box opens as soon as the command is admitted and names the extraction
 * while it runs, so the wait has an owner, an elapsed clock and a way out. The
 * operator then reads the rendered Markdown here and chooses. Enter accepts the
 * document as it stands, `e` hands it to `$EDITOR` through the same external
 * editor flow the composer uses and comes back with whatever was saved, and Esc
 * cancels the whole handoff. Cancel is the important one: nothing has been
 * written at the point this overlay opens, so leaving it costs the extraction
 * round and nothing else.
 */

import {
	isKeyRelease,
	Markdown,
	matchesKey,
	type OverlayHandle,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "../../engine/tui.js";
import {
	buildResponsiveHint,
	createCachedBody,
	FocusBox,
	fitHintEntries,
	fitHintEntryList,
	type HintEntry,
	showClioOverlayFrame,
	windowRows,
} from "../overlay-frame.js";
import {
	animationStep,
	chipRows,
	choiceRows,
	clioTheme,
	factRows,
	formatWaitClock,
	GLYPH,
	keyCap,
	markdownTheme,
	positionRow,
	sectionRule,
	spinnerFrame,
} from "../theme/index.js";
import { skinEpoch } from "../theme/tokens.js";
import { scrollJump } from "./confirm-once.js";

export const HANDOFF_REVIEW_OVERLAY_TITLE = "Handoff review";
const HANDOFF_PREPARING_OVERLAY_TITLE = "Handoff · preparing";

const HANDOFF_REVIEW_MIN_WIDTH = 44;
const HANDOFF_REVIEW_MAX_WIDTH = 100;
/** Rows of document shown at once when the frame has not said how many it has. */
export const HANDOFF_REVIEW_VISIBLE_ROWS = 20;

function handoffReviewOverlayWidth(columns: number): number {
	return Math.max(HANDOFF_REVIEW_MIN_WIDTH, Math.min(HANDOFF_REVIEW_MAX_WIDTH, columns - 4));
}

/** Which extraction round the box is waiting on. */
export type HandoffPreparationStage = "reading" | "repairing";

export interface OpenHandoffReviewOverlayOptions {
	/** The document to review, or null while the extraction that draws it is still running. */
	document: string | null;
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
	now?: () => number;
}

export interface HandoffReviewOverlaySession extends OverlayHandle {
	/** The document as it currently stands, including any external edit. */
	document(): string;
	/** The extraction finished: the review takes over the same box. */
	showDocument(document: string): void;
	setPreparation(stage: HandoffPreparationStage): void;
	/** Name the route the extraction was sent on. */
	setRoute(route: string): void;
}

const CHOICES = [
	{
		key: "Enter",
		verb: "accept",
		consequence: "opens a new session seeded with this text; this one stays in /resume",
		tone: "action",
	},
	{ key: "e", verb: "edit", consequence: "opens it in $EDITOR; what you save comes back here" },
	{ key: "Esc", verb: "cancel", consequence: "stays in this session; nothing is written" },
] as const;

const PREPARING_CHOICES = [
	{ key: "Esc", verb: "cancel", consequence: "stops the extraction; nothing is written" },
] as const;

const PREPARATION_WORDS: Readonly<Record<HandoffPreparationStage, string>> = {
	reading: "Reading this session for what the next one needs",
	repairing: "The first answer could not be read, so asking once more",
};

/** The goal, what the box is waiting on and for how long, and the one key that applies. */
function formatPreparingBody(
	goal: string,
	stage: HandoffPreparationStage,
	route: string | null,
	elapsedMs: number,
	spinner: string,
	width: number,
): string[] {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	return [
		...factRows(theme, [{ label: "goal", value: goal }], contentWidth),
		sectionRule(theme, contentWidth, "Preparing", { meta: formatWaitClock(elapsedMs) }),
		...wrapTextWithAnsi(theme.fg("activity", `${spinner} ${PREPARATION_WORDS[stage]}${GLYPH.ellipsis}`), contentWidth),
		...(route === null
			? []
			: [truncateToWidth(theme.fg("annotation", `asking ${route}`), contentWidth, GLYPH.ellipsis, false)]),
		...wrapTextWithAnsi(
			theme.fg("annotation", "The document opens here for review. Nothing is written until you accept it."),
			contentWidth,
		),
		...choiceRows(theme, [...PREPARING_CHOICES], contentWidth),
	];
}

/**
 * Render the body. Pure so the layout is testable without a TUI: the goal, the
 * document as rendered Markdown windowed to `rows`, and the three keys with
 * what each one does, pinned beneath. Zero rows means the frame has not said.
 */
/** The review's rail, in the order it gives keys up. */
const REVIEW_RAIL: ReadonlyArray<HintEntry> = [
	{ key: "Enter", verb: "accept" },
	{ key: "↑↓", verb: "scroll" },
	{ key: "e", verb: "edit" },
	{ key: "Esc", verb: "cancel" },
];

function formatHandoffReviewBody(
	goal: string,
	document: string,
	width: number,
	scroll: number,
	rows = 0,
	railRoom = 0,
): { lines: string[]; maxScroll: number } {
	const theme = clioTheme();
	const contentWidth = Math.max(1, Math.floor(width));
	const rendered = new Markdown(document, 0, 0, markdownTheme(theme))
		.render(contentWidth)
		.map((line) => theme.base("decisionExplanation", line));
	let choices = choiceRows(theme, [...CHOICES], contentWidth);
	let head = factRows(theme, [{ label: "goal", value: goal }], contentWidth);
	// A short dock gives up, in order, the goal (the document's own Goal line says
	// it) and then each key's consequence, so the document keeps four rows and all
	// three keys stay on screen. The frame's cut at 40x15 hid the keys behind
	// `… 10 more rows` under a second position row.
	const MIN_DOCUMENT_ROWS = 4;
	const roomFor = (): number => rows - head.length - 1 - choices.length;
	if (rows > 0 && roomFor() < MIN_DOCUMENT_ROWS) head = [];
	if (rows > 0 && roomFor() < MIN_DOCUMENT_ROWS) {
		// The bare keys name only what the rail could not keep: at 40x15 the body
		// repeated the rail's accept and cancel and spent a third of the dock on them.
		const kept = railRoom > 0 ? fitHintEntryList(REVIEW_RAIL, railRoom).kept : [];
		const missing = CHOICES.filter((choice) => !kept.some((entry) => entry.key === choice.key));
		choices = chipRows(
			theme,
			missing.map((choice) => `${keyCap(theme, choice.key)} ${theme.fg("menuDescription", choice.verb)}`),
			contentWidth,
		);
	}
	const budget = rows > 0 ? Math.max(1, roomFor()) : HANDOFF_REVIEW_VISIBLE_ROWS;
	const fits = rendered.length <= budget;
	const pane = windowRows(rendered, scroll, fits ? budget : budget - 1);
	const count = `${rendered.length} line${rendered.length === 1 ? "" : "s"}`;
	return {
		lines: [
			...head,
			sectionRule(theme, contentWidth, "Document", { meta: fits ? count : "" }),
			...pane.window,
			...(pane.position === null
				? []
				: [positionRow(theme, { ...pane.position, unit: "lines", keys: ["↑↓ scroll"] }, contentWidth)]),
			...choices,
		],
		maxScroll: pane.maxScroll,
	};
}

export function openHandoffReviewOverlay(
	tui: TUI,
	options: OpenHandoffReviewOverlayOptions,
): HandoffReviewOverlaySession {
	let text = options.document ?? "";
	let preparing = options.document === null;
	let stage: HandoffPreparationStage = "reading";
	let route: string | null = null;
	const now = options.now ?? Date.now;
	const openedAt = now();
	let scroll = 0;
	let maxScroll = 0;
	let settled = false;
	// One Markdown render per (document, width, skin): the review is read for
	// a while and the document changes only through the editor.
	let memo: { key: string; lines: string[]; maxScroll: number } | null = null;
	let railRoom = 0;
	const cached = createCachedBody((width, rows) => {
		if (preparing) {
			return formatPreparingBody(options.goal, stage, route, now() - openedAt, spinnerFrame(animationStep(now())), width);
		}
		const key = `${width}|${rows}|${railRoom}|${scroll}|${skinEpoch()}|${text}`;
		if (memo?.key !== key) {
			const built = formatHandoffReviewBody(options.goal, text, width, scroll, rows, railRoom);
			memo = { key, lines: built.lines, maxScroll: built.maxScroll };
		}
		maxScroll = memo.maxScroll;
		return memo.lines;
	});
	const body = Object.assign(cached, {
		setRailRoom(cells: number): void {
			const next = Math.max(0, Math.floor(cells));
			if (next === railRoom) return;
			railRoom = next;
			cached.touch();
		},
	});

	// Nothing else redraws an idle screen, so the wait's clock keeps its own time.
	let clock: ReturnType<typeof setInterval> | null = preparing
		? setInterval(() => {
				body.touch();
				tui.requestRender();
			}, 250)
		: null;
	clock?.unref?.();
	const stopClock = (): void => {
		if (clock !== null) clearInterval(clock);
		clock = null;
	};

	const accept = (): void => {
		if (settled) return;
		settled = true;
		stopClock();
		options.onAccept(text);
	};
	const cancel = (): void => {
		if (settled) return;
		settled = true;
		stopClock();
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
			if (preparing) {
				if (matchesKey(data, "escape")) cancel();
				return;
			}
			const jump = scrollJump(data, scroll, maxScroll);
			if (jump !== null) {
				scrollBy(jump - scroll);
				return;
			}
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
		title: () => (preparing ? HANDOFF_PREPARING_OVERLAY_TITLE : HANDOFF_REVIEW_OVERLAY_TITLE),
		footerHint: (innerWidth) =>
			(preparing
				? buildResponsiveHint([], { key: "Esc", verb: "cancel" })
				: (room: number) => fitHintEntries(REVIEW_RAIL, room - 3))(innerWidth),
	});

	return {
		...handle,
		document: () => text,
		showDocument(document: string): void {
			if (settled) return;
			text = document;
			preparing = false;
			stopClock();
			body.touch();
			tui.requestRender();
		},
		setPreparation(next: HandoffPreparationStage): void {
			stage = next;
			body.touch();
			tui.requestRender();
		},
		setRoute(next: string): void {
			route = next;
			body.touch();
			tui.requestRender();
		},
		hide(): void {
			cancel();
			handle.hide();
		},
	};
}
