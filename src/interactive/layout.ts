import type { Component, ScrollViewScrollbar, TUI, TuiMode } from "../engine/tui.js";
import { ScrollView, TuiAltScreen, VStack } from "../engine/tui.js";
import type { ChatPanelRegions } from "./chat-panel.js";
import { clioTheme, GLYPH } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

/** A transcript that can hand over its settled prefix and live tail separately. */
export interface TranscriptComponent extends Component {
	renderRegions?(width: number): ChatPanelRegions;
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
}

export interface FullscreenLayout {
	root: VStack;
	transcript: ScrollView;
}

/** One document array, and the transcript prefix it already holds at a row. */
interface DocumentSlot {
	rows: string[];
	prefix: readonly string[] | null;
	prefixAt: number;
}

/**
 * Fullscreen's scrollable document. A composer-only frame returns the same
 * array, and a frame whose content changed returns a different one. The arrays
 * come from a small pool and each remembers which settled prefix it holds, so a
 * streamed token writes only the header and the tail instead of copying every
 * historical row into a new array, which at 24,000 rows was garbage enough for
 * a 12 to 15 ms p99. The last two arrays returned stay intact, which is what a
 * reader of the previous frame relies on: the current layout until the next one
 * replaces it, and `preserveTranscriptScroll` comparing before with after.
 */
function transcriptDocument(
	banner: Component,
	chat: TranscriptComponent,
	viewportRows: () => number = () => 0,
): Component {
	let source: unknown;
	let anchored: { from: readonly string[]; rows: number; lines: string[] } | null = null;
	let header: string[] = [];
	let lines: string[] = [];
	// True while the document is the banner alone: the launchpad before the first turn.
	let bannerOnly = true;
	let renderedSkinEpoch = skinEpoch();
	const pool: DocumentSlot[] = Array.from({ length: 3 }, () => ({ rows: [], prefix: null, prefixAt: -1 }));
	let turn = 0;
	const compose = (slot: DocumentSlot, regions: ChatPanelRegions | undefined, whole: readonly string[]): string[] => {
		const out = slot.rows;
		let row = 0;
		const write = (from: readonly string[]): void => {
			for (const line of from) out[row++] = line;
		};
		write(header);
		const tail = regions?.tail ?? [];
		bannerOnly = whole.length + tail.length === 0;
		if (bannerOnly) {
			slot.prefix = null;
		} else {
			out[row++] = "";
			// Only the panel promises an array it never mutates; any other chat is copied every time.
			if (regions !== undefined && slot.prefix === whole && slot.prefixAt === row) {
				row += whole.length;
			} else {
				slot.prefix = regions === undefined ? null : whole;
				slot.prefixAt = row;
				write(whole);
			}
			write(tail);
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
			const regions = chat.renderRegions?.(width);
			const nextSource = regions ?? chat.render(width);
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
				lines = compose(pool[turn] as DocumentSlot, regions, regions?.prefix ?? (nextSource as string[]));
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
	override getContentWidth(width: number): number {
		return this.scrollbar !== "hidden" && width > 1 ? width - 1 : width;
	}

	/**
	 * The document pads a short transcript to the viewport it last saw, so a
	 * viewport that changes height under short content asks for one more frame,
	 * which pads to the new height instead of leaving a gap until the next event.
	 */
	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		const before = this.viewportHeight;
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		if (viewportHeight !== before && contentHeight <= Math.max(before, viewportHeight)) requestRender();
	}
}

function buildFullscreenLayout(parts: LayoutParts, options: LayoutOptions = {}): FullscreenLayout {
	let transcript: TranscriptScrollView | undefined;
	const document = transcriptDocument(parts.banner, parts.chat, () => transcript?.viewportHeight ?? 0);
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
	if (parts.workspace) dock.addChild(parts.workspace, { shrink: 1, minSize: 0 });
	if (parts.pending) dock.addChild(parts.pending, { shrink: 1, minSize: 0 });
	if (parts.fleet) dock.addChild(parts.fleet, { shrink: 1, minSize: 0 });
	if (parts.contextProgress) dock.addChild(parts.contextProgress, { shrink: 1, minSize: 0 });
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
	 * The transcript prefix the buffer already holds and the row it starts at.
	 * While the panel hands back the same prefix at the same row, those rows are
	 * still in place and a frame writes only what follows them.
	 */
	private heldPrefix: readonly string[] | null = null;
	private heldPrefixAt = -1;
	private renderedSkinEpoch = skinEpoch();

	constructor(private readonly parts: LayoutParts) {}

	render(width: number): string[] {
		if (this.renderedSkinEpoch !== skinEpoch()) {
			this.renderedSkinEpoch = skinEpoch();
			this.invalidate();
		}
		const out = this.out;
		let row = 0;
		const write = (lines: readonly string[]): void => {
			for (const line of lines) out[row++] = line;
		};
		write(this.parts.banner.render(width));
		const regions = this.parts.chat.renderRegions?.(width);
		if (regions !== undefined) {
			if (regions.prefix.length + regions.tail.length > 0) {
				out[row++] = "";
				if (regions.prefix === this.heldPrefix && row === this.heldPrefixAt) {
					row += regions.prefix.length;
				} else {
					this.heldPrefix = regions.prefix;
					this.heldPrefixAt = row;
					write(regions.prefix);
				}
				write(regions.tail);
				out[row++] = "";
			} else {
				this.heldPrefix = null;
			}
		} else {
			this.heldPrefix = null;
			const chat = this.parts.chat.render(width);
			if (chat.length > 0) {
				out[row++] = "";
				write(chat);
				out[row++] = "";
			}
		}
		if (this.parts.workspace) write(this.parts.workspace.render(width));
		if (this.parts.pending) write(this.parts.pending.render(width));
		if (this.parts.fleet) write(this.parts.fleet.render(width));
		if (this.parts.contextProgress) write(this.parts.contextProgress.render(width));
		write(this.parts.editor.render(width));
		write(this.parts.footer.render(width));
		out.length = row;
		return out;
	}

	invalidate(): void {
		this.heldPrefix = null;
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
	return new RegularRoot(parts);
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
