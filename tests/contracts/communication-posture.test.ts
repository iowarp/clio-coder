import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { createCommunicationPostureRegistration } from "../../src/domains/middleware/communication-posture.js";
import {
	loadCommunicationPostures,
	selectCommunicationPosture,
} from "../../src/domains/prompts/communication-posture.js";

describe("per-turn communication posture", () => {
	it("selects recovery before rigor and suppresses hints on continuations or exact output", () => {
		const base = {
			operatorText: "quick answer?",
			continuation: false,
			recentToolFailures: 0,
			highRigor: false,
			testsFirst: false,
		};
		strictEqual(selectCommunicationPosture(base), "quick");
		strictEqual(selectCommunicationPosture({ ...base, highRigor: true }), "rigorous");
		strictEqual(selectCommunicationPosture({ ...base, highRigor: true, recentToolFailures: 2 }), "recovery");
		strictEqual(selectCommunicationPosture({ ...base, continuation: true }), null);
		strictEqual(selectCommunicationPosture({ ...base, operatorText: '{"answer":true}' }), null);
	});

	it("injects one source-controlled line after repeated tool failures", () => {
		const fragments = loadCommunicationPostures();
		const registration = createCommunicationPostureRegistration({
			fragments,
			highRigor: () => false,
			testsFirst: () => false,
		});
		for (let i = 0; i < 2; i += 1) {
			deepStrictEqual(registration.evaluate({ hook: "after_tool", metadata: { resultKind: "error" } }), []);
		}
		const effects = registration.evaluate({ hook: "turn_start", text: "continue with the task" });
		deepStrictEqual(effects, [{ kind: "inject_reminder", message: `[Communication] ${fragments.recovery}` }]);
		strictEqual((effects[0] as { message: string }).message.split("\n").length, 1);
		deepStrictEqual(registration.evaluate({ hook: "turn_start", text: "continue with the task" }), []);
	});
});
