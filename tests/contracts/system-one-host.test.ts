/**
 * What the composition root keeps between System One calls.
 *
 * A fake SystemOne stands where the runner would: it answers each site through
 * the real site's own reading, so the host is tested against the shapes it will
 * meet. Nothing in the host waits on an engine, so no case needs a clock.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
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
	source: () => "measured",
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
	};
}

/** Let every already-resolved promise run its continuations. */
const landed = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("contracts/system one host: the turn site", () => {
	it("joins the call to the reserved user turn id", () => {
		const { calls, systemOne } = fakeSystemOne(() => LOUD_TURN, ["turn"]);
		hostOver(systemOne).readTurn(turnInput("reserved-turn-7"));
		deepStrictEqual(calls, [{ site: "turn", ref: "reserved-turn-7" }]);
	});

	it("returns before the engine answers and hands readers nothing until the reading lands", async () => {
		let release: (answers: Readonly<Record<string, Answer>>) => void = () => {};
		const { systemOne } = fakeSystemOne(() => new Promise((resolve) => (release = resolve)), ["turn"]);
		const host = hostOver(systemOne);

		host.readTurn(turnInput("turn-1"));
		await landed();
		strictEqual(host.hints(), null, "a reader before the reading lands takes nothing");
		strictEqual(host.interpretation(), undefined);
		release(LOUD_TURN);
		await landed();
		ok(host.interpretation() !== undefined, "a fitted reading that landed is held");
	});

	it("leaves hints, interpretation and prewarm empty when the verdict is null", async () => {
		let answers: Readonly<Record<string, Answer>> | null = LOUD_TURN;
		const { systemOne } = fakeSystemOne(() => answers, ["turn"]);
		const host = hostOver(systemOne);

		host.readTurn(turnInput("turn-1"));
		await landed();
		ok(host.interpretation() !== undefined, "the control verdict is held");
		ok(host.prewarm() !== null, "the control verdict would prewarm");

		answers = null;
		host.readTurn(turnInput("turn-2"));
		await landed();
		strictEqual(host.hints(), null);
		strictEqual(host.interpretation(), undefined);
		strictEqual(host.prewarm(), null);
		strictEqual(host.task(), "look at the repo and tell me what it does", "the turn is still held for a later ranking");
	});
});

describe("contracts/system one host: the turn-end reading", () => {
	const input: TurnEndReadInput = {
		userTurnId: "turn-1",
		request: "inspect this",
		message: "I found two choices. Which one should I use?",
		toolNames: ["read", "read", "edit"],
	};

	it("starts one call joined to the turn and returns before the engine answers", () => {
		// The engine never answers: settlement must not wait on it.
		const { calls, systemOne } = fakeSystemOne(() => new Promise(() => {}), ["turnEnd"]);
		hostOver(systemOne).recordTurnEnd(input);
		deepStrictEqual(calls, [{ site: "turnEnd", ref: "turn-1" }]);
	});

	it("asks nothing when the site is unbound", () => {
		const { calls, systemOne } = fakeSystemOne(() => LOUD_TURN, []);
		hostOver(systemOne).recordTurnEnd(input);
		strictEqual(calls.length, 0);
	});
});

describe("contracts/system one host: a shadowed build", () => {
	const NEVER: Script = () => new Promise(() => {});
	const input: TurnEndReadInput = { userTurnId: "turn-1", request: "r", message: "Which one?", toolNames: [] };

	// Each row: what recording says, and how many engine calls the shadowed site makes.
	const rows: Array<[string, (() => boolean) | undefined, number]> = [
		["recording on", () => true, 1],
		["recording unwired", undefined, 1],
		["recording off", () => false, 0],
	];

	for (const [label, recording, made] of rows) {
		it(`makes ${made} turn call with ${label}`, () => {
			const { calls, systemOne } = fakeSystemOne(NEVER, ["turn"], true);
			const host = hostOver(systemOne, recording);
			host.readTurn(turnInput("turn-1"));
			strictEqual(calls.length, made);
			strictEqual(host.hints(), null);
		});

		it(`makes ${made} turn-end call with ${label}`, () => {
			const { calls, systemOne } = fakeSystemOne(NEVER, ["turnEnd"], true);
			hostOver(systemOne, recording).recordTurnEnd(input);
			strictEqual(calls.length, made);
		});
	}
});
