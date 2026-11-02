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

/**
 * Where the composer sat in the last frame. Overlays are placed by screen
 * row, so a floating stack anchored at the top reads this to end above the
 * composer's top rail instead of painting over it on a short frame.
 */
export interface ComposerPlacement {
	/** Screen rows above the composer at this terminal height, or null before the first frame. */
	rowsAbove(termRows: number): number | null;
}

export interface LayoutOptions {
	mode?: TuiMode;
	fullscreenScrollbar?: ScrollViewScrollbar;
	onTranscript?: (view: ScrollView) => void;
	onComposerPlacement?: (placement: ComposerPlacement) => void;
}

/** The same component, reporting how many rows it rendered. */
function measured(component: Component, record: (rows: number) => void): Component {
	return {
		render(width: number): string[] {
			const lines = component.render(width);
			record(lines.length);
			return lines;
		},
		invalidate(): void {
			component.invalidate();
		},
	};
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
function transcriptDocument(banner: Component, chat: TranscriptComponent): Component {
	let source: unknown;
	let header: string[] = [];
	let lines: string[] = [];
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
		if (whole.length + tail.length === 0) {
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
			return lines;
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
}

function buildFullscreenLayout(parts: LayoutParts, options: LayoutOptions = {}): FullscreenLayout {
	const document = transcriptDocument(parts.banner, parts.chat);
	const theme = clioTheme();
	const transcript = new TranscriptScrollView(document, {
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
	// The dock sits on the bottom edge, so the composer starts where the
	// editor and footer heights, measured each frame, leave off.
	let editorRows = -1;
	let footerRows = -1;
	const editor = options.onComposerPlacement
		? measured(parts.editor, (rows) => {
				editorRows = rows;
			})
		: parts.editor;
	const footer = options.onComposerPlacement
		? measured(parts.footer, (rows) => {
				footerRows = rows;
			})
		: parts.footer;
	options.onComposerPlacement?.({
		rowsAbove: (termRows) => (editorRows < 0 || footerRows < 0 ? null : Math.max(0, termRows - editorRows - footerRows)),
	});
	dock.addChild(editor, { shrink: 1, minSize: 3 });
	dock.addChild(footer, { shrink: 1, minSize: 1 });
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
	/** Rows of the last frame and the row its composer started at; -1 before the first. */
	private frameRows = -1;
	private composerRow = -1;

	constructor(private readonly parts: LayoutParts) {}

	/** Content shorter than the screen starts at its top row; a taller frame scrolls, keeping its bottom. */
	readonly placement: ComposerPlacement = {
		rowsAbove: (termRows) =>
			this.frameRows < 0 ? null : Math.max(0, this.composerRow - Math.max(0, this.frameRows - termRows)),
	};

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
		this.composerRow = row;
		write(this.parts.editor.render(width));
		write(this.parts.footer.render(width));
		out.length = row;
		this.frameRows = row;
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
	const root = new RegularRoot(parts);
	options.onComposerPlacement?.(root.placement);
	return root;
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
