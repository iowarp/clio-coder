import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { OutputStyle } from "../../src/core/defaults.js";
import { visibleWidth } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { framesToHtml } from "../../src/interactive/dev/ansi-html.js";
import { benchScale } from "../../src/interactive/dev/render-bench.js";
import {
	createSceneClock,
	openStreamingTurn,
	settleStreamingTurn,
	streamDelta,
	streamingAnswer,
	transcriptScenes,
} from "../../src/interactive/dev/transcript-scenes.js";

const STYLES: readonly OutputStyle[] = ["compact", "standard", "detailed"];

function play(sceneId: string, style: OutputStyle, width: number): string[] {
	const scene = transcriptScenes().find((candidate) => candidate.id === sceneId);
	ok(scene, sceneId);
	const clock = createSceneClock();
	const panel = createChatPanel({ now: clock.now, getOutputStyle: () => style, getTerminalRows: () => 40 });
	scene.play(panel, clock);
	return panel.render(width);
}

describe("transcript gallery scenes", () => {
	it("render deterministically and inside the terminal at every style and width", () => {
		for (const scene of transcriptScenes()) {
			for (const style of STYLES) {
				for (const width of [40, 60, 100, 200]) {
					const first = play(scene.id, style, width);
					ok(first.length > 0, `${scene.id} ${style} ${width} renders rows`);
					for (const row of first) ok(visibleWidth(row) <= width, `${scene.id} ${style} ${width}: ${row}`);
					strictEqual(play(scene.id, style, width).join("\n"), first.join("\n"), `${scene.id} ${style} ${width}`);
				}
			}
		}
	});

	it("keeps one HTML row per terminal row", () => {
		const lines = play("execute", "standard", 60);
		const html = framesToHtml([{ label: "execute", columns: 60, lines }], { title: "t" });
		strictEqual(html.match(/<div class="r">/gu)?.length, lines.length);
		ok(!html.includes("\u001b"), "no escape sequence reaches the page");
	});
});

describe("streamed answers settle without rewriting their rows", () => {
	it("leaves every streamed row byte-stable when the answer finalizes", () => {
		const panel = createChatPanel({ now: () => 0 });
		const answer = streamingAnswer(2_400);
		openStreamingTurn(panel);
		for (let at = 0; at < answer.length; at += 4) streamDelta(panel, answer.slice(at, at + 4));
		const streamed = panel.render(100);
		settleStreamingTurn(panel, answer);
		const settled = panel.render(100);
		// The receipt is appended below; nothing the operator already saw changes.
		strictEqual(settled.slice(0, streamed.length - 1).join("\n"), streamed.slice(0, -1).join("\n"));
	});

	it("never forces a full regular-screen redraw on finalize", () => {
		const result = benchScale({ entries: 40, mode: "regular", columns: 100, rows: 24, deltas: 200, keystrokes: 5 });
		strictEqual(result.finalize.fullRedraw, false);
		strictEqual(result.streaming.fullRedraws, 0);
		ok(result.finalize.bytes < 4_096, `finalize wrote ${result.finalize.bytes} bytes`);
	});
});
