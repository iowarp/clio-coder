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
}

export interface FullscreenLayout {
	root: VStack;
	transcript: ScrollView;
}

export function buildFullscreenLayout(
	parts: LayoutParts,
	options: Pick<LayoutOptions, "fullscreenScrollbar"> = {},
): FullscreenLayout {
	const document = new Container();
	document.addChild(parts.banner);
	document.addChild(parts.chat);
	const theme = clioTheme();
	const transcript = new ScrollView(document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.fullscreenScrollbar ?? "auto",
		scrollbarStyle: () => theme.fg("frameStrong", GLYPH.barFull),
	});
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
