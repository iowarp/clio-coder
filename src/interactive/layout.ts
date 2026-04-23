import type { Component } from "../engine/tui.js";
import { Container, Text } from "../engine/tui.js";

export interface LayoutParts {
	banner: Text;
	chat: Component;
	editor: Component;
	footer: Component;
}

export function buildLayout(parts: LayoutParts): Container {
	const root = new Container();
	root.addChild(parts.banner);
	root.addChild(parts.chat);
	root.addChild(parts.editor);
	root.addChild(parts.footer);
	return root;
}

export function defaultBanner(): Text {
	return new Text("  ◆ clio  IOWarp orchestrator coding-agent\n");
}
