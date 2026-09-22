import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import { createDecisionHintsRegistration } from "../../src/domains/middleware/decision-hints.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import {
	type PreTurnSite,
	preTurnHints,
	preTurnRecord,
	runPreTurnBrief,
} from "../../src/domains/providers/pre-turn-brief.js";
import { relevanceSite } from "../../src/domains/providers/relevance-pass.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import {
	dispatchForecastHint,
	dispatchForecastSite,
	TURN_SCOPE_HINT,
	TURN_SITES,
	turnScopeSite,
} from "../../src/domains/providers/sites/index.js";
import type { DecideOptions, DecideResult, DecisionAnswer } from "../../src/domains/providers/types/inference.js";

const ctx = { credentialsPresent: new Set<string>(), httpTimeoutMs: 5000 };

interface Call {
	target: string;
	state: Record<string, unknown>;
	questionIds: string[];
}

function providersWith(
	calls: Call[],
	reply: (ids: string[]) => Record<string, DecisionAnswer> | Error,
): ProvidersContract {
	const runtime = {
		...typesafeJev,
		async decide(target: { id: string }, opts: DecideOptions): Promise<DecideResult> {
			const questionIds = Object.keys(opts.questions);
			calls.push({ target: target.id, state: opts.state as Record<string, unknown>, questionIds });
			const answers = reply(questionIds);
			if (answers instanceof Error) throw answers;
			return { model: "jev-1.13.0", answers };
		},
	};
	return {
		getTarget: (id: string) =>
			id === "jev" || id === "jev2" ? { id, runtime: "typesafe-jev", defaultModel: "jev-latest" } : null,
		getRuntime: (id: string) => (id === "typesafe-jev" ? runtime : null),
	} as unknown as ProvidersContract;
}

function settingsFor(decisionProfiles: Record<string, string>) {
	return validateSettings({
		targets: [
			{ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" },
			{ id: "jev2", runtime: "typesafe-jev", defaultModel: "jev-preview" },
		],
		fleet: {
			profiles: { one: { target: "jev", model: "jev-latest" }, two: { target: "jev2", model: "jev-preview" } },
			decisionProfiles,
		},
	}).settings;
}

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });
const choice = (value: string, confidence: number): DecisionAnswer => ({
	type: "choice",
	choice: value,
	confidence,
	probabilities: { [value]: confidence },
});

function answering(values: Record<string, DecisionAnswer>, fallback = noul(0.9)) {
	return (ids: string[]) => Object.fromEntries(ids.map((id) => [id, values[id] ?? fallback]));
}

const memory = relevanceSite("memory", () => [{ id: "m1", summary: "A lesson." }]);

describe("pre-turn brief", () => {
	it("batches every bound site into one request and namespaces the question ids", async () => {
		const calls: Call[] = [];
		const brief = await runPreTurnBrief(
			{
				settings: settingsFor({ memory: "one", turnScope: "one", dispatchForecast: "one" }),
				providers: providersWith(calls, answering({ "dispatchForecast.shape": choice("parallel", 0.9) })),
				ctx,
			},
			[memory, ...TURN_SITES],
			{ task: "explore the repo", previous: "" },
		);
		strictEqual(calls.length, 1);
		deepStrictEqual(calls[0]?.questionIds.sort(), [
			"dispatchForecast.dispatch",
			"dispatchForecast.shape",
			"memory.m1",
			"turnScope.direct",
		]);
		deepStrictEqual(brief.get("memory")?.value, { m1: 0.9 });
		deepStrictEqual(brief.get("dispatchForecast")?.value, { dispatch: 0.9, shape: "parallel" });
		strictEqual(brief.get("turnScope")?.source, "jev/jev-latest");
	});

	// The relevance request is what 0.5.4 measured and calibrated. A site that
	// does not name `previous` must not change its body.
	it("sends previous only when a bound site's wording names it", async () => {
		const calls: Call[] = [];
		const providers = providersWith(calls, answering({}));
		const evidence = { task: "a task", previous: "I can fix it. Want me to go ahead?" };
		await runPreTurnBrief(
			{ settings: settingsFor({ memory: "one" }), providers, ctx },
			[memory, ...TURN_SITES],
			evidence,
		);
		deepStrictEqual(Object.keys(calls[0]?.state ?? {}), ["task", "candidates"]);
		await runPreTurnBrief(
			{ settings: settingsFor({ memory: "one", turnScope: "one" }), providers, ctx },
			[memory, ...TURN_SITES],
			evidence,
		);
		deepStrictEqual(Object.keys(calls[1]?.state ?? {}), ["task", "previous", "candidates"]);
		strictEqual(calls[1]?.state.previous, evidence.previous);
	});

	it("keeps the tail of a long previous message, which is what it proposed", async () => {
		const calls: Call[] = [];
		const previous = `${"background ".repeat(100)}Shall I apply the fix?`;
		await runPreTurnBrief(
			{ settings: settingsFor({ turnScope: "one" }), providers: providersWith(calls, answering({})), ctx },
			TURN_SITES,
			{ task: "yes", previous },
		);
		const sent = String(calls[0]?.state.previous);
		ok(sent.startsWith("…"));
		ok(sent.endsWith("Shall I apply the fix?"));
		strictEqual([...sent].length, 400);
	});

	it("never prepares an unbound site", async () => {
		let prepared = 0;
		const site: PreTurnSite<number> = {
			site: "turnScope",
			version: "test",
			prepare() {
				prepared += 1;
				return { questions: { q: turnScopeSite.prepare({ task: "", previous: "" })?.questions.direct as never } };
			},
			read: () => 1,
		};
		const calls: Call[] = [];
		const brief = await runPreTurnBrief(
			{ settings: settingsFor({}), providers: providersWith(calls, answering({})), ctx },
			[site as PreTurnSite<unknown>],
			{ task: "a task" },
		);
		strictEqual(prepared, 0);
		strictEqual(calls.length, 0);
		strictEqual(brief.size, 0);
	});

	it("isolates a site that cannot prepare or cannot read from the others", async () => {
		const broken = (site: "turnScope" | "dispatchForecast", where: "prepare" | "read"): PreTurnSite<unknown> => ({
			site,
			version: "test",
			prepare: () => {
				if (where === "prepare") throw new Error("catalog unreadable");
				return { questions: { q: { type: "noul", instructions: "q", criteria: { true: "y", false: "n" } } } };
			},
			read: () => {
				throw new Error("misread");
			},
		});
		const calls: Call[] = [];
		const brief = await runPreTurnBrief(
			{
				settings: settingsFor({ memory: "one", turnScope: "one", dispatchForecast: "one" }),
				providers: providersWith(calls, answering({})),
				ctx,
			},
			[memory, broken("turnScope", "prepare"), broken("dispatchForecast", "read")],
			{ task: "a task" },
		);
		strictEqual(calls.length, 1);
		deepStrictEqual([...brief.keys()], ["memory"]);
	});

	it("asks each answering model separately", async () => {
		const calls: Call[] = [];
		await runPreTurnBrief(
			{ settings: settingsFor({ memory: "one", turnScope: "two" }), providers: providersWith(calls, answering({})), ctx },
			[memory, ...TURN_SITES],
			{ task: "a task" },
		);
		const byTarget = new Map(calls.map((call) => [call.target, call.questionIds.sort()]));
		deepStrictEqual(byTarget.get("jev"), ["memory.m1"]);
		deepStrictEqual(byTarget.get("jev2"), ["turnScope.direct"]);
	});

	it("records only the sites that ask to be recorded", async () => {
		const calls: Call[] = [];
		const sites = [memory, ...TURN_SITES];
		const brief = await runPreTurnBrief(
			{
				settings: settingsFor({ memory: "one", turnScope: "one", dispatchForecast: "one" }),
				providers: providersWith(
					calls,
					answering({ "turnScope.direct": noul(0.123), "dispatchForecast.dispatch": noul(0.04) }),
				),
				ctx,
			},
			sites,
			{ task: "a task" },
		);
		const rows = preTurnRecord(sites, brief);
		deepStrictEqual(
			rows.map((row) => [row.site, row.version, row.value]),
			[
				["turnScope", "turnscope-v1", { direct: 0.12 }],
				["dispatchForecast", "dispatchforecast-v1", { dispatch: 0.04, shape: null }],
			],
		);
	});
});

describe("turn sites", () => {
	const read = <T>(site: PreTurnSite<T>, answers: Record<string, DecisionAnswer>) => {
		const ask = site.prepare({ task: "t", previous: "" });
		ok(ask);
		return site.read(answers, ask);
	};

	it("hints scope only on a confident direct answer", () => {
		strictEqual(turnScopeSite.hint?.({ direct: 0.95 }), TURN_SCOPE_HINT);
		strictEqual(turnScopeSite.hint?.({ direct: 0.79 }), null);
		strictEqual(read(turnScopeSite, { direct: { type: "choice", choice: "x" } }), null);
	});

	it("hints a plan only on a confident dispatch forecast, naming the shape it read", () => {
		strictEqual(dispatchForecastHint({ dispatch: 0.69, shape: "parallel" }), null);
		strictEqual(
			dispatchForecastHint({ dispatch: 0.9, shape: "parallel" }),
			"[Plan] This reads as work suited to workers; it splits into independent pieces that could run in parallel. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.",
		);
		strictEqual(
			dispatchForecastHint({ dispatch: 0.9, shape: null }),
			"[Plan] This reads as work suited to workers. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.",
		);
	});

	it("drops a shape that is undecided or outside the options it was given", () => {
		deepStrictEqual(read(dispatchForecastSite, { dispatch: noul(0.9), shape: choice("parallel", 0.3) }), {
			dispatch: 0.9,
			shape: null,
		});
		deepStrictEqual(read(dispatchForecastSite, { dispatch: noul(0.9), shape: choice("swarm", 1) }), {
			dispatch: 0.9,
			shape: null,
		});
	});

	it("renders hints in site order and skips sites without one", () => {
		const brief = new Map<string, { value: unknown; version: string; source: string; latencyMs: number }>([
			["dispatchForecast", { value: { dispatch: 0.95, shape: "single" }, version: "v", source: "s", latencyMs: 1 }],
			["turnScope", { value: { direct: 0.9 }, version: "v", source: "s", latencyMs: 1 }],
			["memory", { value: { m1: 0.9 }, version: "v", source: "s", latencyMs: 1 }],
		]);
		deepStrictEqual(preTurnHints([memory, ...TURN_SITES], brief as never), [
			TURN_SCOPE_HINT,
			"[Plan] This reads as work suited to workers; one worker could carry it. Your delegation rules apply: dispatch before you read or edit, so your own context stays free. Whether and how to dispatch stays your call.",
		]);
	});
});

describe("decision hints registration", () => {
	const turnStart = (metadata: Record<string, string | number | boolean> = {}) => ({
		hook: "turn_start" as const,
		metadata,
	});

	it("injects every hint as one reminder", () => {
		const registration = createDecisionHintsRegistration({ getHints: () => ["a", "b"] });
		deepStrictEqual(registration.evaluate(turnStart()), [{ kind: "inject_reminder", severity: "info", message: "a\nb" }]);
	});

	it("contributes nothing without hints, on a continuation, or under explicit turn constraints", () => {
		deepStrictEqual(createDecisionHintsRegistration({ getHints: () => [] }).evaluate(turnStart()), []);
		deepStrictEqual(
			createDecisionHintsRegistration({ getHints: () => ["a"] }).evaluate(turnStart({ requestContinuation: true })),
			[],
		);
		deepStrictEqual(
			createDecisionHintsRegistration({ getHints: () => ["a"], getTurnConstraints: () => ({ mode: "answer" }) }).evaluate(
				turnStart(),
			),
			[],
		);
		deepStrictEqual(
			createDecisionHintsRegistration({
				getHints: () => {
					throw new Error("store unreadable");
				},
			}).evaluate(turnStart()),
			[],
		);
	});
});
