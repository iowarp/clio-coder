import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { Component, Terminal } from "../../src/engine/tui.js";
import { TuiAltScreen } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { buildFullscreenLayout, buildLayout } from "../../src/interactive/layout.js";

function linesComponent(lines: string[]): Component {
	return {
		render: () => lines,
		invalidate: () => {},
	};
}

class CaptureTerminal implements Terminal {
	readonly writes: string[] = [];
	readonly columns = 30;
	readonly rows = 10;
	readonly kittyProtocolActive = false;
	private onInput: (data: string) => void = () => {};

	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
	stop(): void {}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	send(data: string): void {
		this.onInput(data);
	}
}

describe("fullscreen transcript layout", () => {
	it("keeps the regular renderer's flat component order", () => {
		const root = buildLayout({
			banner: linesComponent(["banner"]),
			chat: linesComponent(["chat"]),
			pending: linesComponent(["pending"]),
			editor: linesComponent(["editor"]),
			footer: linesComponent(["footer"]),
		});
		strictEqual(root.render(30).join("\n"), "banner\nchat\npending\neditor\nfooter");
	});

	it("scrolls only the transcript while the pending queue, editor, and footer stay docked", () => {
		const chatLines = Array.from({ length: 20 }, (_, index) => `chat-${index + 1}`);
		const terminal = new CaptureTerminal();
		const layout = buildFullscreenLayout(
			{
				banner: linesComponent(["banner"]),
				chat: linesComponent(chatLines),
				pending: linesComponent(["pending"]),
				editor: linesComponent(["editor-a", "editor-b", "editor-c"]),
				footer: linesComponent(["footer"]),
			},
			{ fullscreenScrollbar: "always" },
		);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(layout.root);
		tui.setLayoutRoot(layout.root);
		tui.start();
		tui.renderNow(true);

		const firstFrame = terminal.writes.join("");
		strictEqual(layout.transcript.primary, true);
		strictEqual(layout.transcript.scrollbar, "always");
		strictEqual(layout.transcript.viewportHeight, 5);
		strictEqual(layout.transcript.isFollowingEnd, true);
		ok(firstFrame.includes("chat-20"), firstFrame);
		ok(!firstFrame.includes("chat-1 "), firstFrame);
		ok(firstFrame.includes("pending"), firstFrame);
		ok(firstFrame.includes("editor-a"), firstFrame);
		ok(firstFrame.includes("editor-c"), firstFrame);
		ok(firstFrame.includes("footer"), firstFrame);
		ok(firstFrame.includes("█"), "always mode renders a draggable scrollbar thumb");

		tui.scrollToTop();
		tui.renderNow(true);
		strictEqual(layout.transcript.scrollTop, 0);
		strictEqual(layout.transcript.isFollowingEnd, false);
		ok(terminal.writes.at(-1)?.includes("banner"), "the transcript reaches its own first row");

		chatLines.push("chat-21");
		layout.root.invalidate();
		tui.renderNow(true);
		strictEqual(layout.transcript.scrollTop, 0, "new output does not steal a manually scrolled viewport");
		tui.scrollToBottom();
		tui.renderNow(true);
		strictEqual(layout.transcript.isFollowingEnd, true);
		strictEqual(layout.transcript.scrollTop, 17);

		tui.stop({ preserveScreen: true });
	});

	it("jumps between Clio user turns with Pi's semantic prompt keys", () => {
		const terminal = new CaptureTerminal();
		const chat = createChatPanel();
		for (let index = 1; index <= 12; index += 1) chat.appendUser(`prompt-${index}`);
		const layout = buildFullscreenLayout({
			banner: linesComponent(["banner"]),
			chat,
			editor: linesComponent(["editor-a", "editor-b", "editor-c"]),
			footer: linesComponent(["footer"]),
		});
		const tui = new TuiAltScreen(terminal);
		tui.setLayoutRoot(layout.root);
		tui.start();
		tui.renderNow(true);

		const atEnd = tui.viewportTop;
		terminal.send("\x1b[1;6A");
		tui.renderNow(true);
		const previousPrompt = tui.viewportTop;
		ok(previousPrompt < atEnd, `previous prompt should move above ${atEnd}, got ${previousPrompt}`);
		terminal.send("\x1b[1;6B");
		tui.renderNow(true);
		strictEqual(tui.viewportTop, atEnd, "next prompt returns to the following marked user turn");

		tui.stop({ preserveScreen: true });
	});
});
