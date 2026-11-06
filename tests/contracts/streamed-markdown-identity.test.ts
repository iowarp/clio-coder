import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createChatPanel } from "../../src/interactive/chat-panel.js";

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
			streamed.render(40);
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
