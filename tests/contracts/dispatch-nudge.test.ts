import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	createReadOnlyExplorationNudgeRegistration,
	READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD,
	READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
} from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";

function beforeTool(turnId: string, toolName: string, toolArgs?: Record<string, unknown>): MiddlewareHookInput {
	return { hook: "before_tool", turnId, toolName, ...(toolArgs ? { toolArgs } : {}) };
}

function turnEnd(turnId: string, activeToolNames = "read,grep,find,ls,bash,dispatch"): MiddlewareHookInput {
	return { hook: "turn_end", turnId, metadata: { stopReason: "stop", activeToolNames } };
}

function crossThreshold(
	turnId: string,
	registration: ReturnType<typeof createReadOnlyExplorationNudgeRegistration>,
): void {
	for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD; call += 1) {
		const input =
			call % 2 === 0
				? beforeTool(turnId, ToolNames.Read)
				: beforeTool(turnId, ToolNames.Bash, { command: "wc -l src/index.ts" });
		deepStrictEqual(registration.evaluate(input), []);
	}
}

describe("contracts/read-only exploration dispatch nudge", () => {
	it("fires once after the named read-only call threshold without dispatch", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		strictEqual(registration.id, READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID);
		crossThreshold("turn-fire", registration);

		const effects = registration.evaluate(turnEnd("turn-fire"));
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["request_continuation", "inject_reminder"],
		);
		const continuation = effects[0];
		ok(continuation?.kind === "request_continuation");
		match(continuation.message, /read-only exploration calls without dispatch/);
		match(continuation.message, /scout/);

		deepStrictEqual(registration.evaluate(turnEnd("turn-fire")), [], "same turn cannot nudge twice");
	});

	it("suppresses below-threshold turns, turns that dispatched, and surfaces without dispatch", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD - 1; call += 1) {
			registration.evaluate(beforeTool("turn-short", ToolNames.Ls));
		}
		deepStrictEqual(registration.evaluate(turnEnd("turn-short")), []);

		crossThreshold("turn-dispatched", registration);
		registration.evaluate(beforeTool("turn-dispatched", ToolNames.Dispatch, { list: true }));
		deepStrictEqual(registration.evaluate(turnEnd("turn-dispatched")), []);

		crossThreshold("turn-no-surface", registration);
		deepStrictEqual(registration.evaluate(turnEnd("turn-no-surface", "read,grep,find,ls,bash")), []);
		crossThreshold("turn-unknown-surface", registration);
		deepStrictEqual(
			registration.evaluate({ hook: "turn_end", turnId: "turn-unknown-surface", metadata: { stopReason: "stop" } }),
			[],
		);
	});

	it("does not count execution-shaped bash commands as read-only exploration", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD + 2; call += 1) {
			registration.evaluate(beforeTool("turn-build", ToolNames.Bash, { command: "npm run build" }));
		}
		deepStrictEqual(registration.evaluate(turnEnd("turn-build")), []);
	});
});
