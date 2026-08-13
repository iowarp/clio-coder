/**
 * A cancelled turn persisted 2,875 characters of streamed assistant text with
 * `usage.totalTokens: 0` and no `reasoning` key, while the turn before it
 * recorded `output: 171` for 170 characters. The stream initializes a usage
 * object and only fills it from the provider's final chunk, so an interrupted
 * call kept the initialized zeros. The prompt was spent the moment the request
 * went out, and the streamed text is on disk to be counted, so the record now
 * says what the call is known to have cost and marks it an estimate.
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { SessionContract, TurnInput } from "../../src/domains/session/contract.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { estimatedUsageForInterruptedTurn } from "../../src/interactive/chat-loop-messages.js";
import { createTurnPersistence } from "../../src/interactive/turn-persistence.js";
import { createTurnState } from "../../src/interactive/turn-state.js";

const STREAMED = "# Parallel File Systems\n".repeat(40);

function abortedMessage(text: string, usage?: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "aborted",
		errorMessage: "Request was aborted.",
		timestamp: Date.now(),
		...(usage !== undefined ? { usage } : {}),
	} as unknown as AgentMessage;
}

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const COMPLETED_USAGE_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens", "cost"];

describe("contracts/cancelled turn usage", () => {
	it("records the prompt side and the streamed output instead of zeros", () => {
		const usage = estimatedUsageForInterruptedTurn(abortedMessage(STREAMED, ZERO_USAGE), 9658);
		ok(usage, "an interrupted turn with streamed text gets usage");
		strictEqual(usage.input, 9658, "the prompt was spent whatever the operator did with Esc");
		ok(typeof usage.output === "number" && usage.output > 0, `streamed text is output: ${usage.output}`);
		ok(typeof usage.totalTokens === "number" && usage.totalTokens > 9658);
		strictEqual(usage.estimated, true, "and it is labelled an estimate, not a provider report");
	});

	it("keeps the record shape a completed turn uses, including the reasoning key", () => {
		const usage = estimatedUsageForInterruptedTurn(abortedMessage(STREAMED, ZERO_USAGE), 100);
		ok(usage);
		for (const key of COMPLETED_USAGE_KEYS) {
			ok(key in usage, `completed turns carry ${key}; the cancelled record dropped it`);
		}
	});

	it("leaves provider-reported usage alone", () => {
		const reported = { ...ZERO_USAGE, input: 500, output: 3, totalTokens: 503 };
		strictEqual(estimatedUsageForInterruptedTurn(abortedMessage("ALPHA", reported), 9658), null);
	});

	it("does not touch a turn that finished", () => {
		const finished = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			stopReason: "stop",
			usage: ZERO_USAGE,
			timestamp: Date.now(),
		} as unknown as AgentMessage;
		strictEqual(estimatedUsageForInterruptedTurn(finished, 9658), null);
	});

	it("records nothing when nothing streamed and no prompt size is known", () => {
		strictEqual(estimatedUsageForInterruptedTurn(abortedMessage("", ZERO_USAGE), 0), null);
	});

	it("writes the estimate into the persisted assistant payload", () => {
		const appended: TurnInput[] = [];
		const session = {
			current: () => ({ id: "s1" }),
			append: (turn: TurnInput) => {
				appended.push(turn);
				return { id: `t${appended.length}` };
			},
		} as unknown as SessionContract;
		const persistence = createTurnPersistence({
			state: createTurnState("off"),
			session,
			getSettings: () => DEFAULT_SETTINGS as ClioSettings,
			middlewareToolChoice: { reset: () => {} } as never,
			consumePersistedEcho: () => false,
			removeQueuedMirrorEntry: () => {},
			promptCachePayloadForAssistant: () => ({}),
			promptSideTokens: () => 9658,
		});

		persistence.appendAssistantTurn(abortedMessage(STREAMED, ZERO_USAGE));

		strictEqual(appended.length, 1);
		const payload = appended[0]?.payload as { usage?: Record<string, unknown> };
		deepStrictEqual(payload.usage?.input, 9658, "the persisted record carries the prompt tokens");
		ok((payload.usage?.totalTokens as number) > 0, "and a non-zero total beside the streamed text");
	});
});
