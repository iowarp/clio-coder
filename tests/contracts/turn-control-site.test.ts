import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";
import { grade, readProbeField } from "../../scripts/decision-probe.js";
import {
	createDispatchForecastSite,
	DISPATCH_SHAPE_QUESTION,
} from "../../src/domains/providers/sites/dispatch-forecast.js";
import {
	createHarnessRoutingSite,
	HARNESS_INTENT_QUESTION,
	HARNESS_INTENTS,
} from "../../src/domains/providers/sites/harness-routing.js";
import { TURN_SITES, turnSites } from "../../src/domains/providers/sites/index.js";
import {
	createTurnControlSite,
	TURN_CONTROL_QUESTIONS,
	TURN_INTERPRETATION_SYSTEM_PROMPT,
} from "../../src/domains/providers/sites/turn-control.js";
import type { DecisionAnswer } from "../../src/domains/providers/types/inference.js";
import { registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { interpretTurnWithMainModel } from "../../src/interactive/turn-interpretation-fallback.js";

const choice = (value: string, confidence = 0.9): DecisionAnswer => ({ type: "choice", choice: value, confidence });
const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });
const site = createTurnControlSite();
const ask = site.prepare({ task: "explore this repo", previous: "" });
ok(ask);

it("reads and summarizes all five answers, shares wording, and registers without a hint", () => {
	strictEqual(site.site, "turnControl");
	strictEqual(site.version, "turncontrol-v1");
	deepStrictEqual(ask.uses, ["previous"]);
	strictEqual(site.hint, undefined);
	strictEqual(ask.questions.intent, HARNESS_INTENT_QUESTION);
	strictEqual(
		createHarnessRoutingSite(() => []).prepare({ task: "", previous: "" })?.questions.intent,
		HARNESS_INTENT_QUESTION,
	);
	strictEqual(ask.questions.shape, DISPATCH_SHAPE_QUESTION);
	strictEqual(
		createDispatchForecastSite().prepare({ task: "", previous: "" })?.questions.shape,
		DISPATCH_SHAPE_QUESTION,
	);
	for (const sites of [TURN_SITES, turnSites()])
		strictEqual(sites.filter((entry) => entry.site === "turnControl").length, 1);
	for (const question of Object.values(TURN_CONTROL_QUESTIONS)) {
		ok(TURN_INTERPRETATION_SYSTEM_PROMPT.includes(question.instructions));
		ok(TURN_INTERPRETATION_SYSTEM_PROMPT.includes(JSON.stringify(question.criteria)));
	}
	match(
		TURN_INTERPRETATION_SYSTEM_PROMPT,
		/1 when one intent plainly applies, 0.5 when two are equally plausible, 0 when you cannot tell/,
	);
	const value = site.read(
		{
			intent: choice("inspect", 0.934),
			orientationWanted: noul(0.876),
			breadth: choice("area"),
			directionRequested: noul(0.123),
			shape: choice("parallel"),
		},
		ask,
	);
	ok(value);
	deepStrictEqual(value, {
		version: "turn-interpretation-v1",
		intent: "inspect",
		intentCertainty: 0.934,
		orientation: { wanted: 0.876, breadth: "area", subject: null },
		direction: { requested: 0.123 },
		shape: "parallel",
	});
	deepStrictEqual(site.summarize?.(value), {
		intent: "inspect",
		intentCertainty: 0.93,
		orientationWanted: 0.88,
		breadth: "area",
		directionRequested: 0.12,
		shape: "parallel",
	});
});

it("abstains on missing or malformed probabilities and drops uncertain or unknown choices", () => {
	strictEqual(site.read({}, ask), null);
	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1])
		strictEqual(site.read({ orientationWanted: noul(value), directionRequested: choice("yes") }, ask), null);
	const partial = site.read(
		{
			directionRequested: noul(0.9),
			intent: choice("inspect", 0.59),
			breadth: choice("area", 0.49),
			shape: choice("parallel", 0.49),
		},
		ask,
	);
	ok(partial);
	deepStrictEqual(partial, {
		version: "turn-interpretation-v1",
		intent: "unknown",
		intentCertainty: 0.59,
		orientation: { wanted: 0, breadth: null, subject: null },
		direction: { requested: 0.9 },
		shape: null,
	});
	for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2]) {
		const value = site.read(
			{
				orientationWanted: noul(0.8),
				intent: choice("inspect", confidence),
				breadth: choice("area", confidence),
				shape: choice("parallel", confidence),
			},
			ask,
		);
		ok(value);
		strictEqual(value.intent, "unknown");
		strictEqual(value.intentCertainty, 0);
		strictEqual(value.orientation.breadth, null);
		strictEqual(value.shape, null);
	}
	const malformed = site.read(
		{ orientationWanted: noul(0.8), intent: choice("invented"), breadth: choice("invented"), shape: choice("invented") },
		ask,
	);
	ok(malformed);
	strictEqual(malformed.intent, "unknown");
	strictEqual(malformed.orientation.breadth, null);
	strictEqual(malformed.shape, null);
	const distribution = site.read(
		{
			orientationWanted: noul(0.9),
			intent: { type: "choice", choice: "inspect", confidence: 0.99, probabilities: { inspect: 0.55, answer: 0.45 } },
		},
		ask,
	);
	ok(distribution);
	strictEqual(distribution.intent, "unknown");
	ok(Math.abs(distribution.intentCertainty - 0.1) < 1e-12);
});

it("grades nested synthetic probabilities and breadth while preserving single-level grading", () => {
	const value = { orientation: { wanted: 0.9, breadth: "area" }, direction: { requested: 0.1 }, intent: "inspect" };
	strictEqual(grade(true, readProbeField(value, "orientation.wanted")), "agree");
	strictEqual(grade(false, readProbeField(value, "direction.requested")), "agree");
	strictEqual(grade("area", readProbeField(value, "orientation.breadth")), "agree");
	strictEqual(grade("inspect", readProbeField(value, "intent")), "agree");
	strictEqual(grade(true, readProbeField({ orientation: null }, "orientation.wanted")), "missing");
	strictEqual(grade(true, readProbeField({ orientation: { wanted: 0.5 } }, "orientation.wanted")), "abstain");
});

it("loads the labeled fixture with all S3 probes, verbatim orientation turns and controls", () => {
	const load = (path: string) => JSON.parse(readFileSync(new URL(`../fixtures/${path}`, import.meta.url), "utf8"));
	const fixture = load("decision-cases/turn-control.json");
	deepStrictEqual(fixture.sites, ["turnControl"]);
	ok(fixture.description.length > 0);
	ok(fixture.cases.length >= 24);
	for (const entry of fixture.cases) {
		strictEqual(typeof entry.task, "string");
		strictEqual(typeof entry.expect["turnControl.orientation.wanted"], "boolean");
		strictEqual(typeof entry.expect["turnControl.direction.requested"], "boolean");
		ok(HARNESS_INTENTS.includes(entry.expect["turnControl.intent"]));
		for (const key of Object.keys(entry.expect))
			ok(
				[
					"turnControl.orientation.wanted",
					"turnControl.direction.requested",
					"turnControl.orientation.breadth",
					"turnControl.intent",
				].includes(key),
			);
		if ("turnControl.orientation.breadth" in entry.expect)
			ok(["repository", "area", "focused"].includes(entry.expect["turnControl.orientation.breadth"]));
	}
	for (const name of ["orientation", "independent-areas", "focused", "undecided", "capability", "session-facts"]) {
		for (const scenario of load(`harness-probes/${name}.json`).cases) {
			for (const turn of name === "undecided" ? scenario.turns.slice(2, 4) : scenario.turns.slice(0, 1))
				ok(
					fixture.cases.some(
						(entry: { task: string; previous?: string }) =>
							entry.task === turn.text && (name !== "undecided" || entry.previous?.includes("What would you like?")),
					),
				);
		}
	}
	const recipes = load("decision-cases/dispatch-recipe.json");
	strictEqual(
		fixture.cases.filter((entry: { task: string }) =>
			recipes.cases.some(
				(recipe: { task: string; source?: string }) => recipe.source === "verbatim" && recipe.task === entry.task,
			),
		).length,
		4,
	);
	for (const task of ["fix the typo in README.md line 3", "list all skills", "thanks, that's all", "hhi"])
		ok(fixture.cases.some((entry: { task: string }) => entry.task === task));
});

const valid = {
	intent: "inspect",
	intentCertainty: 0.9,
	orientationWanted: 0.9,
	breadth: "repository",
	directionRequested: 0,
	shape: "single",
};
function response(text: string, stopReason: "stop" | "aborted" | "error" = "stop") {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "turn-control-fallback",
		provider: "faux",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

it("fallback sends the bounded six-field request and retains usage on valid or malformed JSON", async () => {
	const provider = registerEngineFauxProvider({ api: "turn-control-fallback", models: [{ id: "fixture" }] });
	try {
		provider.setResponses([
			(context, options) => {
				strictEqual(options?.maxTokens, 200);
				strictEqual(options?.temperature, 0);
				const payload = options?.onPayload?.({}, provider.getModel()) as {
					response_format: { schema: { required: string[] } };
				};
				deepStrictEqual(payload.response_format.schema.required, Object.keys(valid));
				ok(
					context.messages.some(
						(message) => message.role === "system" && message.content === TURN_INTERPRETATION_SYSTEM_PROMPT,
					),
				);
				const user = context.messages.at(-1);
				ok(user?.role === "user");
				const text =
					typeof user.content === "string"
						? user.content
						: user.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("");
				const [task, previous] = text.split("\n");
				strictEqual([...(task ?? "").slice(6)].length, 600);
				strictEqual([...(previous ?? "").slice(10)].length, 400);
				ok(previous?.endsWith("tail"));
				return response(JSON.stringify(valid));
			},
		]);
		const result = await interpretTurnWithMainModel({
			model: provider.getModel(),
			runtimeId: "llamacpp",
			task: "😀 ".repeat(700),
			previous: `${"background ".repeat(100)}tail`,
		});
		deepStrictEqual(result.interpretation, {
			version: "turn-interpretation-v1",
			intent: "inspect",
			intentCertainty: 0.9,
			orientation: { wanted: 0.9, breadth: "repository", subject: null },
			direction: { requested: 0 },
			shape: "single",
		});
		ok(result.usage && result.usage.totalTokens > 0);
		const malformed = [
			"not JSON",
			"[]",
			"null",
			JSON.stringify({ ...valid, intent: "invented" }),
			JSON.stringify({ ...valid, breadth: "invented" }),
			JSON.stringify({ ...valid, shape: "invented" }),
			JSON.stringify({ ...valid, extra: true }),
		];
		for (const key of Object.keys(valid)) {
			const missing = { ...valid } as Record<string, unknown>;
			delete missing[key];
			malformed.push(JSON.stringify(missing));
		}
		for (const key of ["intentCertainty", "orientationWanted", "directionRequested"])
			for (const value of [-0.1, 1.1, null, "0.9"]) malformed.push(JSON.stringify({ ...valid, [key]: value }));
		provider.setResponses(malformed.map((text) => response(text)));
		for (const text of malformed) {
			const invalid = await interpretTurnWithMainModel({ model: provider.getModel(), task: "t" });
			strictEqual(invalid.interpretation, null, text);
			ok(invalid.usage && invalid.usage.totalTokens > 0);
		}
		provider.setResponses([
			response(JSON.stringify({ ...valid, intent: "unknown", intentCertainty: 1, breadth: null, shape: null })),
			response("failed", "error"),
		]);
		strictEqual(
			(await interpretTurnWithMainModel({ model: provider.getModel(), task: "t" })).interpretation?.intentCertainty,
			0,
		);
		strictEqual((await interpretTurnWithMainModel({ model: provider.getModel(), task: "t" })).interpretation, null);
	} finally {
		provider.unregister();
	}
});

it("fallback aborts at eight seconds and returns null with the terminal usage", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const provider = registerEngineFauxProvider({ api: "turn-control-timeout", models: [{ id: "fixture" }] });
	let signal: AbortSignal | undefined;
	let started = () => {};
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	try {
		provider.setResponses([
			async (_context, options) => {
				signal = options?.signal;
				ok(signal);
				started();
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
				return response(JSON.stringify(valid), "aborted");
			},
		]);
		const pending = interpretTurnWithMainModel({ model: provider.getModel(), task: "t" });
		await ready;
		t.mock.timers.tick(7999);
		strictEqual(signal?.aborted, false);
		t.mock.timers.tick(1);
		strictEqual(signal?.aborted, true);
		const result = await pending;
		strictEqual(result.interpretation, null);
		ok(result.usage && result.usage.totalTokens > 0);
		const controller = new AbortController();
		controller.abort();
		deepStrictEqual(
			await interpretTurnWithMainModel({ model: provider.getModel(), task: "t", signal: controller.signal }),
			{ interpretation: null, usage: null },
		);
	} finally {
		provider.unregister();
	}
});
