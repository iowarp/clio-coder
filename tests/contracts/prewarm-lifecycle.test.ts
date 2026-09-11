import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import llamacpp from "../../src/domains/providers/runtimes/local-native/llamacpp.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { PrewarmRoundInput, PrewarmRoundResult } from "../../src/engine/prewarm.js";
import type { TurnContext } from "../../src/interactive/turn-context.js";
import { createTurnPrewarm } from "../../src/interactive/turn-prewarm.js";
import { type AgentRuntime, createTurnState } from "../../src/interactive/turn-state.js";

function fixture() {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = true;
	settings.chat.target = "local";
	const target = { id: "local", runtime: "llamacpp", url: "https://fixture.invalid" };
	const model = llamacpp.synthesizeModel(target, "fixture", null);
	const { agent } = createEngineAgent({ initialState: { model, thinkingLevel: "off" } });
	const runtime = { agent, targetId: target.id, runtimeId: target.runtime, wireModelId: model.id } as AgentRuntime;
	const rounds: Array<{ input: PrewarmRoundInput; finish: (value: PrewarmRoundResult) => void }> = [];
	let reservations = 0;
	let recorded = 0;
	let visible = 0;
	const warm = createTurnPrewarm({
		state: createTurnState("off"),
		getSettings: () => settings,
		providers: { getTarget: () => target, getRuntime: () => llamacpp } as unknown as ProvidersContract,
		context: {
			ensureSessionPrompt: async () => {},
			notePrewarm: () => {
				visible += 1;
			},
		} as unknown as TurnContext,
		isLatencySurface: () => true,
		isTurnActive: () => false,
		hasActiveDispatch: () => false,
		prepareRuntime: async () => ({ ok: true, runtime, apiKey: "fixture" }),
		applySessionTools: () => {},
		recordUsage: () => {
			recorded += 1;
		},
		registerEndpointSlot: () => {
			reservations += 1;
			return () => {
				reservations -= 1;
			};
		},
		runPrewarm: (input) =>
			new Promise((finish) => {
				rounds.push({ input, finish });
			}),
	});
	return { warm, rounds, counts: () => ({ reservations, recorded, visible }) };
}

const completed: PrewarmRoundResult = {
	aborted: false,
	usage: null,
	backend: null,
	timing: { ttftMs: null, apiMs: 1 },
	errorMessage: null,
};

test("detached warming retains ownership and collapses repeated triggers to one latest round", async () => {
	const f = fixture();
	try {
		f.warm.schedule("session-start");
		await delay(10);
		strictEqual(f.rounds.length, 1);
		for (let i = 0; i < 10; i += 1) {
			f.warm.schedule("resume");
			await delay(1);
		}
		strictEqual(f.rounds.length, 1);
		strictEqual(f.counts().reservations, 1);
		strictEqual(f.rounds[0]?.input.signal?.aborted, false, "detach is not backend cancellation");
		f.warm.schedule("compaction");
		f.rounds[0]?.finish(completed);
		await delay(10);
		strictEqual(f.rounds.length, 2);
		deepStrictEqual(f.counts(), { reservations: 1, recorded: 1, visible: 0 });
		f.rounds[1]?.finish(completed);
		deepStrictEqual(await f.warm.settled(), { ran: true, trigger: "compaction" });
		deepStrictEqual(f.counts(), { reservations: 0, recorded: 2, visible: 1 });
	} finally {
		f.warm.dispose();
	}
});

test("shutdown aborts detached work and forbids later schedules without releasing its reservation early", async () => {
	const f = fixture();
	f.warm.schedule("resume");
	await delay(10);
	f.warm.cancel();
	f.warm.dispose();
	strictEqual(f.rounds[0]?.input.signal?.aborted, true);
	strictEqual(f.counts().reservations, 1);
	f.warm.schedule("resume");
	f.rounds[0]?.finish({ ...completed, aborted: true });
	await f.warm.settled();
	strictEqual(f.rounds.length, 1);
	deepStrictEqual(f.counts(), { reservations: 0, recorded: 1, visible: 0 });
});
