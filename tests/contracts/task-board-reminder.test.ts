import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	countEnumeratedSteps,
	createTaskBoardReminderRegistration,
	taskBoardReminderMessage,
} from "../../src/domains/middleware/task-board-reminder.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";

function turnStart(text: string, extras: Partial<MiddlewareHookInput> = {}): MiddlewareHookInput {
	return { hook: "turn_start", text, ...extras };
}

describe("contracts/task-board reminder step detection", () => {
	it("counts explicit numeric enumerations that start at 1", () => {
		strictEqual(countEnumeratedSteps("Make these changes: 1) add x; 2) add y; 3) update the README."), 3);
		strictEqual(countEnumeratedSteps("Step 1: build. Step 2: test. Step 3: ship. Step 4: tag."), 4);
		strictEqual(countEnumeratedSteps("do (1) this and (2) that and (3) also this"), 3);
	});

	it("never triggers on prose that merely mentions numbers or short enumerations", () => {
		strictEqual(countEnumeratedSteps("fix the bug in section 3.2 of the doc"), 0);
		strictEqual(countEnumeratedSteps("1) first thing 2) second thing"), 0);
		strictEqual(countEnumeratedSteps("the meeting is at 3: bring the notes"), 0);
		strictEqual(countEnumeratedSteps(""), 0);
		strictEqual(countEnumeratedSteps(undefined), 0);
	});

	it("counts three or more bulleted lines", () => {
		strictEqual(countEnumeratedSteps("please do:\n- add x\n- add y\n- update README"), 3);
		strictEqual(countEnumeratedSteps("just:\n- one bullet"), 0);
	});
});

describe("contracts/task-board reminder registration", () => {
	it("injects the board-first line once per session on the first enumerated turn", () => {
		const registration = createTaskBoardReminderRegistration();
		const first = registration.evaluate(turnStart("hello there"));
		deepStrictEqual(first, [], "non-enumerated turns never remind");

		const effects = registration.evaluate(turnStart("1) add x 2) add y 3) update README", { sessionId: "s1" }));
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect && effect.kind === "inject_reminder");
		ok(effect.kind === "inject_reminder" && effect.message === taskBoardReminderMessage(3));
		ok(effect.kind === "inject_reminder" && effect.message.includes('tasks action="plan"'));

		const again = registration.evaluate(turnStart("1) a 2) b 3) c", { sessionId: "s1" }));
		deepStrictEqual(again, [], "the reminder is once per session");
	});

	it("resets on a genuine session change and defers to a pending skill request", () => {
		const registration = createTaskBoardReminderRegistration();
		strictEqual(registration.evaluate(turnStart("1) a 2) b 3) c", { sessionId: "s1" })).length, 1);
		strictEqual(
			registration.evaluate(turnStart("1) a 2) b 3) c", { sessionId: "s2" })).length,
			1,
			"a new session gets its own shot",
		);

		const withSkill = createTaskBoardReminderRegistration();
		const effects = withSkill.evaluate(
			turnStart("1) a 2) b 3) c", { sessionId: "s3", metadata: { pendingSkillRequests: 1 } }),
		);
		deepStrictEqual(effects, [], "an operator-chosen skill turn is not competed with");
	});
});
