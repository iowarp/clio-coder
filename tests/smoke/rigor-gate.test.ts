import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import {
	createFinishContractRegistration,
	HIGH_RIGOR_REVALIDATION_MESSAGE,
} from "../../src/domains/safety/finish-contract-registration.js";

/**
 * Slice 4 end-to-end shape: a high-rigor turn that claims done with no
 * validation evidence is re-prompted (a request_continuation withholds the
 * completion), and once the session carries a passing validation command the
 * same evaluation settles cleanly with no gate effect. The session-entry shapes
 * mirror those the finish-contract unit/contract tests use (tool_call +
 * successful tool_result, plus a leading user prompt).
 */

const ASSISTANT_CLAIM = "Done. Implemented the parser and tests pass.";

function turnEndInput(): MiddlewareHookInput {
	return {
		hook: "turn_end",
		turnId: "turn-2",
		text: ASSISTANT_CLAIM,
		metadata: { stopReason: "stop" },
	};
}

function userPromptEntry(): unknown {
	return { kind: "message", role: "user", turnId: "turn-1", payload: { text: "implement the parser" } };
}

function validationEntries(): ReadonlyArray<unknown> {
	return [
		userPromptEntry(),
		{
			kind: "message",
			role: "tool_call",
			turnId: "turn-1",
			payload: { name: "bash", toolCallId: "call-1", args: { command: "npm run test:contracts" } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "turn-1",
			payload: { toolName: "bash", toolCallId: "call-1", result: { details: { exitCode: 0 } } },
		},
	];
}

function find(effects: ReadonlyArray<MiddlewareEffect>, kind: MiddlewareEffect["kind"]): MiddlewareEffect | undefined {
	return effects.find((effect) => effect.kind === kind);
}

describe("smoke/rigor-gate high-rigor finish gate", () => {
	it("re-prompts an unvalidated high-rigor completion claim, then settles after validation runs", () => {
		// No evidence in the session: the high-rigor gate withholds completion.
		let entries: ReadonlyArray<unknown> = [userPromptEntry()];
		const registration = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
		});

		const gated = registration.evaluate(turnEndInput());
		const continuation = find(gated, "request_continuation");
		ok(continuation, "an unvalidated high-rigor claim must be re-prompted via request_continuation");
		ok(continuation?.kind === "request_continuation" && continuation.message === HIGH_RIGOR_REVALIDATION_MESSAGE);
		ok(find(gated, "inject_reminder"), "the directive also lands as a reminder line");

		// The model runs validation; assessFinishContract now finds evidence and
		// returns ok, so the same evaluation settles with no gate effect.
		entries = validationEntries();
		const settled = registration.evaluate(turnEndInput());
		strictEqual(settled.length, 0, "a validated claim settles cleanly with no gate effect");
	});
});
