import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import {
	createFinishContractRegistration,
	HIGH_RIGOR_REVALIDATION_MESSAGE,
} from "../../src/domains/safety/finish-contract-registration.js";

/**
 * End-to-end shape of the action-scoped gate: a high-rigor turn that MUTATED a
 * file and then claimed done with no validation evidence is re-prompted (a
 * request_continuation withholds the completion), and once the session carries a
 * passing validation command for that same mutation the evaluation settles
 * cleanly with no gate effect. The session-entry shapes mirror those the
 * finish-contract unit/contract tests use (tool_call + successful tool_result,
 * plus a leading user prompt).
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

/** A successful edit receipt: the mutation that arms the contract. */
function mutationEntries(): ReadonlyArray<unknown> {
	return [
		{
			kind: "message",
			role: "tool_call",
			turnId: "turn-1",
			payload: { name: "edit", toolCallId: "edit-1", args: { path: "src/parser.ts" } },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "turn-1",
			payload: { toolName: "edit", toolCallId: "edit-1", isError: false, result: { kind: "ok" } },
		},
	];
}

/** A passing validation command for the mutation above. */
function validationEntries(): ReadonlyArray<unknown> {
	return [
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
	it("re-prompts an unvalidated high-rigor mutation, then settles after validation runs", () => {
		// The turn changed a file but recorded no validation: the high-rigor gate
		// withholds completion.
		let entries: ReadonlyArray<unknown> = [userPromptEntry(), ...mutationEntries()];
		const registration = createFinishContractRegistration({
			readSessionEntries: () => entries,
			resolveRigor: () => "high",
		});

		const gated = registration.evaluate(turnEndInput());
		const continuation = find(gated, "request_continuation");
		ok(continuation, "an unvalidated high-rigor mutation must be re-prompted via request_continuation");
		ok(continuation?.kind === "request_continuation" && continuation.message === HIGH_RIGOR_REVALIDATION_MESSAGE);
		ok(find(gated, "inject_reminder"), "the directive also lands as a reminder line");

		// The model runs validation; assessFinishContract now finds evidence for
		// the same mutation and returns ok, so the evaluation settles cleanly.
		entries = [userPromptEntry(), ...mutationEntries(), ...validationEntries()];
		const settled = registration.evaluate(turnEndInput());
		strictEqual(settled.length, 0, "a validated mutation settles cleanly with no gate effect");
	});
});
