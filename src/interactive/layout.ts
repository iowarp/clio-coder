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

function buildFullscreenLayout(parts: LayoutParts, options: LayoutOptions = {}): FullscreenLayout {
	const document = new Container();
	document.addChild(parts.banner);
	document.addChild(parts.chat);
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

export function buildLayout(parts: LayoutParts, options: LayoutOptions = {}): Component {
	if (options.mode === "fullscreen") return buildFullscreenLayout(parts, options).root;
	const root = new Container();
	root.addChild(parts.banner);
	root.addChild(parts.chat);
	if (parts.pending) root.addChild(parts.pending);
	root.addChild(parts.editor);
	root.addChild(parts.footer);
	return root;
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
