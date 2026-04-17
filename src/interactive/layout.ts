import { Container, Text } from "../engine/tui.js";
import type { Component } from "../engine/tui.js";

export interface LayoutParts {
	banner: Text;
	body: Component;
	footer: Component;
}

export function buildLayout(parts: LayoutParts): Container {
	const root = new Container();
	root.addChild(parts.banner);
	root.addChild(parts.body);
	root.addChild(parts.footer);
	return root;
}

export function defaultBanner(): Text {
	return new Text("  ◆ clio  IOWarp orchestrator coding-agent\n");
}
