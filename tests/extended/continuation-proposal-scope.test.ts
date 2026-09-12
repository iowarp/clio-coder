import { match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILL_SUGGESTION_PREFIX } from "../../src/core/skill-activation.js";
import {
	isSkillSuggestionWait,
	SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE,
	STALLED_TURN_REQUEST_CONTINUATION_MESSAGE,
	STALLED_TURN_RULE_DEFINITION,
	shouldRequestStalledTurnContinuation,
} from "../../src/domains/middleware/stalled-turn.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";

/**
 * Issue #365: a proposal-only turn that ends by handing the operator the
 * decision must not be carried onward by an automatic continuation. The
 * stalled-turn rule and the skill-suggestion wait are continuation
 * heuristics over the final sentence; they are not an authorization engine.
 * These contracts pin the deferral exclusions and, just as importantly, the
 * affirmative unfinished announcements that must keep continuing.
 */

function textTurnEnd(finalSentence: string): MiddlewareHookInput {
	return {
		hook: "turn_end",
		text: `Outline of the public seam.\n\n${finalSentence}`,
		metadata: { stopReason: "stop", turnToolCalls: 0 },
	};
}

const OPERATOR_DEFERRALS = [
	'Say "go" and I\'ll start t1.',
	"Reply go and I'll write clamp.py and test_clamp.py.",
	"Confirm and I will create battletest-output/s9-skill/clamp.py.",
	"Approve this plan and I'll implement clamp_nonnegative in clamp.py.",
	"Awaiting your go-ahead; I'll then write test_clamp.py first.",
	"Pending your decision, I'll add the red test to test_clamp.py.",
	"Once approved, I'll write clamp.py.",
	"I'll wait for your go-ahead before I write clamp.py.",
	"Give the word and I'll implement the seam.",
	"Nothing is implemented yet; I'll write test_clamp.py after you approve.",
	"I'll create clamp.py upon your approval.",
	"I'll run pytest on the slice as soon as you confirm the seam.",
	"Not implementing yet per your instruction; next I would create clamp.py.",
	"I will not edit files; I'll explain how to apply the convention in tests/test_coefs.py.",
];

const AFFIRMATIVE_ANNOUNCEMENTS = [
	"I'll run npm test now.",
	"Let me read src/cli/index.ts.",
	"Now I will edit clamp.py to add the guard.",
	"Next I'll create battletest-output/s9-skill/test_clamp.py and run pytest.",
	"I'll add the test once package.json is updated.",
	"I'll fix the import if the config is valid.",
	"I'm going to grep for the symbol:",
	"Let me check the failing assertion in tests/test_coefs.py.",
];

describe("continuation heuristics preserve proposal-only scope (#365)", () => {
	it("does not carry a turn onward when its final sentence defers to an operator decision", () => {
		for (const sentence of OPERATOR_DEFERRALS) {
			strictEqual(shouldRequestStalledTurnContinuation(textTurnEnd(sentence)), false, sentence);
			strictEqual(STALLED_TURN_RULE_DEFINITION.predicate?.(textTurnEnd(sentence)), false, sentence);
		}
	});

	it("still carries an affirmative unfinished announcement onward", () => {
		for (const sentence of AFFIRMATIVE_ANNOUNCEMENTS) {
			strictEqual(shouldRequestStalledTurnContinuation(textTurnEnd(sentence)), true, sentence);
		}
		strictEqual(STALLED_TURN_RULE_DEFINITION.effects[0]?.kind, "request_continuation");
		match(STALLED_TURN_REQUEST_CONTINUATION_MESSAGE, /waiting for the user/);
	});

	it("never fires once a tool ran or the turn did not stop normally, whatever the sentence says", () => {
		const announcement = AFFIRMATIVE_ANNOUNCEMENTS[0] ?? "";
		strictEqual(
			shouldRequestStalledTurnContinuation({
				...textTurnEnd(announcement),
				metadata: { stopReason: "stop", turnToolCalls: 2 },
			}),
			false,
		);
		strictEqual(
			shouldRequestStalledTurnContinuation({
				...textTurnEnd(announcement),
				metadata: { stopReason: "aborted", turnToolCalls: 0 },
			}),
			false,
		);
	});

	it("keeps the skill-suggestion wait continuation but tells the model it answers only the skill choice", () => {
		const input: MiddlewareHookInput = {
			hook: "turn_end",
			text:
				`${SKILL_SUGGESTION_PREFIX}tdd\n\n` +
				"Seam: clamp_nonnegative(value: int) -> int in battletest-output/s9-skill/clamp.py.\n\n" +
				"Nothing is written yet, per your instruction. Should I implement the red/green slice now?",
			metadata: { stopReason: "stop", turnToolCalls: 1, turnToolNames: "context" },
		};
		// The predicate is unchanged: the listing-only suggestion turn still
		// continues, which is the #184 behavior.
		strictEqual(isSkillSuggestionWait(input), true);
		strictEqual(
			isSkillSuggestionWait({ ...input, metadata: { ...input.metadata, turnToolNames: "context,write" } }),
			false,
		);
		// The message may no longer claim the operator owes nothing at all.
		strictEqual(SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE.includes("nothing is needed from them"), false);
		match(SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE, /already-authorized task/);
		match(SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE, /not an operator answer to any other question/);
		match(SKILL_SUGGESTION_WAIT_CONTINUATION_MESSAGE, /awaiting an explicit operator go-ahead, park it/);
	});
});
