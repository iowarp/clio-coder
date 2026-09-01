import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { serializeConversation } from "../../src/domains/session/compaction/branch-summary.js";
import { estimateTokens } from "../../src/domains/session/compaction/tokens.js";
import type { BashExecutionEntry } from "../../src/domains/session/entries.js";
import { buildReplayAgentMessagesFromTurns } from "../../src/interactive/chat-renderer.js";

function bashEntry(
	id: string,
	command: string,
	output: string,
	excludeFromContext: boolean,
	parentTurnId: string | null,
): BashExecutionEntry {
	return {
		kind: "bashExecution",
		turnId: id,
		parentTurnId,
		timestamp: `2026-06-08T00:00:${id}.000Z`,
		command,
		output,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext,
	};
}

function messageText(messages: ReadonlyArray<unknown>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const content = (message as { content?: unknown }).content;
		if (typeof content === "string") parts.push(content);
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
				parts.push((block as { text: string }).text);
			}
		}
	}
	return parts.join("\n");
}

describe("operator-private provider context boundary", () => {
	it("keeps !! command and output bytes out of replay, compaction, and accounting", () => {
		const visible = bashEntry("01", "printf visible-command", "visible-output", false, null);
		const privateEntry = bashEntry("02", "printf operator-private-command", "operator-private-output", true, "01");
		const entries = [visible, privateEntry];

		const replay = messageText(buildReplayAgentMessagesFromTurns(entries));
		const compaction = serializeConversation(entries);
		for (const providerInput of [replay, compaction]) {
			ok(providerInput.includes(visible.command));
			ok(providerInput.includes(visible.output));
			strictEqual(providerInput.includes(privateEntry.command), false);
			strictEqual(providerInput.includes(privateEntry.output), false);
		}
		ok(estimateTokens(visible) > 0);
		strictEqual(estimateTokens(privateEntry), 0);
	});
});
