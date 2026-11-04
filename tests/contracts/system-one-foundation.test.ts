import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_ONE_HELP } from "../../src/cli/system-one.js";
import { SETTINGS_V1_RETIRED_PATHS } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { readTelemetryRecord } from "../../src/core/telemetry/envelope.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import type { ConsultValue } from "../../src/domains/system-one/points/index.js";
import { consultPoint } from "../../src/domains/system-one/points/index.js";
import { filterQuestions, pick, pointQuestion, yesNo } from "../../src/domains/system-one/questions.js";
import type { RunnerRoute } from "../../src/domains/system-one/runner.js";
import { BREAKER_THRESHOLD, createRunner } from "../../src/domains/system-one/runner.js";
import { resolveChoice, routeNames } from "../../src/domains/system-one/selection.js";
import { describeStatus, formatStatus, SYSTEM_ONE_REACH } from "../../src/domains/system-one/status.js";
import type {
	DecisionEngine,
	DecisionPoint,
	EngineCapabilities,
	EngineDestination,
	EngineReply,
	EngineRequest,
	Question,
} from "../../src/domains/system-one/types.js";

const NETWORK: EngineDestination = { targetId: "t", runtimeId: "systemone", wireModelId: "m" };

const JULIA_SHAPED: EngineCapabilities = {
	semantics: new Set(["boolean", "exclusive", "ordinal", "independent"]),
	readout: {
		boolean: "softmax-binary",
		exclusive: "softmax-exclusive",
		ordinal: "ordinal-expectation",
		independent: "softmax-binary",
	},
	probabilities: true,
	minOptions: 2,
	maxOptions: 20,
	optionTokens: 48,
	headTokens: 512,
	windowTokens: 8192,
	windowCounts: "per-question",
	renderer: "julia-compact-v1",
};

const LABEL_ONLY: EngineCapabilities = {
	semantics: new Set(["exclusive"]),
	readout: {
		boolean: "categorical",
		exclusive: "softmax-exclusive",
		ordinal: "categorical",
		independent: "categorical",
	},
	probabilities: true,
	minOptions: 2,
	maxOptions: 255,
	optionTokens: null,
	headTokens: null,
	windowTokens: null,
	windowCounts: "per-question",
	renderer: "gliner-label-v1",
};

const IN_PROCESS: EngineCapabilities = {
	...JULIA_SHAPED,
	readout: { boolean: "server", exclusive: "server", ordinal: "server", independent: "server" },
	probabilities: false,
	minOptions: 1,
	maxOptions: 255,
	optionTokens: null,
	headTokens: null,
	windowTokens: null,
	renderer: "systemone-v1",
};

type Reply = (request: EngineRequest) => Promise<EngineReply>;

function engine(
	name: string,
	capabilities: EngineCapabilities,
	destination: EngineDestination | null,
	reply: Reply,
): DecisionEngine & { asked: EngineRequest[] } {
	const asked: EngineRequest[] = [];
	return {
		name,
		kind: "systemone",
		profile: "generic",
		capabilities,
		destination,
		asked,
		decide(request) {
			asked.push(request);
			return reply(request);
		},
	};
}

function route(built: DecisionEngine, timeoutMs = 5_000): RunnerRoute {
	return { name: built.name, engine: built, digest: built.name, timeoutMs };
}

/** Answers every question it was sent: yes/no at 0.8, the first option at 0.7, the first label at 0.8. */
const answerAll: Reply = async (request) => {
	const answers: Record<string, EngineReply["answers"][string]> = {};
	for (const [id, question] of Object.entries(request.questions)) {
		if (question.type === "noul") answers[id] = { type: "noul", noul: 0.8 };
		else if (question.type === "choice") {
			const [first, second] = Object.keys(question.criteria) as [string, string];
			answers[id] = { type: "choice", choice: first, probabilities: { [first]: 0.8, [second]: 0.2 } };
		}
	}
	return { build: "fake-build", answers };
};

const hang: Reply = (request) =>
	new Promise((_resolve, reject) => {
		request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
	});

const object = { state: { task: "t" }, files: {} };

const mixedPoint = (): DecisionPoint<typeof object, ConsultValue> =>
	consultPoint({
		risky: pointQuestion(yesNo("Is it risky?", "It is", "It is not")),
		which: pointQuestion(pick("Which file?", { a: "cache.ts", b: "store.ts" })),
		...filterQuestions(
			{ instructions: "Does this item touch persistence?", whenTrue: "It does", whenFalse: "It does not" },
			{ one: "cache.ts", two: "view.ts" },
		),
	});

test("a Julia-shaped engine reads yes/no, pick and filter natively, and its numbers carry its readout", async () => {
	const julia = engine("julia", JULIA_SHAPED, NETWORK, answerAll);
	const verdict = await createRunner({}).ask([route(julia)], mixedPoint(), object, {});
	ok(verdict);
	const sent = julia.asked[0]?.questions as Record<string, Question>;
	strictEqual(sent.risky?.type, "noul");
	strictEqual(sent.which?.type, "choice");
	strictEqual(sent.one?.type, "noul");
	deepStrictEqual(verdict.value.answers.one, { kind: "yesNo", pTrue: 0.8, certainty: 0.6 });
	deepStrictEqual(verdict.value.answers.which, {
		kind: "pick",
		distribution: { a: 0.8, b: 0.2 },
		certainty: 0.6,
	});
});

test("a bounded renderer abstains on an option it cannot prove fits, and the reason reaches the reader", async () => {
	const julia = engine("julia", JULIA_SHAPED, NETWORK, answerAll);
	const long = "x".repeat(200);
	const point = consultPoint({
		short: pointQuestion(yesNo("Is it risky?", "It is", "It is not")),
		long: pointQuestion(pick("Which?", { a: long, b: "other" })),
	});
	const verdict = await createRunner({}).ask([route(julia)], point, object, {});
	ok(verdict);
	strictEqual(Object.keys(julia.asked[0]?.questions ?? {}).join(), "short");
	const reading = verdict.value.answers.long as { abstained: true; reason?: string };
	strictEqual(reading.abstained, true);
	ok(reading.reason?.includes("not truncated"));
});

test("a label-only engine gets a two-label choice per yes/no item, and match mass decodes back to a yes/no", async () => {
	const labels = engine("labels", LABEL_ONLY, NETWORK, answerAll);
	const verdict = await createRunner({}).ask([route(labels)], mixedPoint(), object, {});
	ok(verdict);
	const sent = labels.asked[0]?.questions as Record<string, Question>;
	for (const id of ["risky", "one", "two"]) {
		const question = sent[id];
		ok(question?.type === "choice");
		deepStrictEqual(Object.keys(question.criteria), ["match", "other"]);
	}
	deepStrictEqual(verdict.value.answers.two, { kind: "yesNo", pTrue: 0.8, certainty: 0.6 });
	strictEqual((verdict.value.answers.which as { kind: string }).kind, "pick");
});

test("an engine that reads neither, or demands more than two options, abstains on a yes/no before any byte leaves", async () => {
	const ordinalOnly = engine(
		"ordinal",
		{ ...JULIA_SHAPED, semantics: new Set(["ordinal"]), renderer: "systemone-v1" },
		NETWORK,
		answerAll,
	);
	const threeUp = engine("three", { ...LABEL_ONLY, minOptions: 3 }, NETWORK, answerAll);
	const point = consultPoint({ risky: pointQuestion(yesNo("Is it risky?", "It is", "It is not")) });
	let reason = "";
	const verdict = await createRunner({}).ask([route(ordinalOnly), route(threeUp)], point, object, {
		onFailure: (text) => {
			reason = text;
		},
	});
	strictEqual(verdict, null);
	strictEqual(ordinalOnly.asked.length + threeUp.asked.length, 0);
	ok(reason.length > 0);
});

test("an in-process engine has no destination, so nothing that judges a network ever sees it", async () => {
	const local = engine("local", IN_PROCESS, null, answerAll);
	const verdict = await createRunner({
		flowCheck: () => {
			throw new Error("a null destination must not reach the flow check");
		},
		slotsFull: () => {
			throw new Error("a null destination must not reach the slot check");
		},
	}).ask([route(local)], { ...mixedPoint(), optional: true }, object, {});
	ok(verdict);
	strictEqual(verdict.engine, "local");
});

test("a failed route moves to the next one once, and a hung one still leaves the next usable inside the total", async () => {
	const broken = engine("broken", JULIA_SHAPED, NETWORK, async () => {
		throw new Error("refused");
	});
	const hung = engine("hung", JULIA_SHAPED, NETWORK, hang);
	const good = engine("good", JULIA_SHAPED, NETWORK, answerAll);
	const verdict = await createRunner({}).ask([route(broken), route(hung, 20), route(good)], mixedPoint(), object, {});
	ok(verdict);
	strictEqual(verdict.engine, "good");
	deepStrictEqual(
		verdict.routes.map((attempt) => [attempt.engine, attempt.outcome]),
		[
			["broken", "failed"],
			["hung", "timeout"],
			["good", "answered"],
		],
	);
	strictEqual(broken.asked.length, 1);
	strictEqual(hung.asked.length, 1);
});

test("a route whose timeouts opened its breaker is skipped, and a total that runs out does not count against it", async () => {
	const hung = engine("hung", JULIA_SHAPED, NETWORK, hang);
	const good = engine("good", JULIA_SHAPED, NETWORK, answerAll);
	const runner = createRunner({});
	for (let attempt = 0; attempt < BREAKER_THRESHOLD; attempt += 1) {
		await runner.ask([route(hung, 5), route(good)], mixedPoint(), object, {});
	}
	strictEqual(hung.asked.length, BREAKER_THRESHOLD);
	const after = await runner.ask([route(hung, 5), route(good)], mixedPoint(), object, {});
	strictEqual(hung.asked.length, BREAKER_THRESHOLD);
	strictEqual(after?.routes[0]?.outcome, "breaker-open");
	strictEqual(after?.engine, "good");

	const slow = engine("slow", JULIA_SHAPED, NETWORK, hang);
	const shortTotal = { ...mixedPoint(), deadlineMs: 5 };
	strictEqual(await runner.ask([route(slow)], shortTotal, object, {}), null);
	strictEqual(runner.breakers().filter((breaker) => breaker.engine === "slow").length, 0);
});

test("a route the flow check denies, or one with no free slot on an optional point, is skipped without a byte", async () => {
	const denied = engine("denied", JULIA_SHAPED, { ...NETWORK, targetId: "denied" }, answerAll);
	const full = engine("full", JULIA_SHAPED, { ...NETWORK, targetId: "full" }, answerAll);
	const good = engine("good", JULIA_SHAPED, NETWORK, answerAll);
	const runner = createRunner({
		flowCheck: ({ destination }) =>
			destination.targetId === "denied" ? { allowed: false, reason: "no" } : { allowed: true },
		slotsFull: (destination) => destination.targetId === "full",
	});
	const verdict = await runner.ask(
		[route(denied), route(full), route(good)],
		{ ...mixedPoint(), optional: true },
		object,
		{},
	);
	strictEqual(verdict?.engine, "good");
	strictEqual(denied.asked.length + full.asked.length, 0);
	deepStrictEqual(
		verdict?.routes.map((attempt) => attempt.outcome),
		["flow-denied", "busy", "answered"],
	);
});

test("a point that requires real probabilities skips a route that does not declare them", async () => {
	const labels = engine("no-mass", { ...JULIA_SHAPED, probabilities: false }, NETWORK, answerAll);
	const good = engine("good", JULIA_SHAPED, NETWORK, answerAll);
	const verdict = await createRunner({}).ask(
		[route(labels), route(good)],
		{ ...mixedPoint(), requires: { probabilities: true } },
		object,
		{},
	);
	strictEqual(verdict?.engine, "good");
	strictEqual(labels.asked.length, 0);
	strictEqual(verdict?.routes[0]?.outcome, "unsupported");
});

test("a route carrying the whole ask wins; with none, the first carrying part answers and the rest abstain", async () => {
	const point = consultPoint({
		risky: pointQuestion(yesNo("Is it risky?", "It is", "It is not")),
		one: pointQuestion(pick("Only one option", { only: "the only one" })),
	});
	const part = engine("part", JULIA_SHAPED, NETWORK, answerAll);
	const whole = engine("whole", IN_PROCESS, null, async (request) => {
		const reply = await answerAll({ ...request, questions: { risky: request.questions.risky as Question } });
		return {
			...reply,
			answers: { ...reply.answers, one: { type: "choice", choice: "only", probabilities: { only: 1 } } },
		};
	});
	const runner = createRunner({});
	strictEqual((await runner.ask([route(part), route(whole)], point, object, {}))?.engine, "whole");
	const partial = await runner.ask([route(part)], point, object, {});
	strictEqual(partial?.engine, "part");
	ok("abstained" in (partial?.value.answers.one ?? {}));
});

test("the server refusing a model by name stops that route for good", async () => {
	const refuses = engine("refuses", JULIA_SHAPED, NETWORK, async () => {
		throw new Error("400 unknown model jev-9");
	});
	const runner = createRunner({});
	await runner.ask([route(refuses)], mixedPoint(), object, {});
	await runner.ask([route(refuses)], mixedPoint(), object, {});
	strictEqual(refuses.asked.length, 1);
	strictEqual(runner.refused()[0]?.engine, "refuses");
});

test("one content-free decided event reaches subscribers with the route walk", async () => {
	const seen: unknown[] = [];
	const stop = telemetryHub().subscribe("system_one.decided", (payload) => {
		seen.push(payload);
	});
	try {
		const broken = engine("broken", JULIA_SHAPED, NETWORK, async () => {
			throw new Error("refused");
		});
		const good = engine("good", JULIA_SHAPED, NETWORK, async (request) => ({
			...(await answerAll(request)),
			usage: { input: 10, output: 2 },
		}));
		await createRunner({}).ask([route(broken), route(good)], mixedPoint(), object, { ref: "tool-1" });
	} finally {
		stop();
	}
	strictEqual(seen.length, 1);
	const event = seen[0] as Record<string, unknown> & { routes: Array<Record<string, unknown>> };
	strictEqual(event.point, "consult");
	strictEqual(event.set, "consult-v1");
	strictEqual(event.ref, "tool-1");
	strictEqual(event.outcome, "answered");
	strictEqual(event.build, "fake-build");
	strictEqual(event.readout, "softmax-binary");
	deepStrictEqual(event.tokens, { input: 10, output: 2 });
	strictEqual(event.asked, 4);
	strictEqual(event.abstained, 0);
	strictEqual(event.routes.length, 2);
	strictEqual(JSON.stringify(event).includes("cache.ts"), false);
});

test("an old decided line and a capture line read as retired, keyed on kind and version", () => {
	const line = (k: string, kv: number) => ({ v: 1, k, kv, t: "2026-01-01T00:00:00.000Z", data: {} });
	strictEqual(readTelemetryRecord(line("system_one.decided", 1)).kind, "retired");
	strictEqual(readTelemetryRecord(line("system_one.sample_captured", 7)).kind, "retired");
	// Version 2 is not retired, so a malformed one is an invalid record rather than something quietly ignored.
	strictEqual(readTelemetryRecord(line("system_one.decided", 2)).kind, "skipped");
});

test("use names routes: a list keeps its order, off ends it, and nothing unnamed appears", () => {
	deepStrictEqual(routeNames(null), []);
	deepStrictEqual(routeNames("off"), []);
	deepStrictEqual(routeNames(["jev", "off", "main"]), []);
	deepStrictEqual(routeNames(["main", "jev", "main"]), ["main", "jev"]);
	const settings = structuredClone(DEFAULT_SETTINGS);
	const jev = resolveChoice(settings, "jev");
	ok(jev.kind === "engine");
	strictEqual(jev.engine.profile, "jev");
	strictEqual(jev.impliedTarget?.runtime, "typesafe-jev");
	strictEqual(resolveChoice(settings, "main").kind, "unavailable");
});

test("every surface says a bound route reaches past consult, and the CLI lists only what exists", () => {
	const help = SYSTEM_ONE_HELP.replace(/\s+/g, " ");
	for (const words of ["safety judge", "web and MCP results", "steering triage", "leaves the machine"]) {
		ok(help.includes(words), `help says ${words}`);
	}
	deepStrictEqual(
		SYSTEM_ONE_HELP.split("\n")
			.filter((line) => line.startsWith("clio-coder systemone "))
			.map((line) => line.split(" ")[2]),
		["status", "use", "off", "check"],
	);
	ok(!/calibrate|\bexport\b/.test(SYSTEM_ONE_HELP));
	ok(SETTINGS_V1_RETIRED_PATHS["systemOne.sites"].includes("judge screen"));
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.systemOne.use = "jev";
	ok(formatStatus(describeStatus({ settings })).join("\n").includes(SYSTEM_ONE_REACH));
	settings.systemOne.use = "off";
	ok(!formatStatus(describeStatus({ settings })).join("\n").includes(SYSTEM_ONE_REACH));
});
