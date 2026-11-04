import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { consultPoint } from "../../src/domains/system-one/points/index.js";
import { engineCapabilities, PROFILES } from "../../src/domains/system-one/profiles.js";
import { pointQuestion, yesNo } from "../../src/domains/system-one/questions.js";
import { createRunner, type RunnerRoute } from "../../src/domains/system-one/runner.js";
import type { EngineRequest } from "../../src/domains/system-one/types.js";

function routeAnswering(
	decide: (request: EngineRequest) => Promise<{ build: string; answers: Record<string, never> }>,
) {
	const profile = PROFILES["llm-structured"];
	return {
		name: "labels",
		digest: "labels",
		timeoutMs: 1_000,
		engine: {
			name: "labels",
			kind: "llm",
			profile: profile.id,
			destination: null,
			capabilities: engineCapabilities(profile, null),
			decide,
		},
	} as RunnerRoute;
}

const point = consultPoint({ a: pointQuestion(yesNo("Did the tests pass?", "They passed", "They did not")) });

test("an engine that decides nothing does not read as a route that failed", async () => {
	const reasons: string[] = [];
	const undecided = await createRunner({}).ask(
		[routeAnswering(async () => ({ build: "b", answers: {} }))],
		point,
		{ state: { note: "x" }, files: {} },
		{ onFailure: (reason) => reasons.push(reason) },
	);
	strictEqual(undecided, null);
	ok(reasons[0]?.includes("answered but decided nothing"), reasons[0]);

	const failures: string[] = [];
	await createRunner({}).ask(
		[
			routeAnswering(async () => {
				throw new Error("connection refused");
			}),
		],
		point,
		{ state: { note: "x" }, files: {} },
		{ onFailure: (reason) => failures.push(reason) },
	);
	ok(failures[0]?.includes("connection refused"), failures[0]);
});
