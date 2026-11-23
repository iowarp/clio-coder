import type { Component, ScrollViewScrollbar, TUI, TuiMode } from "../engine/tui.js";
import { ScrollView, TuiAltScreen, truncateToWidth, VStack, visibleWidth } from "../engine/tui.js";
import type { ChatPanelRegions } from "./chat-panel.js";
import { keptRows } from "./kept-rows.js";
import { fitRails, railsFolded, railsRoom, type VariantRail } from "./rails-budget.js";
import { clioTheme, GLYPH } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";
import type { TranscriptViewport } from "./transcript-runs.js";

/** A transcript that can hand over its rows as pieces it promises never to mutate. */
export interface TranscriptComponent extends Component {
	renderRegions?(width: number, viewport?: TranscriptViewport): ChatPanelRegions;
}

export interface LayoutParts {
	banner: Component;
	chat: TranscriptComponent;
	/** An extension workspace's board band; empty unless a workspace places one there. */
	workspace?: Component;
	pending?: Component;
	fleet?: Component;
	contextProgress?: Component;
	editor: Component;
	footer: Component;
}

export interface LayoutOptions {
	mode?: TuiMode;
	fullscreenScrollbar?: ScrollViewScrollbar;
	onTranscript?: (view: ScrollView) => void;
	/** Terminal height. With it the rails above the composer keep to the transcript's budget and fold on a short screen. */
	getTerminalRows?: () => number;
}

/**
 * The rails between the transcript and the composer, in screen order; the operator's own queued words keep rows first.
 * The fleet dock sizes itself by the terminal's rows and offers whole variants, so it never folds.
 */
function railEntries(parts: LayoutParts): Array<{ component: Component; priority: number; foldable: boolean }> {
	return [
		...(parts.workspace ? [{ component: parts.workspace, priority: 1, foldable: false }] : []),
		...(parts.pending ? [{ component: parts.pending, priority: 0, foldable: false }] : []),
		...(parts.fleet ? [{ component: parts.fleet, priority: 2, foldable: false }] : []),
		...(parts.contextProgress ? [{ component: parts.contextProgress, priority: 3, foldable: true }] : []),
	];
}

/** One rail's rows this frame: its largest variant as its lines, and every variant when it offers them. */
interface RenderedRail {
	lines: readonly string[];
	variants?: ReadonlyArray<readonly string[]>;
}

function renderRail(component: Component, width: number): RenderedRail {
	const variants = (component as Partial<VariantRail>).renderVariants?.(width);
	return variants === undefined ? { lines: component.render(width) } : { lines: variants[0] ?? [], variants };
}

/** Each rail's rows this frame, cut to the budget a composer and footer of these heights leave. */
function budgetRails(
	rails: ReadonlyArray<{ priority: number; foldable: boolean }>,
	rendered: ReadonlyArray<RenderedRail>,
	width: number,
	terminalRows: number | undefined,
	fixedRows: () => number,
): ReadonlyArray<readonly string[]> {
	if (terminalRows === undefined || rendered.every((rail) => rail.lines.length === 0))
		return rendered.map((rail) => rail.lines);
	const fixed = fixedRows();
	return fitRails(
		rails.map((rail, index) => ({ ...rail, ...(rendered[index] ?? { lines: [] }) })),
		railsRoom(terminalRows, fixed, 0),
		railsFolded(terminalRows),
		width,
	);
}

/**
 * Fullscreen lays the dock out child by child, measuring each once a frame in screen order, so the rails render ahead
 * of the composer. The first rail of a frame renders them all, measures the composer and footer, and hands each rail
 * its share; the composer and footer stay the layout's own children, so focus and mouse still reach them.
 */
class RailsAllocator {
	private granted: Array<readonly string[] | null> = [];
	private grantedWidth = -1;

	constructor(
		private readonly rails: ReadonlyArray<{ component: Component; priority: number; foldable: boolean }>,
		private readonly fixedRows: (width: number) => number,
		private readonly getTerminalRows: () => number,
	) {}

	take(index: number, width: number): string[] {
		if (this.granted[index] == null || this.grantedWidth !== width) {
			const rendered = this.rails.map((rail) => renderRail(rail.component, width));
			this.granted = [...budgetRails(this.rails, rendered, width, this.getTerminalRows(), () => this.fixedRows(width))];
			this.grantedWidth = width;
		}
		const lines = this.granted[index] ?? [];
		this.granted[index] = null;
		return [...lines];
	}

	slot(index: number): Component {
		const inner = this.rails[index]?.component;
		const slot: Component = {
			render: (width) => this.take(index, width),
			invalidate: () => {
				this.granted = [];
				inner?.invalidate();
			},
		};
		if (inner?.handleInput) slot.handleInput = (data) => inner.handleInput?.(data);
		if (inner?.handleMouse) slot.handleMouse = (event) => inner.handleMouse?.(event);
		return slot;
	}
}

export interface FullscreenLayout {
	root: VStack;
	transcript: ScrollView;
}

/**
 * Write a transcript's pieces into `out` from `row`, skipping each piece `held` names at the same row: the buffer
 * still holds those rows. A piece new at a row it replaced skips the leading rows its producer vouches for. Returns
 * the row after the last piece and what the buffer holds now, by the row each piece starts at.
 */
function writePieces(
	pieces: readonly (readonly string[])[],
	start: number,
	held: ReadonlyMap<number, readonly string[]> | undefined,
	write: (rows: readonly string[], from: number, at: number) => void,
): { row: number; holds: Map<number, readonly string[]> } {
	const holds = new Map<number, readonly string[]>();
	let row = start;
	for (const piece of pieces) {
		const before = held?.get(row);
		holds.set(row, piece);
		if (before !== piece) write(piece, before === undefined ? 0 : keptRows(piece, before), row);
		row += piece.length;
	}
	return { row, holds };
}

/** One document array, and the transcript pieces it holds by the row each starts at. */
interface DocumentSlot {
	rows: string[];
	holds: Map<number, readonly string[]>;
}

/**
 * Fullscreen's scrollable document. A composer-only frame returns the same
 * array, and a frame whose content changed returns a different one. The arrays
 * come from a small pool and each remembers which transcript pieces it holds, so a
 * streamed token writes only the header and the pieces that changed instead of copying every
 * historical row into a new array, which at 24,000 rows was garbage enough for
 * a 12 to 15 ms p99. The last two arrays returned stay intact, which is what a
 * reader of the previous frame relies on: the current layout until the next one
 * replaces it, and `preserveTranscriptScroll` comparing before with after.
 */
function transcriptDocument(
	banner: Component,
	chat: TranscriptComponent,
	view: () => TranscriptScrollView | undefined,
): Component {
	const viewportRows = (): number => view()?.viewportHeight ?? 0;
	let source: unknown;
	let anchored: { from: readonly string[]; rows: number; lines: string[] } | null = null;
	let header: string[] = [];
	let lines: string[] = [];
	// True while the document is the banner alone: the launchpad before the first turn.
	let bannerOnly = true;
	let renderedSkinEpoch = skinEpoch();
	const pool: DocumentSlot[] = Array.from({ length: 3 }, () => ({ rows: [], holds: new Map() }));
	let turn = 0;
	const compose = (slot: DocumentSlot, regions: ChatPanelRegions | undefined, whole: readonly string[]): string[] => {
		const out = slot.rows;
		let row = 0;
		const write = (from: readonly string[]): void => {
			for (const line of from) out[row++] = line;
		};
		write(header);
		bannerOnly = (regions?.rows ?? whole.length) === 0;
		if (bannerOnly) {
			slot.holds = new Map();
		} else {
			out[row++] = "";
			if (regions !== undefined) {
				// Only the panel promises arrays it never mutates; any other chat is copied every time. The slot last
				// held a frame three frames back, so a piece rendered since is written whole.
				const written = writePieces(regions.pieces, row, slot.holds, (rows, _kept, at) => {
					for (let index = 0; index < rows.length; index += 1) out[at + index] = rows[index] as string;
				});
				row = written.row;
				slot.holds = written.holds;
			} else {
				slot.holds = new Map();
				write(whole);
			}
			out[row++] = "";
		}
		out.length = row;
		return out;
	};
	/**
	 * A document shorter than the viewport sits on the composer rather than
	 * under the top edge: the launchpad and the first turns stay next to the
	 * place the operator types, as they do on the regular screen, and the
	 * spare rows go above them. The launchpad alone is a splash, not a turn:
	 * it stands in the middle of the free rows, because sixteen blank rows over
	 * a box read as a layout that had not finished drawing. The padded copy is
	 * reused while neither the document nor the viewport changes, so an idle
	 * frame stays the same array.
	 */
	const bottomAnchored = (from: string[]): string[] => {
		const rows = viewportRows();
		if (from.length >= rows) return from;
		if (anchored?.from === from && anchored.rows === rows) return anchored.lines;
		const spare = rows - from.length;
		const above = bannerOnly ? Math.floor(spare / 2) : spare;
		const lines = [
			...Array.from({ length: above }, () => ""),
			...from,
			...Array.from({ length: spare - above }, () => ""),
		];
		anchored = { from, rows, lines };
		return lines;
	};
	return {
		render(width: number): string[] {
			if (renderedSkinEpoch !== skinEpoch()) {
				renderedSkinEpoch = skinEpoch();
				source = undefined;
				banner.invalidate();
				chat.invalidate();
			}
			const nextHeader = banner.render(width);
			const regions = chat.renderRegions?.(width, view()?.transcriptViewport());
			const nextSource = regions ?? chat.render(width);
			const headerRows = header.length;
			const fresh = nextSource !== source;
			// Compare the small header by value: components may return fresh arrays
			// or mutate their old array. Own the snapshot used for this comparison.
			if (
				nextSource !== source ||
				nextHeader.length !== header.length ||
				nextHeader.some((row, index) => row !== header[index])
			) {
				source = nextSource;
				header = nextHeader.slice();
				turn = (turn + 1) % pool.length;
				lines = compose(pool[turn] as DocumentSlot, regions, regions === undefined ? (nextSource as string[]) : []);
				// History re-laid out around the viewport: the rows it showed moved by the shift, and by the banner's change.
				if (fresh && regions?.shift !== undefined) view()?.holdRows(regions.shift + header.length - headerRows);
			}
			return bottomAnchored(lines);
		},
		invalidate(): void {
			source = undefined;
			banner.invalidate();
			chat.invalidate();
		},
	};
}

/**
 * The fullscreen transcript keeps its last column for the scrollbar whenever
 * one can appear. pi-tui reserves the column only for an `always` bar, so the
 * `auto` bar, which shows while the operator scrolls, painted over the last
 * cell of every row it passed: a table's right border, a word's last letter.
 * Reserving it costs one column and never reflows when the bar comes and goes.
 */
class TranscriptScrollView extends ScrollView {
	/** The content width the layout asked for last, and the width and height of the content last laid out. */
	private askedWidth: number | undefined;
	private laidWidth: number | undefined;
	private laidHeight = 0;
	/** How far the document says the rows this view showed moved, for the layout about to happen. */
	private heldShift: number | undefined;

	/** Where this view sits over the transcript, which the document lays out first after a layout change. */
	transcriptViewport(): TranscriptViewport | undefined {
		if (this.viewportHeight === 0) return undefined;
		// The document closes on one blank row after the transcript.
		const fromEnd = this.isFollowingEnd ? 0 : this.laidHeight - this.scrollTop - this.viewportHeight - 1;
		return { fromEnd: Math.max(0, fromEnd), rows: this.viewportHeight };
	}

	/** The document re-laid out its content around this view: the rows it showed moved by `shift`. */
	holdRows(shift: number): void {
		this.heldShift = shift;
	}

	dropHeldRows(): void {
		this.heldShift = undefined;
	}

	override getContentWidth(width: number): number {
		const contentWidth = this.scrollbar !== "hidden" && width > 1 ? width - 1 : width;
		this.askedWidth = contentWidth;
		return contentWidth;
	}

	/**
	 * The document pads a short transcript to the viewport it last saw, so a
	 * viewport that changes height under short content asks for one more frame,
	 * which pads to the new height instead of leaving a gap until the next event.
	 *
	 * A width change re-wraps every row above a scrolled-up reader, so the same
	 * row index lands tens of paragraphs away. The top moves by the same share of
	 * the content instead, which keeps the reader near their place and brings it
	 * back when the width does. A view that follows the end keeps following. A document that re-laid out its content
	 * around the view says how far the rows it showed moved, and the view moves by exactly that instead.
	 */
	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const before = this.viewportHeight;
		const top = this.scrollTop;
		const held = this.heldShift;
		this.heldShift = undefined;
		const reflowed =
			held === undefined &&
			this.laidWidth !== undefined &&
			this.askedWidth !== this.laidWidth &&
			!this.isFollowingEnd &&
			this.laidHeight > 0 &&
			top > 0;
		const laidHeight = this.laidHeight;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		this.laidWidth = this.askedWidth;
		this.laidHeight = contentHeight;
		if (held !== undefined && held !== 0 && !this.isFollowingEnd) this.scrollTo(top + held, { disableFollow: true });
		if (reflowed) this.scrollTo(Math.round((top * contentHeight) / laidHeight), { disableFollow: true });
		if (viewportHeight !== before && contentHeight <= Math.max(before, viewportHeight)) requestRender();
	}
}

function buildFullscreenLayout(parts: LayoutParts, options: LayoutOptions = {}): FullscreenLayout {
	let transcript: TranscriptScrollView | undefined;
	const document = transcriptDocument(parts.banner, parts.chat, () => transcript);
	const theme = clioTheme();
	transcript = new TranscriptScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.fullscreenScrollbar ?? "auto",
		scrollbarTrackStyle: (text) => theme.fg("border", text),
		scrollbarThumbStyle: () => theme.fg("scrollMarker", GLYPH.barFull),
	});
	options.onTranscript?.(transcript);
	const dock = new VStack();
	const rails = railEntries(parts);
	const getTerminalRows = options.getTerminalRows;
	if (getTerminalRows) {
		// Measuring the composer here renders it a second time this frame, which only a frame with a rail showing pays.
		const allocator = new RailsAllocator(
			rails,
			(width) => parts.editor.render(width).length + parts.footer.render(width).length,
			getTerminalRows,
		);
		for (const index of rails.keys()) dock.addChild(allocator.slot(index), { shrink: 1, minSize: 0 });
	} else {
		for (const rail of rails) dock.addChild(rail.component, { shrink: 1, minSize: 0 });
	}
	dock.addChild(parts.editor, { shrink: 1, minSize: 3 });
	dock.addChild(parts.footer, { shrink: 1, minSize: 1 });
	const root = new VStack();
	root.addChild(transcript, { basis: 0, grow: 1, shrink: 1, minSize: 1 });
	root.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
	return { root, transcript };
}

/**
 * Regular-mode root. The terminal renderer copies whatever the root returns
 * before it normalizes rows in place, so the root is the one place the
 * transcript is copied: the stack is built in a single pass with the
 * transcript's blank rows inline, instead of a separating wrapper and a
 * container each copying every row again.
 */
class RegularRoot implements Component {
	/**
	 * Rewritten in place every frame. The renderer copies the root's rows before
	 * normalizing them, so nothing holds this array across frames. Rows are
	 * written by index and the array is trimmed at the end, so its backing store
	 * survives from frame to frame instead of regrowing from empty.
	 */
	private readonly out: string[] = [];
	/**
	 * The transcript pieces the buffer holds, by the row each starts at, with the width their rows were checked to fit
	 * (`Infinity` once a row was cut to fit, so a wider frame writes it whole again). A piece the panel hands back at
	 * the same row is still in place, and at that width or a wider one it still fits, so a frame writes only the pieces
	 * that changed; a layout change that kept history as it was writes only the rows it re-laid out.
	 */
	private heldPieces: ReadonlyMap<number, { rows: readonly string[]; fitsAt: number }> | undefined;
	private renderedSkinEpoch = skinEpoch();
	/** The width the buffer's rows were measured against: at that width, a row already in place is known to fit. */
	private heldWidth = -1;
	/** Counts `render` calls, so a renderer can tell `keptRowCount` is about the call after the one it saw. */
	renderCount = 0;
	/** How many leading rows the last `render` left as the very strings the render before it returned. */
	keptRowCount = 0;
	/** Set for the exit frame: the composer, rails and footer go so the exit summary follows the transcript. */
	private dockReleased = false;

	private readonly rails: ReturnType<typeof railEntries>;

	constructor(
		private readonly parts: LayoutParts,
		private readonly getTerminalRows?: () => number,
	) {
		this.rails = railEntries(parts);
	}

	render(width: number): string[] {
		if (this.renderedSkinEpoch !== skinEpoch()) {
			this.renderedSkinEpoch = skinEpoch();
			this.invalidate();
		}
		const out = this.out;
		const previousLength = out.length;
		this.renderCount += 1;
		let row = 0;
		// The first row this frame wrote a string other than the one already there.
		// A settled turn hands back a new prefix array of the same rows, and measuring every one of them again cost a
		// long session tens of milliseconds a turn. A row already in place at the same width was measured when it was
		// written; a new width measures every row, since one that fit the old width may not fit this one.
		const sameWidth = width === this.heldWidth;
		let firstChanged = sameWidth ? -1 : 0;
		this.heldWidth = width;
		let cut = false;
		const put = (raw: string): void => {
			if (sameWidth && out[row] === raw) {
				row += 1;
				return;
			}
			// The main-screen renderer throws on an overwide row; one component's bug clips instead.
			const overwide = visibleWidth(raw) > width;
			if (overwide) cut = true;
			const line = overwide ? truncateToWidth(raw, width) : raw;
			if (out[row] !== line) {
				if (firstChanged < 0) firstChanged = row;
				out[row] = line;
			}
			row += 1;
		};
		const write = (lines: readonly string[], from = 0): void => {
			for (let index = from; index < lines.length; index += 1) put(lines[index] as string);
		};
		write(this.parts.banner.render(width));
		const regions = this.parts.chat.renderRegions?.(width);
		let holds: Map<number, { rows: readonly string[]; fitsAt: number }> | undefined;
		if (regions !== undefined) {
			if (regions.rows > 0) {
				put("");
				holds = new Map();
				for (const piece of regions.pieces) {
					const at = row;
					const before = this.heldPieces?.get(at);
					if (before?.rows === piece && (sameWidth || width >= before.fitsAt)) {
						holds.set(at, before);
						row += piece.length;
						continue;
					}
					// A streaming reply's piece writes only the rows after those its panel vouches for, which are in place.
					const kept = sameWidth && before !== undefined ? keptRows(piece, before.rows) : 0;
					cut = kept > 0 && before?.fitsAt === Number.POSITIVE_INFINITY;
					row += kept;
					write(piece, kept);
					holds.set(at, { rows: piece, fitsAt: cut ? Number.POSITIVE_INFINITY : width });
				}
				put("");
			}
		} else {
			const chat = this.parts.chat.render(width);
			if (chat.length > 0) {
				put("");
				write(chat);
				put("");
			}
		}
		if (!this.dockReleased) {
			const rendered = this.rails.map((rail) => renderRail(rail.component, width));
			const editor = this.parts.editor.render(width);
			const footer = this.parts.footer.render(width);
			const rows = this.getTerminalRows?.();
			for (const lines of budgetRails(this.rails, rendered, width, rows, () => editor.length + footer.length))
				write(lines);
			write(editor);
			write(footer);
		}
		this.heldPieces = holds;
		out.length = row;
		this.keptRowCount = Math.min(firstChanged < 0 ? row : firstChanged, previousLength);
		return out;
	}

	releaseDock(): void {
		this.dockReleased = true;
	}

	invalidate(): void {
		this.heldWidth = -1;
		this.heldPieces = undefined;
		this.parts.banner.invalidate();
		this.parts.chat.invalidate();
		this.parts.workspace?.invalidate();
		this.parts.pending?.invalidate();
		this.parts.fleet?.invalidate();
		this.parts.contextProgress?.invalidate();
		this.parts.editor.invalidate();
		this.parts.footer.invalidate();
	}
}

export function buildLayout(parts: LayoutParts, options: LayoutOptions = {}): Component {
	if (options.mode === "fullscreen") return buildFullscreenLayout(parts, options).root;
	return new RegularRoot(parts, options.getTerminalRows);
}

/**
 * Drop the regular screen's dock from the next frame. The main screen leaves its
 * last frame in scrollback, so without this the exit summary printed after it
 * sits below a dead composer, footer and double-tap hint. Fullscreen leaves the
 * alternate screen on exit and keeps its root; returns whether the root changed.
 */
export function releaseRegularDock(root: Component): boolean {
	if (!(root instanceof RegularRoot)) return false;
	root.releaseDock();
	return true;
}

/**
 * Bring a fullscreen transcript back to its live edge and follow new output
 * again. A submission is the operator asking for what comes next, so a view
 * they scrolled up to read earlier output returns to where the new turn
 * writes. The regular screen has no viewport to move, and new output alone
 * never moves one the operator scrolled.
 */
export function returnToLiveEdge(tui: TUI): void {
	if (tui instanceof TuiAltScreen) tui.scrollToBottom();
}

/**
 * Page the fullscreen transcript by a screenful, for an owner of the keyboard (a card, a
 * question box) that has no scrolling of its own to do. False on the regular screen, which
 * has no viewport, so the caller keeps its ordinary handling of the key.
 */
export function scrollTranscriptPage(tui: TUI, direction: -1 | 1): boolean {
	if (!(tui instanceof TuiAltScreen)) return false;
	tui.scrollBy(direction * Math.max(1, tui.terminal.rows - 3));
	return true;
}

/** Keep the nearest surviving text at the viewport when a preset changes row counts. */
export function preserveTranscriptScroll(view: ScrollView | undefined, width: number, mutation: () => void): void {
	if (!view || view.isFollowingEnd) {
		mutation();
		return;
	}
	// This places the view itself; a shift the re-laid document reports would move it a second time.
	try {
		keepTextInView(view, width, mutation);
	} finally {
		if (view instanceof TranscriptScrollView) view.dropHeldRows();
	}
}

function keepTextInView(view: ScrollView, width: number, mutation: () => void): void {
	const top = view.scrollTop;
	const before = view.render(width);
	mutation();
	const after = view.render(width);
	for (let row = top; row < Math.min(before.length, top + view.viewportHeight); row++) {
		const anchor = before[row];
		if (!anchor?.trim()) continue;
		let match = -1;
		for (let index = 0; index < after.length; index++) {
			if (after[index] === anchor && (match < 0 || Math.abs(index - row) < Math.abs(match - row))) match = index;
		}
		if (match >= 0) {
			view.updateLayout(after.length, view.viewportHeight, () => {});
			view.scrollTo(Math.max(0, match - (row - top)), { disableFollow: true });
			return;
		}
	}
	view.scrollTo(top, { disableFollow: true });
}
