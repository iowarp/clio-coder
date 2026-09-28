import { deepStrictEqual } from "node:assert/strict";
import { it } from "node:test";
import { CI_DISPUTE_REMINDER, createCiDisputeRegistration } from "../../src/domains/middleware/ci-dispute.js";

it("reminds the model to inspect CI evidence for a disputed test claim", () => {
	const registration = createCiDisputeRegistration();
	deepStrictEqual(
		registration.evaluate({ hook: "turn_start", text: "You told me tests passed but CI is red. What gives?" }),
		[{ kind: "inject_reminder", message: CI_DISPUTE_REMINDER }],
	);
	deepStrictEqual(registration.evaluate({ hook: "turn_start", text: "Run local tests" }), []);
	deepStrictEqual(
		registration.evaluate({
			hook: "turn_start",
			text: "You told me tests passed but CI is red. What gives?",
			metadata: { requestContinuation: true },
		}),
		[],
	);
});
