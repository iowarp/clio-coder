import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { SkillActivation } from "../../src/core/skill-activation.js";
import type { SessionContract } from "../../src/domains/session/contract.js";
import { foldDispatchSkillActivations } from "../../src/entry/orchestrator.js";

function recordingSession(): { session: SessionContract; recorded: SkillActivation[] } {
	const recorded: SkillActivation[] = [];
	const session = {
		current: () => ({ id: "session-1" }),
		recordSkillActivation: (activation: SkillActivation) => {
			recorded.push(activation);
			return activation;
		},
	} as unknown as SessionContract;
	return { session, recorded };
}

const activation: SkillActivation = {
	name: "review",
	filePath: "/w/.clio-coder/skills/review/SKILL.md",
	hash: "a".repeat(64),
	source: "clio",
	sourceOrigin: "project",
	triggeredBy: "tool",
};

describe("contracts/dispatch skill activation folding", () => {
	it("records a failed run's activations, tagged with its runId", () => {
		const { session, recorded } = recordingSession();
		// The finalizer builds one payload and spreads it into whichever terminal
		// channel applies, so a failed run always carried these. Dropping them
		// left the operator unable to say which skill was loaded when it broke.
		strictEqual(foldDispatchSkillActivations(session, { runId: "run-9", skillActivations: [activation] }), 1);
		deepStrictEqual(recorded, [{ ...activation, runId: "run-9" }]);
	});

	it("folds nothing for a payload with no run to attribute to", () => {
		const { session, recorded } = recordingSession();
		strictEqual(foldDispatchSkillActivations(session, { skillActivations: [activation] }), 0);
		strictEqual(foldDispatchSkillActivations(session, undefined), 0);
		deepStrictEqual(recorded, []);
	});

	it("skips entries that are not activations rather than recording a shape nobody can read", () => {
		const { session, recorded } = recordingSession();
		strictEqual(
			foldDispatchSkillActivations(session, {
				runId: "run-9",
				skillActivations: [{ name: "half" }, null, activation],
			}),
			1,
		);
		strictEqual(recorded.length, 1);
	});
});
