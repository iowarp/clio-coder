import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { RunnerRoute } from "../../src/domains/system-one/runner.js";
import { createRunner } from "../../src/domains/system-one/runner.js";
import type {
	DecisionEngine,
	EngineCapabilities,
	EngineReply,
	EngineRequest,
	SystemOne,
} from "../../src/domains/system-one/types.js";
import type { TriageEntry, TriageVerdict } from "../../src/session-control/steering-triage.js";
import {
	runTriageRound,
	TRIAGE_STOP_MIN_CONFIDENCE,
	triageFloor,
	triageKindFor,
	triageLabelsFor,
	triageMayInterrupt,
} from "../../src/session-control/steering-triage.js";

const MASS: EngineCapabilities = {
	semantics: new Set(["boolean", "exclusive", "ordinal", "independent"]),
	readout: { boolean: "server", exclusive: "server", ordinal: "server", independent: "server" },
	probabilities: true,
	minOptions: 1,
	maxOptions: 255,
	optionTokens: null,
	headTokens: null,
	windowTokens: null,
	windowCounts: "per-question",
	renderer: "systemone-v1",
};
const LABELS: EngineCapabilities = {
	...MASS,
	readout: { boolean: "categorical", exclusive: "categorical", ordinal: "categorical", independent: "categorical" },
	probabilities: false,
	windowCounts: "whole-request",
	renderer: "llm-prompt",
};

const ENTRY: TriageEntry = { id: "q1", text: "stop, wrong branch", kind: "steer" };
const SETTINGS = { target: null, minQueued: 2, timeoutMs: 8000 };

/** Answers every relation with `relation` at `mass` and every urgency with `now`. */
function engine(
	capabilities: EngineCapabilities,
	relation: string,
	mass: number,
): DecisionEngine & { asked: EngineRequest[] } {
	const asked: EngineRequest[] = [];
	return {
		name: "typed",
		kind: "systemone",
		profile: "jev",
		capabilities,
		destination: { targetId: "typed", runtimeId: "systemone", wireModelId: "x" },
		asked,
		async decide(request): Promise<EngineReply> {
			asked.push(request);
			const answers: Record<string, EngineReply["answers"][string]> = {};
			for (const id of Object.keys(request.questions)) {
				answers[id] = id.startsWith("relation")
					? { type: "choice", choice: relation, probabilities: { [relation]: mass, addition: 1 - mass } }
					: { type: "choice", choice: "now", probabilities: { now: 0.9, nextSlot: 0.1 } };
			}
			return { build: "fake", answers };
		},
	};
}

function over(built: DecisionEngine): Pick<SystemOne, "bound" | "ask"> {
	const route: RunnerRoute = { name: built.name, engine: built, digest: built.name, timeoutMs: 5_000 };
	const runner = createRunner({});
	return { bound: () => true, ask: (point, object, options) => runner.ask([route], point, object, options ?? {}) };
}

const FAILING: Pick<SystemOne, "bound" | "ask"> = { bound: () => true, ask: async () => null };

interface Ran {
	applied: TriageVerdict[] | null;
	side: number;
}

async function round(input: {
	systemOne?: Pick<SystemOne, "bound" | "ask">;
	asked?: ReadonlyArray<TriageEntry>;
	triage?: { target: string | null; minQueued: number; timeoutMs: number };
	current?: () => boolean;
}): Promise<Ran> {
	const ran: Ran = { applied: null, side: 0 };
	await runTriageRound({
		triage: input.triage ?? SETTINGS,
		systemOne: input.systemOne,
		asked: input.asked ?? [ENTRY],
		task: () => "fix the cache",
		previous: () => "working on it",
		current: input.current ?? (() => true),
		apply: (verdicts) => {
			ran.applied = [...verdicts];
		},
		side: async () => {
			ran.side += 1;
		},
	});
	return ran;
}

const FRESH = { enqueuedAt: 1_000, pinned: false };

test("a bound route answers two typed picks per entry and the side model never runs", async () => {
	const typed = engine(MASS, "newTask", 0.9);
	const second: TriageEntry = { id: "q2", text: "also add docs", kind: "follow-up" };
	const ran = await round({ systemOne: over(typed), asked: [ENTRY, second] });
	strictEqual(ran.side, 0);
	strictEqual(typed.asked.length, 1);
	deepStrictEqual(Object.keys(typed.asked[0]?.questions ?? {}), ["relation0", "urgency0", "relation1", "urgency1"]);
	deepStrictEqual(
		ran.applied?.map((verdict) => [verdict.id, verdict.relation, verdict.urgency, verdict.confidence]),
		[
			["q1", "newTask", "now", 0.9],
			["q2", "newTask", "now", 0.9],
		],
	);
	strictEqual(typed.asked[0]?.state.task, "fix the cache");
	const relation = typed.asked[0]?.questions.relation0;
	ok(relation?.instructions.includes("stop, wrong branch"));
	ok(relation?.instructions.includes("next slot"));
	strictEqual(triageKindFor({ id: "q", relation: "newTask", urgency: "endOfTurn", confidence: 0.9 }), "follow-up");
});

test("a null verdict or a failing route falls back to the side-model round", async () => {
	const ran = await round({ systemOne: FAILING, asked: [ENTRY, { ...ENTRY, id: "q2" }] });
	strictEqual(ran.side, 1);
	strictEqual(ran.applied, null);
});

test("a lone entry a failing route could not read stays put, because the side model keeps its floor", async () => {
	const ran = await round({ systemOne: FAILING });
	strictEqual(ran.side, 0);
	strictEqual(ran.applied, null);
});

test("an explicit target keeps the side model and asks no route", async () => {
	const typed = engine(MASS, "stop", 0.99);
	const ran = await round({
		systemOne: over(typed),
		asked: [ENTRY, { ...ENTRY, id: "q2" }],
		triage: { ...SETTINGS, target: "side" },
	});
	strictEqual(ran.side, 1);
	strictEqual(typed.asked.length, 0);
});

test("unbound is the side-model round", async () => {
	const unbound: Pick<SystemOne, "bound" | "ask"> = {
		bound: () => false,
		ask: async () => {
			throw new Error("an unbound System One is not asked");
		},
	};
	const ran = await round({ systemOne: unbound, asked: [ENTRY, { ...ENTRY, id: "q2" }] });
	strictEqual(ran.side, 1);
});

test("a queue that moved while the ask ran is left alone", async () => {
	const ran = await round({ systemOne: over(engine(MASS, "stop", 0.99)), current: () => false });
	strictEqual(ran.applied, null);
	strictEqual(ran.side, 0);
});

test("a label readout only marks, however one-hot its answer", async () => {
	const ran = await round({ systemOne: over(engine(LABELS, "stop", 1)) });
	const verdict = ran.applied?.[0];
	strictEqual(verdict?.relation, "stop");
	strictEqual(verdict?.confidence, undefined);
	const labels = triageLabelsFor(verdict as TriageVerdict);
	strictEqual(labels.readout, "label");
	ok(!("confidence" in labels));
	strictEqual(triageMayInterrupt(verdict as TriageVerdict, FRESH, 1_000), false);
});

test("real mass interrupts at the bar and not under it", async () => {
	const at = (await round({ systemOne: over(engine(MASS, "stop", TRIAGE_STOP_MIN_CONFIDENCE)) })).applied?.[0];
	strictEqual(triageMayInterrupt(at as TriageVerdict, FRESH, 1_000), true);
	strictEqual(triageLabelsFor(at as TriageVerdict).confidence, "0.80");
	ok(!("readout" in triageLabelsFor(at as TriageVerdict)));
	const under = (await round({ systemOne: over(engine(MASS, "stop", 0.79)) })).applied?.[0];
	strictEqual(under?.relation, "stop");
	strictEqual(triageMayInterrupt(under as TriageVerdict, FRESH, 1_000), false);
	strictEqual(triageMayInterrupt(at as TriageVerdict, { ...FRESH, pinned: true }, 1_000), false);
});

test("a lone entry is read when a route answers, and the side model keeps its floor of 2", async () => {
	const bound = over(engine(MASS, "stop", 0.9));
	const unbound: Pick<SystemOne, "bound" | "ask"> = { bound: () => false, ask: bound.ask };
	strictEqual(triageFloor(SETTINGS, bound), 1);
	strictEqual(triageFloor(SETTINGS, unbound), 2);
	strictEqual(triageFloor(SETTINGS, undefined), 2);
	strictEqual(triageFloor({ ...SETTINGS, target: "side" }, bound), 2);
	const ran = await round({ systemOne: bound });
	strictEqual(ran.applied?.length, 1);
});

test("a queue with no entry answered by both picks reads as null and falls back", async () => {
	const partial: DecisionEngine = {
		...engine(MASS, "stop", 0.9),
		async decide(): Promise<EngineReply> {
			return {
				build: "fake",
				answers: {
					relation0: { type: "choice", choice: "stop", probabilities: { stop: 0.9, addition: 0.1 } },
				},
			};
		},
	};
	const ran = await round({ systemOne: over(partial), asked: [ENTRY, { ...ENTRY, id: "q2" }] });
	strictEqual(ran.applied, null);
	strictEqual(ran.side, 1);
});
