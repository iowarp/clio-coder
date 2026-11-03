import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClioSettings } from "../../src/core/config.js";
import type { EventPayload } from "../../src/core/telemetry/events.js";
import { validPayload } from "../../src/core/telemetry/events.js";
import { newCallId } from "../../src/core/telemetry/ids.js";
import type { PendingTelemetry } from "../../src/core/telemetry/producer.js";
import { registerTelemetrySink } from "../../src/core/telemetry/producer.js";
import { createRedactionTally } from "../../src/domains/evidence/redact.js";
import llamacppRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import { cutsFor, FITTED_CONTRACTS, FITTED_CUTS } from "../../src/domains/system-one/calibration.js";
import { createSystemOne } from "../../src/domains/system-one/factory.js";
import { yesNo } from "../../src/domains/system-one/questions.js";
import { clearedSiteObject } from "../../src/domains/system-one/recorder/scrub.js";
import {
	BREAKER_COOLDOWN_MS,
	BREAKER_THRESHOLD,
	createRunner,
	noteSystemOneCall,
} from "../../src/domains/system-one/runner.js";
import { createSystemOneScopes } from "../../src/domains/system-one/scopes.js";
import { effectiveSystemOne, resolveChoice } from "../../src/domains/system-one/selection.js";
import { RELEVANCE_CLUSTER_SITE } from "../../src/domains/system-one/sites/relevance.js";
import { TURN_SITE } from "../../src/domains/system-one/sites/turn.js";
import { describeStatus } from "../../src/domains/system-one/status.js";
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

const FITTED_BUILD = "jev-1.14.0";
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
		version: FITTED_CONTRACT?.sites.turn ?? "turn-v3",
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
			expectedBuilds: () => [],
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
			settings: () => ({ systemOne: { use: null, engines: {}, sites: {} } }) as ClioSettings,
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

	it("opts in through systemOne.use alone, and a memory route binds nothing by itself", () => {
		const settingsFor = (use: string | null, sites: Record<string, unknown> = {}) =>
			({
				chat: { target: "chat", model: "chat-model" },
				context: { memory: { enabled: true, target: "memory", model: "side-model" } },
				targets: [
					{ id: "chat", runtime: "openai" },
					{ id: "memory", runtime: "llamacpp", url: "http://127.0.0.1:8080" },
				],
				systemOne: { use, engines: {}, sites },
			}) as unknown as ClioSettings;
		const profile = ["turn", "workerPrepare", "toolCall", "relevance", "drafts"];
		deepStrictEqual(effectiveSystemOne(settingsFor(null)).systemOne.sites, {});
		for (const use of ["jev", "memory", "main", "chat"]) {
			deepStrictEqual(Object.keys(effectiveSystemOne(settingsFor(use)).systemOne.sites), profile, use);
		}
		deepStrictEqual(effectiveSystemOne(settingsFor("main")).systemOne.engines.main, {
			kind: "llm",
			target: "chat",
			model: "chat-model",
		});
		deepStrictEqual(effectiveSystemOne(settingsFor("memory")).systemOne.engines.memory, {
			kind: "llm",
			target: "memory",
			model: "side-model",
		});
		// Jev needs only its key: the choice brings its target, and sends nothing without the key.
		deepStrictEqual(
			effectiveSystemOne(settingsFor("jev")).targets.find((target) => target.id === "jev")?.runtime,
			"typesafe-jev",
		);
		// A site's own entry overrides the choice, and null turns that site off.
		const overridden = effectiveSystemOne(settingsFor("jev", { relevance: "memory", drafts: null })).systemOne.sites;
		strictEqual(overridden.relevance, "memory");
		strictEqual(overridden.drafts, undefined);
		// consult takes its own entry on every engine.
		strictEqual(effectiveSystemOne(settingsFor("jev")).systemOne.sites.consult, undefined);
		strictEqual(effectiveSystemOne(settingsFor("jev", { consult: "memory" })).systemOne.sites.consult, "memory");
		// off masks everything, a site bound one by one included.
		deepStrictEqual(effectiveSystemOne(settingsFor("off", { turn: "memory" })).systemOne.sites, {});
		deepStrictEqual(effectiveSystemOne(settingsFor(null, { turn: "memory" })).systemOne.sites, { turn: "memory" });
		// memory never borrows the chat route, and an unknown name says what it is not.
		const noMemory = settingsFor("memory");
		noMemory.context.memory.target = null;
		strictEqual(resolveChoice(noMemory, "memory").kind, "unavailable");
		strictEqual(resolveChoice(settingsFor(null), "nope").kind, "unavailable");
	});

	it("expires a task override after the task it covered, and a session override with its session", () => {
		const scopes = createSystemOneScopes();
		strictEqual(scopes.current(), null);
		scopes.set("session", "memory");
		scopes.set("task", "jev");
		deepStrictEqual(scopes.current(), { use: "jev", scope: "task" });
		scopes.noteOperatorTurn();
		deepStrictEqual(scopes.current(), { use: "jev", scope: "task" });
		scopes.noteOperatorTurn();
		deepStrictEqual(scopes.current(), { use: "memory", scope: "session" });
		scopes.resetSession(null);
		strictEqual(scopes.current(), null);
	});

	it("says plainly why a chosen engine will send nothing", () => {
		const settingsFor = (use: string | null) =>
			({
				chat: { target: "chat", model: "chat-model" },
				context: { memory: { enabled: true, target: null, model: null } },
				targets: [{ id: "chat", runtime: "openai" }],
				systemOne: { use, engines: {}, sites: {} },
			}) as unknown as ClioSettings;
		const headline = (use: string | null, credentials: string[] = []) =>
			describeStatus({ settings: settingsFor(use), hasCredential: (_runtime, name) => credentials.includes(name) })
				.headline;
		match(headline(null), /^off/);
		match(headline("off"), /^off/);
		match(headline("jev"), /^unavailable: TYPESAFE_API_KEY is not set/);
		match(
			headline("jev", ["TYPESAFE_API_KEY"]),
			/^active for measured actions at turn, workerPrepare, toolCall, relevance/,
		);
		match(headline("main", ["OPENAI_API_KEY"]), /configured but unmeasured.*systemone calibrate main/);
		match(headline("main", ["OPENAI_API_KEY"]), /adds separate completions on chat\/chat-model/);
		match(headline("memory"), /^unavailable: context.memory names no target/);
	});

	it("reads an engine with no measurement for its build as shadow before any request", () => {
		const cuts: Record<string, Record<string, number>> = {};
		const so = createSystemOne({
			settings: () =>
				({
					targets: [],
					systemOne: {
						use: null,
						engines: { side: { kind: "llm", target: "t", model: "m", mode: "auto" } },
						sites: { relevance: { engine: "side" }, turn: { engine: "side" } },
					},
				}) as unknown as ClioSettings,
			localCuts: () => cuts,
			providers: {
				getTarget: () => ({ id: "t", runtime: "llamacpp", url: "http://127.0.0.1:1", defaultModel: "m" }),
				getRuntime: () => llamacppRuntime,
			},
			credentialsPresent: () => new Set(),
			recorder: () => ({ decision: () => {}, outcome: () => {} }),
		});
		strictEqual(so.shadowed("relevance"), true);
		strictEqual(so.shadowed("turn"), true);
		cuts["llm:llamacpp@127.0.0.1:1/m#logprobs:p1"] = { "relevance.ranked": 0.5 };
		strictEqual(so.shadowed("relevance"), false);
		strictEqual(so.shadowed("turn"), true);
	});

	it("asks nothing and records nothing when state() is null", async () => {
		const { runner, bind, records } = harness();
		const fake = fakeEngine(replyAs(FITTED_BUILD));
		strictEqual(await runner.run(bind(fake), site({ state: () => null }), "x", {}), null);
		strictEqual(fake.calls(), 0);
		strictEqual(records.length, 0);
	});

	it("hands a site only cleared text, so no cut of its own can leave a partial secret", async () => {
		const { runner, bind } = harness();
		const raw = `${"x ".repeat(100)}AKIAIOSFODNN7EXAMPLE https://u:hunter2hunter2@host/a --token tokenvalue1`;
		const handed: string[] = [];
		const answers: string[] = [];
		const clearing = site({
			state: (object) => {
				handed.push(object);
				return { task: object.slice(0, 203) };
			},
			questions: (object) => {
				handed.push(object);
				return { direct: yesNo("Direct?", "yes", "no") };
			},
			read: (_answers, object) => {
				answers.push(object);
				return "read";
			},
		});
		await runner.run(bind(fakeEngine(replyAs(FITTED_BUILD))), clearing, raw, {});
		strictEqual(handed.length, 2);
		for (const text of handed) doesNotMatch(text, /AKIA|hunter2|tokenvalue1/);
		// `read` stays local and compares against what the caller passed.
		deepStrictEqual(answers, [raw]);
	});

	it("gives a site both ends of a long text, cut where no partial secret survives", () => {
		const middle = "word ".repeat(30_000);
		const tally = createRedactionTally();
		const text = clearedSiteObject(`start ${middle}AKIAIOSFODNN7EXAMPLE ${middle}finish`, tally);
		ok(text.length < 70_000);
		ok(text.startsWith("start word"));
		ok(text.endsWith("word finish"));
		const key = `${"word ".repeat(13_000)}-----BEGIN RSA PRIVATE KEY----- ${"Zm9v ".repeat(30_000)}-----END RSA PRIVATE KEY----- after`;
		doesNotMatch(clearedSiteObject(key, tally), /Zm9v/);
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

	it("acts on jev-1.14.0's measured keys, keeps a key left without a cut silent, and has no table for jev-1.13.0", () => {
		const contract = { siteVersion: TURN_SITE.version, renderer: "systemone-v1" } as const;
		const cuts = cutsFor("jev-1.14.0", "turn", undefined, contract);
		strictEqual(cuts.fitted, true);
		strictEqual(cuts.cut("direct"), FITTED_CUTS["jev-1.14.0"]?.["turn.direct"]);
		strictEqual(cuts.cut("orientation"), undefined);
		const noul = (p: number): Answer => ({ type: "noul", noul: p, certainty: Math.abs(p * 2 - 1), calibrated: true });
		const choice = (name: string): Answer => ({
			type: "choice",
			choice: name,
			probabilities: { [name]: 1 },
			certainty: 1,
			calibrated: true,
		});
		const value = TURN_SITE.read(
			{ direct: noul(0.99), architecture: noul(0.99), shape: choice("single") },
			{ task: "give me a tour", previous: "", previousTask: "" },
			cuts,
		);
		ok(value?.hints.scope);
		strictEqual(cutsFor("jev-1.13.0", "turn", undefined, contract).fitted, false);
		strictEqual(
			cutsFor("jev-1.14.0", "relevance", undefined, {
				siteVersion: RELEVANCE_CLUSTER_SITE.version,
				renderer: "systemone-v1",
			}).cut("clusters"),
			FITTED_CUTS["jev-1.14.0"]?.["relevance.clusters"],
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

	it("reports each engine breaker for /health, counting timeouts and then open (#434)", async () => {
		const { runner, bind } = harness();
		const binding = bind(fakeEngine(hangs));
		deepStrictEqual(runner.breakers(), []);
		for (let index = 1; index < BREAKER_THRESHOLD; index += 1) await runner.run(binding, site(), "x", {});
		deepStrictEqual(
			runner.breakers().map(({ engine, state, failures, remainingMs }) => ({ engine, state, failures, remainingMs })),
			[{ engine: "fake", state: "closed", failures: BREAKER_THRESHOLD - 1, remainingMs: 0 }],
		);
		await runner.run(binding, site(), "x", {});
		const [open] = runner.breakers();
		strictEqual(open?.state, "open");
		strictEqual(open.failures, BREAKER_THRESHOLD);
		strictEqual(open.site, site().id);
		ok(open.remainingMs > 0);
	});

	it("settles a cancelled probe, and one its preflight abandoned, back to half-open instead of probing until its deadline (#434)", async (t) => {
		const { runner, bind, records } = harness();
		const binding = bind(fakeEngine(hangs));
		for (let index = 0; index < BREAKER_THRESHOLD; index += 1) await runner.run(binding, site(), "x", {});
		const now = performance.now.bind(performance);
		let skew = 0;
		t.mock.method(performance, "now", () => now() + skew);
		skew = BREAKER_COOLDOWN_MS + 1;
		strictEqual(runner.breakers()[0]?.state, "half-open");
		const cancel = new AbortController();
		const probe = runner.run(binding, site(), "x", { signal: cancel.signal });
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(runner.breakers()[0]?.state, "probing");
		cancel.abort();
		strictEqual(await probe, null);
		strictEqual(records.at(-1)?.outcome, "canceled");
		strictEqual(runner.breakers()[0]?.state, "half-open");
		// A probe whose preflight spent the deadline never reaches the engine and releases the breaker the same way.
		const late = site({
			questions: () => {
				skew += 1_000;
				return { direct: yesNo("Direct?", "yes", "no") };
			},
		});
		strictEqual(await runner.run(binding, late, "x", {}), null);
		strictEqual(records.at(-1)?.outcome, "timeout");
		strictEqual(runner.breakers()[0]?.state, "half-open");
	});

	it("records system_one.decision with its breaker moves and the calls its engine opened (#429)", async () => {
		const records: PendingTelemetry[] = [];
		const release = registerTelemetrySink("decision-session", { enqueue: (record) => Boolean(records.push(record)) });
		try {
			const runner = createRunner({
				recorder: () => ({ decision: () => {}, outcome: () => {} }),
				cutOverrides: () => ({}),
				currentSession: () => "decision-session",
			});
			const callId = newCallId();
			const fake = fakeEngine(() => {
				noteSystemOneCall(callId);
				return hangs();
			});
			const binding = { routes: [{ name: "fake", engine: fake.engine, digest: "digest-decision", tasks: null }] };
			for (let index = 0; index <= BREAKER_THRESHOLD; index += 1) await runner.run(binding, site(), "x", {});
		} finally {
			release();
		}
		const decisions = records.filter((record) => record.kind === "system_one.decided");
		strictEqual(decisions.length, BREAKER_THRESHOLD + 1);
		for (const decision of decisions)
			ok(validPayload("system_one.decided", decision.data), JSON.stringify(decision.data));
		const data = decisions.map((decision) => decision.data as EventPayload<"system_one.decided">);
		deepStrictEqual(
			data.map((decision) => [decision.outcome, decision.routes[0]?.breaker ?? null]),
			[
				["timeout", null],
				["timeout", null],
				["timeout", "opened"],
				["breaker-open", null],
			],
		);
		strictEqual(data[0]?.callIds.length, 1);
		deepStrictEqual(data[3]?.callIds, [], "an engine the breaker skipped opened no call");
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
