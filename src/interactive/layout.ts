import type { Component } from "../engine/tui.js";
import { Container } from "../engine/tui.js";

export interface LayoutParts {
	banner: Component;
	chat: Component;
	pending?: Component;
	editor: Component;
	footer: Component;
}

export function buildLayout(parts: LayoutParts): Container {
	const root = new Container();
	root.addChild(parts.banner);
	root.addChild(parts.chat);
	if (parts.pending) root.addChild(parts.pending);
	root.addChild(parts.editor);
	root.addChild(parts.footer);
	return root;
}
