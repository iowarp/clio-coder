/**
 * What the composition root keeps between System One calls.
 *
 * A fake SystemOne stands where the runner would: it answers each site through
 * the real site's own reading, so the host is tested against the shapes it will
 * meet. Time is a fake clock (`performance.now` and `setTimeout` moved together),
 * so no case waits on the wall clock.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import type {
	Answer,
	DecisionRecorder,
	SiteCuts,
	SiteDefinition,
	SiteId,
	SystemOne,
	Verdict,
} from "../../src/domains/system-one/index.js";
import {
	createDecisionUsageTally,
	createSystemOneHost,
	TURN_END_WAIT_MS,
	type TurnEndReadInput,
} from "../../src/entry/system-one-host.js";

const BUILD = "test-build-1";

function noul(p: number): Answer {
	return { type: "noul", noul: p, certainty: Math.abs(2 * p - 1), calibrated: true };
}

function choice(option: string): Answer {
	return { type: "choice", choice: option, probabilities: { [option]: 1 }, certainty: 0.9, calibrated: true };
}

/** Every cut sits at 0.5 except a floor, which a two-sided cut needs below its bar. */
const FITTED: SiteCuts = {
	build: BUILD,
	fitted: true,
	cut: (key) => (key.endsWith("Floor") ? 0.3 : 0.5),
};

const LOUD_TURN: Readonly<Record<string, Answer>> = {
	direct: noul(0.99),
	dispatch: noul(0.99),
	orientation: noul(0.99),
	direction: noul(0.99),
	breadth: choice("repository"),
	intent: choice("inspect"),
	shape: choice("parallel"),
	recipe: choice("scout"),
};

const RECIPES = [
	{ id: "scout", description: "Maps a repository." },
	{ id: "coder", description: "Changes code." },
];

interface Call {
	site: SiteId;
	ref: string | undefined;
}

type Script = (
	site: SiteId,
) => Readonly<Record<string, Answer>> | null | Promise<Readonly<Record<string, Answer>> | null>;

/** A SystemOne that reads whatever `script` answers through the real site, and counts calls per site. */
function fakeSystemOne(
	script: Script,
	bound: ReadonlyArray<SiteId>,
	shadowed = false,
): { calls: Call[]; systemOne: SystemOne } {
	const calls: Call[] = [];
	const systemOne: SystemOne = {
		bound: (site) => bound.includes(site),
		shadowed: () => shadowed,
		describe: () => [],
		async run<O, V>(site: SiteDefinition<O, V>, object: O, options?: { ref?: string }): Promise<Verdict<V> | null> {
			calls.push({ site: site.id, ref: options?.ref });
			const answers = await script(site.id);
			if (answers === null) return null;
			const value = site.read(answers, object, FITTED);
			if (value === null) return null;
			return { value, callId: `call-${calls.length}`, engine: "jev", build: BUILD, fitted: true, latencyMs: 5 };
		},
	};
	return { calls, systemOne };
}

const SILENT_RECORDER: DecisionRecorder = { decision: () => {}, outcome: () => {} };

function hostOver(systemOne: SystemOne, recording?: () => boolean) {
	return createSystemOneHost({
		systemOne,
		...(recording !== undefined ? { recording } : {}),
		usage: createDecisionUsageTally(SILENT_RECORDER),
		readSessionEntries: () => [],
		listRecipes: () => RECIPES,
	});
}

function turnInput(userTurnId: string) {
	return {
		userTurnId,
		task: "look at the repo and tell me what it does",
		request: "look at the repo and tell me what it does",
		previous: "",
		previousTask: () => "",
		signal: new AbortController().signal,
	};
}

describe("contracts/system one host: the turn site", () => {
	it("joins the call to the reserved user turn id", async () => {
		const { calls, systemOne } = fakeSystemOne(() => LOUD_TURN, ["turn"]);
		await hostOver(systemOne).readTurn(turnInput("reserved-turn-7"));
		deepStrictEqual(calls, [{ site: "turn", ref: "reserved-turn-7" }]);
	});

	it("leaves hints, interpretation and prewarm empty when the verdict is null", async () => {
		let answers: Readonly<Record<string, Answer>> | null = LOUD_TURN;
		const { systemOne } = fakeSystemOne(() => answers, ["turn"]);
		const host = hostOver(systemOne);

		await host.readTurn(turnInput("turn-1"));
		ok(host.interpretation() !== undefined, "the control verdict is held");
		ok(host.prewarm() !== null, "the control verdict would prewarm");

		answers = null;
		await host.readTurn(turnInput("turn-2"));
		strictEqual(host.hints(), null);
		strictEqual(host.interpretation(), undefined);
		strictEqual(host.prewarm(), null);
		strictEqual(host.turnId(), "turn-2", "the turn is still held for a later ranking to join");
	});
});

describe("contracts/system one host: the turn-end wait", () => {
	let clock = 0;
	beforeEach(() => {
		clock = 0;
		mock.timers.enable({ apis: ["setTimeout"] });
		mock.method(performance, "now", () => clock);
	});
	afterEach(() => {
		mock.timers.reset();
		mock.restoreAll();
	});

	function advance(ms: number): void {
		clock += ms;
		mock.timers.tick(ms);
	}

	/** Let every already-resolved promise run its continuations. */
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

	const input: TurnEndReadInput = {
		userTurnId: "turn-1",
		request: "inspect this",
		message: "I found two choices. Which one should I use?",
		toolNames: ["read"],
	};

	function pending(promise: Promise<unknown>): { settled: () => boolean } {
		let done = false;
		void promise.then(() => {
			done = true;
		});
		return { settled: () => done };
	}

	it("spends one budget across the nudge and the settled turn", async () => {
		// The engine never answers within the turn.
		const { calls, systemOne } = fakeSystemOne(() => new Promise(() => {}), ["turnEnd"]);
		const host = hostOver(systemOne);

		const nudge = pending(host.blocksOnOperator(input));
		await flush();
		advance(TURN_END_WAIT_MS - 1);
		await flush();
		strictEqual(nudge.settled(), false, "the nudge is still inside its budget");
		advance(1);
		await flush();
		strictEqual(nudge.settled(), true, "the nudge gives up when the budget is spent");

		// The settled turn reads the same call and finds the budget already spent: a fresh
		// interval would keep it waiting here.
		const settled = pending(host.readTurnEnd(input));
		await flush();
		advance(1);
		await flush();
		strictEqual(settled.settled(), true, "the settled turn does not wait a second interval");
		strictEqual(calls.length, 1, "both readers share the one call");
		deepStrictEqual(calls[0], { site: "turnEnd", ref: "turn-1" });
	});

	it("hands a reading that arrived inside the budget to both readers", async () => {
		let release: (answers: Readonly<Record<string, Answer>>) => void = () => {};
		const { calls, systemOne } = fakeSystemOne(() => new Promise((resolve) => (release = resolve)), ["turnEnd"]);
		const host = hostOver(systemOne);

		const nudge = host.blocksOnOperator(input);
		await flush();
		advance(800);
		release({ asksOperator: noul(0.99), blocksOnDecision: noul(0.99) });
		strictEqual(await nudge, true);

		// Long after the budget, the finished reading is still the answer.
		advance(60_000);
		deepStrictEqual(await host.readTurnEnd(input), { asks: true });
		strictEqual(calls.length, 1);
	});

	it("asks nothing and waits for nothing when the site is unbound", async () => {
		const { calls, systemOne } = fakeSystemOne(() => LOUD_TURN, []);
		strictEqual(await hostOver(systemOne).blocksOnOperator(input), null);
		strictEqual(calls.length, 0);
	});
});

describe("contracts/system one host: a shadowed build", () => {
	const NEVER: Script = () => new Promise(() => {});
	const flushed = () => new Promise<"waited">((resolve) => setImmediate(() => resolve("waited")));
	const input: TurnEndReadInput = { userTurnId: "turn-1", request: "r", message: "Which one?", toolNames: [] };

	// Each row: what recording says, and how many engine calls the shadowed site makes.
	const rows: Array<[string, (() => boolean) | undefined, number]> = [
		["recording on", () => true, 1],
		["recording unwired", undefined, 1],
		["recording off", () => false, 0],
	];

	for (const [label, recording, made] of rows) {
		it(`resolves the turn read at once and makes ${made} call with ${label}`, async () => {
			const { calls, systemOne } = fakeSystemOne(NEVER, ["turn"], true);
			const host = hostOver(systemOne, recording);
			const settled = await Promise.race([host.readTurn(turnInput("turn-1")).then(() => "read"), flushed()]);
			strictEqual(settled, "read", "the prompt does not wait on a shadowed engine");
			strictEqual(calls.length, made);
			strictEqual(host.hints(), null);
		});

		it(`resolves the nudge and the streak at once and makes ${made} call with ${label}`, async () => {
			const { calls, systemOne } = fakeSystemOne(NEVER, ["turnEnd"], true);
			const host = hostOver(systemOne, recording);
			const settled = await Promise.race([
				Promise.all([host.blocksOnOperator(input), host.readTurnEnd(input)]),
				flushed(),
			]);
			deepStrictEqual(settled, [null, null]);
			strictEqual(calls.length, made, "one shared call, or none");
		});
	}
});
