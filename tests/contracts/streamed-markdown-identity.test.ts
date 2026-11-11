import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { settledMarkdownHead } from "../../src/interactive/renderers/markdown-blocks.js";

// A streamed answer renders as a settled head plus an open tail (#428); finished, it must read exactly as the
// same text rendered whole. Each text puts a cut next to a construct that could join blocks across it.
const texts = {
	list: "Steps:\n\n- a\n\n  b\n\n- c\n\n  d\n\nEnd.\n\nDone.\n",
	fence: "Intro.\n\n```py\ndef f():\n\n    return 1\n```\n\nAfter.\n\nDone.\n",
	math: "Before.\n\n$$\na + b\n\nc + d\n$$\n\nAfter $x$ here.\n\nDone.\n",
	definition: "A [late] link.\n\nSecond.\n\nThird.\n\n[late]: u",
	mermaid: "Here:\n\n```mermaid\nflowchart TD\nA[Start] --> B[Model]\nB --> C[End]\n```\n\nAfter.\n\nDone.\n",
	table:
		"Intro.\n\n| Name | Description | Default | Notes |\n| --- | --- | --- | --- |\n| `alpha` | a long description that wraps | 1 | more words |\n\nEnd.\n\nDone.\n",
	// Blocks with no blank line between them: each cut must add the spacing row Pi draws, or none where it draws none.
	headed: "# Plan\nIntro line.\n## Step one\nFirst line.\nSecond line.\n## Step two\n- a\n- b\n## End\nDone.\n",
	joined:
		"Text.\n```ts\nconst a = 1;\n```\nAfter code.\n> quoted\n## H\n---\nRule above.\n1. one\n### Last\n    indented\n## Tail\n",
	// A `$$` line whose body does not read as math yet is a paragraph until its closing `$$` makes one math block.
	"pending math before a fence": "Intro.\n\n$$\n```x\n$$\n\nAfter.\n",
	"pending math before a heading": "Intro.\n\n$$\n# head\n$$\n\nAfter.\n",
	"pending math across a blank line": "Intro.\n\n$$\n\nfoo\n\n$$\n\nAfter.\n",
	"pending math inside a paragraph": "Para\n$$\nfoo\n# H\n$$\n\nAfter.\n",
};
const finished = (text: string): string[] => {
	const panel = createChatPanel({ now: () => 1_000 });
	panel.appendUser("Q");
	panel.applyEvent({ type: "agent_start" } as never);
	const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
	panel.applyEvent({ type: "message_end", message } as never);
	return panel.render(40);
};
const yieldToLoop = (): Promise<void> => new Promise((done) => setImmediate(done));

for (const [name, text] of Object.entries(texts)) {
	test(`a streamed ${name} answer renders as the whole text once finished`, async () => {
		const streamed = createChatPanel({ now: () => 1_000 });
		const whole = createChatPanel({ now: () => 1_000 });
		for (const panel of [streamed, whole]) {
			panel.appendUser("Q");
			panel.applyEvent({ type: "agent_start" } as never);
		}
		for (let at = 0; at < text.length; at += 2) {
			streamed.applyEvent({ type: "text_delta", delta: text.slice(at, at + 2) } as never);
			// The stream holds its last character back until the next one shows how it joins.
			const shown = text.slice(0, Math.min(at + 2, text.length) - 1);
			deepStrictEqual(streamed.render(40), finished(shown), `at ${shown.length}`);
			await yieldToLoop();
		}
		const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
		for (const panel of [streamed, whole]) {
			panel.applyEvent({ type: "message_end", message } as never);
			panel.applyEvent({ type: "agent_end", messages: [message] } as never);
		}
		deepStrictEqual(streamed.render(40), whole.render(40));
	});
}

test("a streamed answer with no blank lines settles at its block boundaries", () => {
	const text = "## One\nFirst line.\nSecond line.\n## Two\nThird line.\n";
	// The heading that starts section two closes section one's paragraph, and the head draws Pi's spacing row.
	deepStrictEqual(settledMarkdownHead(text, "\u2800", text.length), { length: text.indexOf("Third"), spacing: true });
	deepStrictEqual(settledMarkdownHead(text, "\u2800", text.indexOf("Third") - 1), {
		length: text.indexOf("## Two"),
		spacing: true,
	});
	// A list never draws one; a tight list alone has no cut yet.
	deepStrictEqual(settledMarkdownHead("- a\n- b\n## H\nx\n", "\u2800", 99), { length: 13, spacing: true });
	deepStrictEqual(settledMarkdownHead("- a\n- b\n## H\n", "\u2800", 99), { length: 8, spacing: false });
	deepStrictEqual(settledMarkdownHead("- a\n- b\n- c\n", "\u2800", 99), { length: 0, spacing: false });
	// A `$$` line not yet read as math keeps the cut above it, and none after it until it closes. Closed, the math
	// block takes in the blank line after it, so the next cut sits after the block that follows.
	const pending = "One.\n\n$$\n\nfoo\n\nbar\n";
	deepStrictEqual(settledMarkdownHead(pending, "\u2800", 99), { length: pending.indexOf("$$"), spacing: false });
	const closed = `${pending}$$\n\nAfter.\n\nTail.\n`;
	deepStrictEqual(settledMarkdownHead(closed, "\u2800", 99), { length: closed.indexOf("Tail"), spacing: false });
});
