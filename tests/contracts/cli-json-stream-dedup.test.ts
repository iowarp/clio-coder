/**
 * The headless `--json` stream carries each piece of content exactly once.
 *
 * `message_end` used to pass through whole, so every assistant token crossed
 * the wire twice: once as a `text_delta` / `thinking_delta` increment and again
 * inside the completed message. Measured on one audit run, 41,094 bytes of
 * deltas alongside 24,600 bytes of `message_end` restating the same blocks. A
 * consumer that renders both renders everything doubled.
 *
 * The same event is why `--json-events terminal` was not a receipt: it admitted
 * `message_end`, so "Say OK." produced 39.8 KB carrying the injected system
 * reminders, the operator's prompt, and every thinking block.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { projectHeadlessJsonEvent } from "../../src/cli/modes/json-stream.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";

interface ProjectedMessage {
	role: string;
	content: Array<Record<string, unknown>>;
	[key: string]: unknown;
}

function project(event: unknown): Record<string, unknown> {
	return projectHeadlessJsonEvent(event as ChatLoopEvent) as Record<string, unknown>;
}

function assistantWith(content: unknown[]): Record<string, unknown> {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "llamacpp",
		model: "Qwen3.8-27B-IQ4_NL-262K",
		stopReason: "toolUse",
		usage: { input: 10227, output: 144, cacheRead: 0, cacheWrite: 0, totalTokens: 10371 },
		timestamp: 1787141932703,
	};
}

describe("contracts/cli headless json stream deduplication", () => {
	it("drops the assistant text a text_delta already carried, keeping its length", () => {
		const projected = project({
			type: "message_end",
			message: assistantWith([{ type: "text", text: "the whole answer" }]),
		});
		const message = projected.message as ProjectedMessage;
		const block = message.content[0];

		strictEqual(block?.type, "text");
		strictEqual("text" in (block ?? {}), false, "the streamed text must not cross the wire a second time");
		strictEqual(block?.streamed, true);
		strictEqual(block?.textLength, "the whole answer".length);
	});

	it("drops the assistant thinking a thinking_delta already carried, keeping its signature", () => {
		const projected = project({
			type: "message_end",
			message: assistantWith([
				{ type: "thinking", thinking: "let me work through this", thinkingSignature: "reasoning_content" },
			]),
		});
		const block = (projected.message as ProjectedMessage).content[0];

		strictEqual("thinking" in (block ?? {}), false);
		strictEqual(block?.streamed, true);
		strictEqual(block?.thinkingLength, "let me work through this".length);
		// The signature is not streamed and is needed for multi-turn continuity.
		strictEqual(block?.thinkingSignature, "reasoning_content");
	});

	it("keeps tool calls whole, because no delta ever carried them", () => {
		const call = { type: "toolCall", id: "QF03ucUxS1zX", name: "ls", arguments: { path: "src" } };
		const projected = project({ type: "message_end", message: assistantWith([call]) });

		deepStrictEqual((projected.message as ProjectedMessage).content[0], call);
	});

	it("keeps the message's accounting so a reader can still audit the turn", () => {
		const projected = project({
			type: "message_end",
			message: assistantWith([{ type: "text", text: "done" }]),
		});
		const message = projected.message as ProjectedMessage;

		strictEqual(message.role, "assistant");
		strictEqual(message.model, "Qwen3.8-27B-IQ4_NL-262K");
		strictEqual(message.stopReason, "toolUse");
		strictEqual((message.usage as Record<string, unknown>).totalTokens, 10371);
	});

	it("passes user and toolResult messages through whole, because nothing else carries them", () => {
		const user = {
			role: "user",
			content: [{ type: "text", text: "List the files, then say DONE." }],
			timestamp: 1787141932703,
		};
		const toolResult = {
			role: "toolResult",
			toolCallId: "QF03ucUxS1zX",
			toolName: "ls",
			content: [{ type: "text", text: "src\ntests\n" }],
			isError: false,
			timestamp: 1787141932999,
		};

		deepStrictEqual(project({ type: "message_end", message: user }).message as unknown, user);
		deepStrictEqual(project({ type: "message_end", message: toolResult }).message as unknown, toolResult);
	});

	it("applies the same projection to the turn_end assistant message", () => {
		const projected = project({
			type: "turn_end",
			message: assistantWith([{ type: "text", text: "final answer" }]),
			toolResults: [{ role: "toolResult", content: "10 MB of file text" }],
		});
		const block = (projected.message as ProjectedMessage).content[0];

		strictEqual("text" in (block ?? {}), false);
		strictEqual(block?.textLength, "final answer".length);
		strictEqual("toolResults" in projected, false, "tool results already crossed as tool_execution_end");
	});

	it("leaves a message with no content array alone", () => {
		// Failure messages the chat loop emits do not always carry a content array.
		const message = { role: "assistant", errorMessage: "target unreachable" };
		deepStrictEqual(project({ type: "message_end", message }).message as unknown, message);
	});

	it("still emits one increment per delta and no partial snapshot", () => {
		deepStrictEqual(project({ type: "text_delta", contentIndex: 0, delta: "wor", partialText: "hello wor" }), {
			type: "text_delta",
			contentIndex: 0,
			delta: "wor",
		});
		deepStrictEqual(project({ type: "thinking_delta", contentIndex: 1, delta: "hm", partialThinking: "let me hm" }), {
			type: "thinking_delta",
			contentIndex: 1,
			delta: "hm",
		});
		strictEqual(projectHeadlessJsonEvent({ type: "message_update" } as unknown as ChatLoopEvent), null);
	});

	it("never lets a streamed block and its delta both carry the same text", () => {
		// The invariant stated in docs/exit-codes-and-output.md, asserted directly:
		// reassemble one assistant message from its deltas and check the completed
		// frame adds no copy of what was reassembled.
		const chunks = ["Hel", "lo ", "world"];
		const deltas = chunks.map((delta, index) => project({ type: "text_delta", contentIndex: 0, delta, index }));
		const reassembled = deltas.map((frame) => frame.delta as string).join("");
		const completed = project({
			type: "message_end",
			message: assistantWith([{ type: "text", text: reassembled }]),
		});

		const serialized = JSON.stringify(completed);
		ok(!serialized.includes(reassembled), "the completed frame must not restate the reassembled text");
		strictEqual((completed.message as ProjectedMessage).content[0]?.textLength, reassembled.length);
	});
});
