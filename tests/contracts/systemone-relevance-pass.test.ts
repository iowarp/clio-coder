import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { scoreTurnRelevance } from "../../src/domains/providers/relevance-pass.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import type { DecideOptions, DecideResult, DecisionAnswer } from "../../src/domains/providers/types/inference.js";
import type { ProbeContext, RuntimeDescriptor } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 5000 };

interface Capture {
	calls: Array<{ target: string; state: unknown; questionIds: string[] }>;
}

/**
 * The real Jev descriptor with its transport swapped for `reply`, behind the
 * real target and runtime lookups. Resolution applies eligibility rules a
 * hand-rolled descriptor would skip, so the pass is exercised through the same
 * path production takes.
 */
function providersWith(
	capture: Capture,
	reply: (ids: string[]) => Record<string, DecisionAnswer> | Error,
): ProvidersContract {
	const runtime: RuntimeDescriptor = {
		...typesafeJev,
		async decide(target: TargetDescriptor, opts: DecideOptions): Promise<DecideResult> {
			const questionIds = Object.keys(opts.questions);
			capture.calls.push({ target: target.id, state: opts.state, questionIds });
			const answers = reply(questionIds);
			if (answers instanceof Error) throw answers;
			return { model: opts.model ?? "jev-1.13.0", answers };
		},
	};
	return {
		getTarget: (targetId: string): TargetDescriptor | null =>
			targetId === "jev" || targetId === "jev2"
				? { id: targetId, runtime: "typesafe-jev", defaultModel: "jev-latest" }
				: null,
		getRuntime: (runtimeId: string) => (runtimeId === "typesafe-jev" ? runtime : null),
		getDetectedReasoning: () => undefined,
		knowledgeBase: undefined,
		list: () => [],
	} as unknown as ProvidersContract;
}

function settingsFor(decisionProfiles: Record<string, string>, profiles?: Record<string, unknown>) {
	return validateSettings({
		targets: [
			{ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" },
			{ id: "jev2", runtime: "typesafe-jev", defaultModel: "jev-preview" },
		],
		fleet: {
			profiles: profiles ?? { "system-one": { target: "jev", model: "jev-latest" } },
			decisionProfiles,
		},
	}).settings;
}

const request = {
	task: "rank memory records by relevance",
	memory: [
		{ id: "m1", summary: "Compaction must retain evidence references." },
		{ id: "m2", summary: "A linter accepts this formatting." },
	],
	skills: [{ id: "run", summary: "run: launch the project's app" }],
};

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });

describe("pre-turn relevance pass", () => {
	// Questions are independent, so a batch costs one round trip. Both sites
	// naming the same profile must therefore travel in one request.
	it("asks both sites in a single decide call", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one", skills: "system-one" }),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.9)]))),
				ctx,
			},
			request,
		);
		strictEqual(capture.calls.length, 1);
		deepStrictEqual(capture.calls[0]?.questionIds.sort(), ["memory.m1", "memory.m2", "skills.run"]);
		deepStrictEqual(result.memory?.scores, { m1: 0.9, m2: 0.9 });
		deepStrictEqual(result.skills?.scores, { run: 0.9 });
	});

	// Sites are separately bindable, so a settings file pointing them at
	// different targets must not batch half its questions to the wrong model.
	it("splits the batch when the sites name different targets", async () => {
		const capture: Capture = { calls: [] };
		await scoreTurnRelevance(
			{
				settings: settingsFor(
					{ memory: "one", skills: "two" },
					{ one: { target: "jev", model: "jev-latest" }, two: { target: "jev2", model: "jev-preview" } },
				),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.8)]))),
				ctx,
			},
			request,
		);
		strictEqual(capture.calls.length, 2);
		const byTarget = new Map(capture.calls.map((call) => [call.target, call.questionIds.sort()]));
		deepStrictEqual(byTarget.get("jev"), ["memory.m1", "memory.m2"]);
		deepStrictEqual(byTarget.get("jev2"), ["skills.run"]);
	});

	it("asks nothing at all when both sites are unbound", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{ settings: settingsFor({}), providers: providersWith(capture, () => ({})), ctx },
			request,
		);
		strictEqual(capture.calls.length, 0);
		deepStrictEqual(result, { memory: null, skills: null });
	});

	it("asks only the bound site", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one" }),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.95)]))),
				ctx,
			},
			request,
		);
		deepStrictEqual(capture.calls[0]?.questionIds.sort(), ["memory.m1", "memory.m2"]);
		ok(result.memory);
		strictEqual(result.skills, null);
	});

	// A network failure must cost ordering, never a turn.
	it("returns no scores when the call throws", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one", skills: "system-one" }),
				providers: providersWith(capture, () => new Error("ECONNREFUSED")),
				ctx,
			},
			request,
		);
		deepStrictEqual(result, { memory: null, skills: null });
	});

	// The probability is the score. A confident negative is a real judgment that
	// ranks last; only the undecided middle produces no entry.
	it("scores a confident negative and abstains only near the coin-flip", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one" }),
				providers: providersWith(capture, () => ({
					"memory.m1": noul(0.05),
					"memory.m2": noul(0.52),
				})),
				ctx,
			},
			request,
		);
		deepStrictEqual(result.memory?.scores, { m1: 0.05 });
		strictEqual("m2" in (result.memory?.scores ?? {}), false);
	});

	it("drops an answer of the wrong shape rather than coercing it", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one" }),
				providers: providersWith(capture, () => ({
					"memory.m1": { type: "score", score: 2, confidence: 1 },
					"memory.m2": noul(0.99),
				})),
				ctx,
			},
			request,
		);
		deepStrictEqual(result.memory?.scores, { m2: 0.99 });
	});

	// Context rot is also an exfiltration surface. The pass sends the task and
	// one bounded summary per candidate, and nothing else.
	it("sends only the task and the candidate summaries, both bounded", async () => {
		const capture: Capture = { calls: [] };
		await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one" }),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.9)]))),
				ctx,
			},
			{
				task: "t".repeat(5000),
				memory: [{ id: "m1", summary: "s".repeat(5000) }],
				skills: [],
			},
		);
		const state = capture.calls[0]?.state as { task: string; candidates: Record<string, string> };
		deepStrictEqual(Object.keys(state), ["task", "candidates"]);
		ok([...state.task].length <= 600);
		ok([...(state.candidates.m1 ?? "")].length <= 240);
	});

	it("caps how many candidates one pass carries", async () => {
		const capture: Capture = { calls: [] };
		await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one" }),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.9)]))),
				ctx,
			},
			{
				task: "t",
				memory: Array.from({ length: 100 }, (_, index) => ({ id: `m${index}`, summary: "lesson" })),
				skills: [],
			},
		);
		strictEqual(capture.calls[0]?.questionIds.length, 24);
	});

	it("scores installed skills beyond the first 24 catalog names", async () => {
		const capture: Capture = { calls: [] };
		const skills = [
			...Array.from({ length: 37 }, (_, index) => ({ id: `skill-${index}`, summary: "A skill." })),
			{ id: "zz-relevant", summary: "The relevant skill, listed last." },
		];
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ skills: "system-one" }),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.9)]))),
				ctx,
			},
			{ task: "use the skill listed last", memory: [], skills },
		);
		strictEqual(capture.calls[0]?.questionIds.length, skills.length);
		strictEqual(result.skills?.scores["zz-relevant"], 0.9);
	});

	it("reports the target and model that answered", async () => {
		const capture: Capture = { calls: [] };
		const result = await scoreTurnRelevance(
			{
				settings: settingsFor({ memory: "system-one" }),
				providers: providersWith(capture, (ids) => Object.fromEntries(ids.map((id) => [id, noul(0.9)]))),
				ctx,
			},
			request,
		);
		strictEqual(result.memory?.source, "jev/jev-latest");
	});
});
