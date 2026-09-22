import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import type { Decider } from "../../src/domains/providers/decisions.js";
import type { DecisionAnswer, DecisionQuestion } from "../../src/domains/providers/types/inference.js";
import { describeToolRisk, TOOL_RISK_LADDER, toolRiskAdvisoryLine } from "../../src/domains/safety/tool-risk.js";

interface Sent {
	state: unknown;
	questions: Record<string, DecisionQuestion>;
}

function deciderReturning(answers: Record<string, DecisionAnswer> | Error, sent?: Sent[]): Decider {
	return {
		async ask(state, questions) {
			sent?.push({ state, questions });
			if (answers instanceof Error) throw answers;
			return answers;
		},
		askDetailed: async () => {
			throw new Error("unused");
		},
	};
}

const subject = { tool: "bash", actionClass: "execute", target: "rm -rf build/" };

describe("toolRisk advisory", () => {
	it("rates a call on the blast-radius ladder in one call", async () => {
		const sent: Sent[] = [];
		const advisory = await describeToolRisk(
			deciderReturning(
				{
					radius: { type: "score", score: 2.1, confidence: 0.8 },
					outside: { type: "noul", noul: 0.9 },
				},
				sent,
			),
			subject,
			"jev/jev-latest",
		);
		strictEqual(advisory?.score, 2.1);
		strictEqual(advisory?.label, "broad");
		strictEqual(advisory?.reachesOutsideWorkspace, true);
		strictEqual(sent.length, 1);
		deepStrictEqual(Object.keys(sent[0]?.questions ?? {}).sort(), ["outside", "radius"]);
	});

	// The card is what the operator reads while deciding, so the sentence has to
	// say it is advisory before it says anything else.
	it("says it is advisory before it says the rating", async () => {
		const line = toolRiskAdvisoryLine({
			score: 2.1,
			label: "broad",
			reachesOutsideWorkspace: true,
			source: "jev/jev-latest",
		});
		match(line, /^Advisory only, nothing below is gated on it/);
		ok(line.includes("broad"));
		ok(line.includes("reaches outside the workspace"));
		ok(line.includes("jev/jev-latest"));
	});

	it("renders nothing at all when there is no advisory", () => {
		strictEqual(toolRiskAdvisoryLine(null), "");
	});

	// A Jev outage must never delay or block an approval. Every failure is the
	// same silence the card has always shown.
	it("returns null when the call throws", async () => {
		strictEqual(await describeToolRisk(deciderReturning(new Error("ECONNREFUSED")), subject, "jev"), null);
	});

	it("returns null when the rating abstains", async () => {
		const advisory = await describeToolRisk(
			deciderReturning({
				radius: { type: "score", score: 1.5, confidence: 0.05 },
				outside: { type: "noul", noul: 0.9 },
			}),
			subject,
			"jev",
		);
		strictEqual(advisory, null);
	});

	// Reach abstains independently of the rating. An undecided reach is not a
	// claim that the call stays inside the workspace.
	it("keeps the rating when only the reach question abstains", async () => {
		const advisory = await describeToolRisk(
			deciderReturning({
				radius: { type: "score", score: 0.2, confidence: 0.9 },
				outside: { type: "noul", noul: 0.51 },
			}),
			subject,
			"jev",
		);
		strictEqual(advisory?.label, "contained");
		strictEqual(advisory?.reachesOutsideWorkspace, null);
		const line = toolRiskAdvisoryLine(advisory);
		strictEqual(line.includes("workspace"), false);
	});

	it("returns null when the answer is the wrong shape", async () => {
		strictEqual(
			await describeToolRisk(
				deciderReturning({ radius: { type: "noul", noul: 0.9 }, outside: { type: "noul", noul: 0.9 } }),
				subject,
				"jev",
			),
			null,
		);
	});

	// Raw arguments carry mutation text and unsanitized command strings. Only the
	// allowlisted, redacted target the operator is already looking at is sent.
	it("sends the tool, action and sanitized target and nothing else", async () => {
		const sent: Sent[] = [];
		await describeToolRisk(
			deciderReturning(
				{ radius: { type: "score", score: 1, confidence: 0.9 }, outside: { type: "noul", noul: 0.1 } },
				sent,
			),
			subject,
			"jev",
		);
		deepStrictEqual(sent[0]?.state, { tool: "bash", action: "execute", target: "rm -rf build/" });
	});

	it("names every rung with what the call does rather than a severity word", () => {
		strictEqual(TOOL_RISK_LADDER.length, 4);
		for (const rung of TOOL_RISK_LADDER) ok(rung.length > 20);
	});

	it("clamps a rating that lands off the ladder", async () => {
		for (const [score, label] of [
			[-4, "contained"],
			[9, "irreversible"],
		] as const) {
			const advisory = await describeToolRisk(
				deciderReturning({
					radius: { type: "score", score, confidence: 0.9 },
					outside: { type: "noul", noul: 0.9 },
				}),
				subject,
				"jev",
			);
			strictEqual(advisory?.label, label);
		}
	});
});
