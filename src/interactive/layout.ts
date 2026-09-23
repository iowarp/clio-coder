import type { Component, ScrollViewScrollbar, TuiMode } from "../engine/tui.js";
import { Container, ScrollView, VStack } from "../engine/tui.js";
import { clioTheme, GLYPH } from "./theme/index.js";

export interface LayoutParts {
	banner: Component;
	chat: Component;
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
function separatedTranscript(chat: Component): Component {
	let source: string[] | undefined;
	let separated: string[] = [];
	return {
		render(width: number): string[] {
			const lines = chat.render(width);
			if (lines.length === 0) return lines;
			if (lines !== source) {
				source = lines;
				separated = [""];
				for (const line of lines) separated.push(line);
				separated.push("");
			}
			return separated;
		},
		invalidate(): void {
			source = undefined;
			chat.invalidate();
		},
	};
}

function buildFullscreenLayout(parts: LayoutParts, options: LayoutOptions = {}): FullscreenLayout {
	const document = new Container();
	document.addChild(parts.banner);
	document.addChild(separatedTranscript(parts.chat));
	const theme = clioTheme();
	const transcript = new ScrollView(document, {
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
	 * Rebuilt in place every frame. The renderer copies the root's rows before
	 * normalizing them, so nothing holds this array across frames, and reusing
	 * it spares the collector one transcript-sized array per streamed token.
	 */
	private readonly out: string[] = [];

	constructor(private readonly parts: LayoutParts) {}

	render(width: number): string[] {
		const out = this.out;
		out.length = 0;
		const append = (lines: readonly string[]): void => {
			for (const line of lines) out.push(line);
		};
		append(this.parts.banner.render(width));
		const chat = this.parts.chat.render(width);
		if (chat.length > 0) {
			out.push("");
			append(chat);
			out.push("");
		}
		if (this.parts.pending) append(this.parts.pending.render(width));
		append(this.parts.editor.render(width));
		append(this.parts.footer.render(width));
		return out;
	}

	invalidate(): void {
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
