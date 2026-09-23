import type { Component, ScrollViewScrollbar, TuiMode } from "../engine/tui.js";
import { Container, ScrollView, VStack } from "../engine/tui.js";
import type { ChatPanelRegions } from "./chat-panel.js";
import { clioTheme, GLYPH } from "./theme/index.js";

/** A transcript that can hand over its settled prefix and live tail separately. */
export interface TranscriptComponent extends Component {
	renderRegions?(width: number): ChatPanelRegions;
}

export interface LayoutParts {
	banner: Component;
	chat: TranscriptComponent;
	pending?: Component;
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

/**
 * One blank row around a transcript that has anything in it: above, against
 * the header, and below, against the queue and composer rail. Fullscreen's
 * scroll view wraps the transcript in this; regular mode builds the same rows
 * inline in its root. The collapsed
 * session header is exactly one row by contract, and the first prompt bar used
 * to sit flush against it, as the newest receipt did against the composer. The
 * wrapped array is reused while the transcript returns the same cached array,
 * so a cache-hit frame stays O(1).
 */
function separatedTranscript(chat: TranscriptComponent): Component {
	let source: unknown;
	let separated: string[] = [];
	return {
		render(width: number): string[] {
			const regions = chat.renderRegions?.(width);
			if (regions !== undefined) {
				// One exact-size copy of the frame, straight from the panel's two
				// parts, instead of the panel joining them and this wrapper copying
				// the result again row by row.
				if (regions !== source) {
					source = regions;
					separated =
						regions.prefix.length + regions.tail.length === 0 ? [] : [""].concat(regions.prefix, regions.tail, [""]);
				}
				return separated;
			}
			const lines = chat.render(width);
			if (lines.length === 0) return lines;
			if (lines !== source) {
				source = lines;
				separated = [""].concat(lines, [""]);
			}
			return separated;
		},
		invalidate(): void {
			source = undefined;
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
	const document = new Container();
	document.addChild(parts.banner);
	document.addChild(separatedTranscript(parts.chat));
	const theme = clioTheme();
	const transcript = new TranscriptScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.fullscreenScrollbar ?? "auto",
		scrollbarTrackStyle: (text) => theme.fg("frame", text),
		scrollbarThumbStyle: () => theme.fg("frameStrong", GLYPH.barFull),
	});
	options.onTranscript?.(transcript);
	const dock = new VStack();
	if (parts.pending) dock.addChild(parts.pending, { shrink: 1, minSize: 0 });
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

	constructor(private readonly parts: LayoutParts) {}

	render(width: number): string[] {
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
		if (this.parts.pending) write(this.parts.pending.render(width));
		write(this.parts.editor.render(width));
		write(this.parts.footer.render(width));
		out.length = row;
		return out;
	}

	invalidate(): void {
		this.heldPrefix = null;
		this.parts.banner.invalidate();
		this.parts.chat.invalidate();
		this.parts.pending?.invalidate();
		this.parts.editor.invalidate();
		this.parts.footer.invalidate();
	}
}

export function buildLayout(parts: LayoutParts, options: LayoutOptions = {}): Component {
	if (options.mode === "fullscreen") return buildFullscreenLayout(parts, options).root;
	return new RegularRoot(parts);
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
