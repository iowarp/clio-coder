import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import { FITTED_CONTRACTS, FITTED_CUTS } from "../../src/domains/system-one/calibration.js";
import { createSystemOne } from "../../src/domains/system-one/factory.js";
import { yesNo } from "../../src/domains/system-one/questions.js";
import { BREAKER_THRESHOLD, createRunner } from "../../src/domains/system-one/runner.js";
import type {
	Answer,
	DecisionEngine,
	DecisionRecord,
	EngineReply,
	SiteCuts,
	SiteDefinition,
} from "../../src/domains/system-one/types.js";

/**
 * The runner's contract with a site and its caller, against a stand-in engine.
 * No network and no Clio state: what matters here is when a call returns null,
 * and that every call past `state()` leaves exactly one record.
 */

const FITTED_BUILD = "jev-1.13.0";
/** A measured cut applies only under the renderer and site version its table was fitted under. */
const FITTED_CONTRACT = FITTED_CONTRACTS[FITTED_BUILD];
const answer: Answer = { type: "noul", noul: 0.9, certainty: 0.8, calibrated: true };

interface Seen {
	cuts: SiteCuts | null;
	stateCalls: number;
}

function site(overrides: Partial<SiteDefinition<string, string>> = {}, seen?: Seen): SiteDefinition<string, string> {
	return {
		id: "turn",
		version: FITTED_CONTRACT?.sites.turn ?? "turn-v2",
		deadlineMs: 30,
		state: (object) => {
			if (seen) seen.stateCalls += 1;
			return { task: object };
		},
		questions: () => ({ direct: yesNo("Direct?", "yes", "no") }),
		read: (_answers, _object, cuts) => {
			if (seen) seen.cuts = cuts;
			return "read";
		},
		summarize: (value) => ({ value }),
		...overrides,
	};
}

interface Fake {
	engine: DecisionEngine;
	calls: () => number;
}

function fakeEngine(decide: (signal: AbortSignal) => Promise<EngineReply>, windowTokens: number | null = null): Fake {
	let calls = 0;
	return {
		calls: () => calls,
		engine: {
			name: "fake",
			kind: "llm",
			target: "t",
			model: null,
			windowTokens,
			runtime: "test",
			url: null,
			profile: null,
			renderer: FITTED_CONTRACT?.renderer ?? "systemone-v1",
			unsupported: () => null,
			decide: async ({ signal }) => {
				calls += 1;
				return decide(signal);
			},
		},
	};
}

const replyAs = (build: string) => async (): Promise<EngineReply> => ({ build, answers: { direct: answer } });
/** An engine that never answers on its own: only the deadline or an abort ends the call. */
const hangs = (): Promise<EngineReply> => new Promise(() => {});

function harness(cutOverrides: Record<string, Record<string, number>> = {}) {
	const records: DecisionRecord[] = [];
	const runner = createRunner({
		recorder: () => ({ decision: (record) => records.push(record), outcome: () => {} }),
		cutOverrides: () => cutOverrides,
	});
	const bind = (fake: Fake, timeoutMs?: number) => ({
		routes: [{ name: "fake", engine: fake.engine, digest: `digest-${Math.random()}`, tasks: null }],
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	});
	return { records, runner, bind };
}

describe("System One runner", () => {
	it("returns null for an unbound site without resolving a target or recording", async () => {
		const seen: Seen = { cuts: null, stateCalls: 0 };
		const lookups: string[] = [];
		const records: DecisionRecord[] = [];
		const so = createSystemOne({
			settings: () =>
				({ systemOne: { engines: {}, sites: {}, cuts: {}, record: false, retentionDays: 30, maxMiB: 64 } }) as ClioSettings,
			providers: {
				getTarget: (id) => {
					lookups.push(id);
					return null;
				},
				getRuntime: (id) => {
					lookups.push(id);
					return null;
				},
			},
			credentialsPresent: () => new Set(),
			recorder: () => ({ decision: (record) => records.push(record), outcome: () => {} }),
		});
		strictEqual(so.bound("turn"), false);
		strictEqual(await so.run(site({}, seen), "hello"), null);
		strictEqual(seen.stateCalls, 0);
		deepStrictEqual(lookups, []);
		strictEqual(records.length, 0);
	});

	it("asks nothing and records nothing when state() is null", async () => {
		const { runner, bind, records } = harness();
		const fake = fakeEngine(replyAs(FITTED_BUILD));
		strictEqual(await runner.run(bind(fake), site({ state: () => null }), "x", {}), null);
		strictEqual(fake.calls(), 0);
		strictEqual(records.length, 0);
	});

	it("gives read() fitted:false for a build nobody fitted, and true for one in the table", async () => {
		const { runner, bind, records } = harness();
		const seen: Seen = { cuts: null, stateCalls: 0 };
		const unfitted = await runner.run(bind(fakeEngine(replyAs("some-other-build"))), site({}, seen), "x", {});
		strictEqual(unfitted?.fitted, false);
		strictEqual(seen.cuts?.fitted, false);
		strictEqual(seen.cuts?.cut("direct"), undefined);
		const fitted = await runner.run(bind(fakeEngine(replyAs(FITTED_BUILD))), site({}, seen), "x", {});
		strictEqual(fitted?.fitted, true);
		strictEqual(seen.cuts?.cut("direct"), FITTED_CUTS[FITTED_BUILD]?.["turn.direct"]);
		deepStrictEqual(
			records.map((record) => record.fitted),
			[false, true],
		);
	});

	it("lets an operator cut override the table and fit an otherwise unfitted build", async () => {
		const { runner, bind } = harness({
			[FITTED_BUILD]: { "turn.direct": 0.5 },
			"some-other-build": { "turn.direct": 0.6 },
		});
		const seen: Seen = { cuts: null, stateCalls: 0 };
		await runner.run(bind(fakeEngine(replyAs(FITTED_BUILD))), site({}, seen), "x", {});
		strictEqual(seen.cuts?.cut("direct"), 0.5);
		// The table's other cuts under that build survive the override.
		strictEqual(seen.cuts?.cut("direction"), FITTED_CUTS[FITTED_BUILD]?.["turn.direction"]);
		const verdict = await runner.run(bind(fakeEngine(replyAs("some-other-build"))), site({}, seen), "x", {});
		strictEqual(verdict?.fitted, true);
		strictEqual(seen.cuts?.cut("direct"), 0.6);
	});

	it("returns null on overflow without asking the engine", async () => {
		const { runner, bind, records } = harness();
		const fake = fakeEngine(replyAs(FITTED_BUILD), 10);
		const result = await runner.run(bind(fake), site({ state: () => ({ task: "x".repeat(400) }) }), "x", {});
		strictEqual(result, null);
		strictEqual(fake.calls(), 0);
		deepStrictEqual(
			records.map((record) => record.outcome),
			["overflow"],
		);
	});

	it("returns null at the deadline with one timeout record", async () => {
		const { runner, bind, records } = harness();
		strictEqual(await runner.run(bind(fakeEngine(hangs)), site(), "x", {}), null);
		deepStrictEqual(
			records.map((record) => record.outcome),
			["timeout"],
		);
	});

	it("opens the breaker after 3 consecutive timeouts and stops asking the engine", async () => {
		const { runner, bind, records } = harness();
		const fake = fakeEngine(hangs);
		const binding = bind(fake);
		for (let index = 0; index <= BREAKER_THRESHOLD; index += 1) {
			strictEqual(await runner.run(binding, site(), "x", {}), null);
		}
		deepStrictEqual(
			records.map((record) => record.outcome),
			["timeout", "timeout", "timeout", "breaker-open"],
		);
		strictEqual(fake.calls(), BREAKER_THRESHOLD);
	});

	it("returns null with one canceled record when the caller aborts mid-call", async () => {
		const { runner, bind, records } = harness();
		const controller = new AbortController();
		setTimeout(() => controller.abort(new Error("operator pressed escape")), 5);
		const result = await runner.run(bind(fakeEngine(hangs), 5_000), site(), "x", { signal: controller.signal });
		strictEqual(result, null);
		deepStrictEqual(
			records.map((record) => record.outcome),
			["canceled"],
		);
	});

	it("finds an answer under the moment it was asked at, not under the bare site", async () => {
		const { runner, records } = harness();
		const route = {
			name: "fake",
			engine: fakeEngine(replyAs("some-other-build")).engine,
			digest: "gate-digest",
			tasks: null,
		};
		await runner.run({ routes: [route] }, site({ id: "toolCall", moment: "gate" }), "x", {});
		strictEqual(records[0]?.outcome, "answered");
		strictEqual(
			runner.answeredIdentity("gate-digest", "toolCall", "gate")?.identity.startsWith("some-other-build"),
			true,
		);
		strictEqual(runner.answeredIdentity("gate-digest", "toolCall"), null);
		strictEqual(runner.answeredIdentity("gate-digest", "toolCall", "card"), null);
	});

	it("returns null when read() throws, and still records what the engine answered", async () => {
		const { runner, bind, records } = harness();
		const result = await runner.run(
			bind(fakeEngine(replyAs(FITTED_BUILD))),
			site({
				read: () => {
					throw new Error("policy bug");
				},
			}),
			"x",
			{},
		);
		strictEqual(result, null);
		strictEqual(records.length, 1);
		strictEqual(records[0]?.outcome, "answered");
		strictEqual(records[0]?.error, "policy bug");
	});
});
