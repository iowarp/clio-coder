import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyAgentTask } from "../../src/domains/dispatch/agent-candidates.js";
import { classifyAgentTaskWithDecider } from "../../src/domains/dispatch/agent-task-decisions.js";
import type { Decider } from "../../src/domains/providers/decisions.js";
import type { DecisionAnswer } from "../../src/domains/providers/types/inference.js";

/**
 * The task the live provider was validated against. Its regex classification is
 * wrong in two fields, which is the whole reason the site exists.
 */
const TASK = "Review the auth middleware for timing attacks, then fix anything you find and add regression tests";

/** Recorded verbatim from api.typesafe.ai for TASK, so the mapping is pinned to real output. */
const LIVE_ANSWERS: Record<string, DecisionAnswer> = {
	taskType: {
		type: "choice",
		choice: "code_review",
		confidence: 0.84,
		probabilities: { code_review: 0.87, debug: 0.13, code_write: 0, test: 0 },
	},
	domain: { type: "choice", choice: "security", confidence: 1, probabilities: { security: 1, backend: 0 } },
	complexity: {
		type: "score",
		score: 1.86,
		confidence: 0.71,
		legend: {
			"0": "A single obvious edit",
			"1": "A contained change in one place",
			"2": "A change spanning several places",
			"3": "A large change needing its own plan",
		},
		probabilities: { "0": 0.01, "1": 0.2, "2": 0.72, "3": 0.07 },
	},
	decomposable: { type: "noul", noul: 0.81 },
};

function deciderReturning(answers: Record<string, DecisionAnswer>): Decider {
	return {
		ask: async () => answers,
		askDetailed: async () => ({ model: "jev-1.13.0", answers }),
	};
}

function deciderThrowing(error: Error): Decider {
	return {
		ask: async () => {
			throw error;
		},
		askDetailed: async () => {
			throw error;
		},
	};
}

describe("routing task classification", () => {
	it("is exactly the regex classifier when the site is unbound", async () => {
		deepStrictEqual(await classifyAgentTaskWithDecider(TASK, null), classifyAgentTask(TASK));
	});

	// The two fields the word-count and conjunction rules get wrong on this
	// task. Sixteen words with no enumerated list reads as one simple edit; it
	// is neither.
	it("corrects the fields the regex rules miss", async () => {
		const regex = classifyAgentTask(TASK);
		strictEqual(regex.complexity, "simple");
		strictEqual(regex.decomposable, false);

		const features = await classifyAgentTaskWithDecider(TASK, deciderReturning(LIVE_ANSWERS));
		strictEqual(features.complexity, "moderate");
		strictEqual(features.decomposable, true);
		strictEqual(features.taskType, "code_review");
		strictEqual(features.domain, "security");
	});

	// The regex reports 0.3 or 0.7 depending only on whether its first rule
	// matched. That is a placeholder, and routing keys off it.
	it("reports the model's measured certainty instead of the constant", async () => {
		strictEqual(classifyAgentTask(TASK).confidence, 0.7);
		const features = await classifyAgentTaskWithDecider(TASK, deciderReturning(LIVE_ANSWERS));
		strictEqual(features.confidence, 0.84);
	});

	// An abstention on one question must not discard a confident answer on
	// another, or one uncertain field would cost the whole call.
	it("falls back per field rather than wholesale", async () => {
		const features = await classifyAgentTaskWithDecider(
			TASK,
			deciderReturning({
				...LIVE_ANSWERS,
				complexity: { type: "score", score: 1.86, confidence: 0.1 },
			}),
		);
		strictEqual(features.complexity, classifyAgentTask(TASK).complexity);
		strictEqual(features.domain, "security");
		strictEqual(features.taskType, "code_review");
	});

	// A provider outage must leave routing exactly as it was before the site
	// existed, and must say so rather than failing silently.
	it("returns the regex classification when the provider fails", async () => {
		const seen: unknown[] = [];
		const features = await classifyAgentTaskWithDecider(TASK, deciderThrowing(new Error("HTTP 503")), {
			onError: (error) => seen.push(error),
		});
		deepStrictEqual(features, classifyAgentTask(TASK));
		strictEqual((seen[0] as Error).message, "HTTP 503");
	});

	// The model is constrained to the option keys it was given, so a value
	// outside them means the answer was not the shape it claimed.
	it("treats an off-enum answer as an abstention", async () => {
		const features = await classifyAgentTaskWithDecider(
			TASK,
			deciderReturning({
				...LIVE_ANSWERS,
				taskType: { type: "choice", choice: "vibes", confidence: 1, probabilities: { vibes: 1 } },
			}),
		);
		strictEqual(features.taskType, classifyAgentTask(TASK).taskType);
		strictEqual(features.confidence, classifyAgentTask(TASK).confidence);
	});

	it("collapses the subtask estimate when the work is one piece", async () => {
		const task = "Fix the typo in the README and also update the version and also bump the lockfile";
		strictEqual(classifyAgentTask(task).estimatedSubtasks > 1, true);
		const features = await classifyAgentTaskWithDecider(
			task,
			deciderReturning({ ...LIVE_ANSWERS, decomposable: { type: "noul", noul: 0.02 } }),
		);
		strictEqual(features.decomposable, false);
		strictEqual(features.estimatedSubtasks, 1);
	});

	// The ladder answer sits between rungs, which is more information than the
	// enum holds. Rounding is the lossy step and it must land on a real rung.
	it("rounds a between-rung score onto the ladder", async () => {
		const rungs = await Promise.all(
			[0.4, 0.6, 2.5, 9].map(async (score) => {
				const features = await classifyAgentTaskWithDecider(
					TASK,
					deciderReturning({ ...LIVE_ANSWERS, complexity: { type: "score", score, confidence: 0.9 } }),
				);
				return features.complexity;
			}),
		);
		deepStrictEqual(rungs, ["trivial", "simple", "complex", "complex"]);
	});

	it("bounds the evidence it sends", async () => {
		let sentTask = "";
		const decider: Decider = {
			ask: async (state) => {
				sentTask = (state as { task: string }).task;
				return LIVE_ANSWERS;
			},
			askDetailed: async () => ({ model: "jev-1.13.0", answers: LIVE_ANSWERS }),
		};
		await classifyAgentTaskWithDecider("x".repeat(9000), decider);
		strictEqual(sentTask.length, 4000);
	});
});
