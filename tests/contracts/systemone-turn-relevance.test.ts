import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import type { RelevanceSubject } from "../../src/domains/providers/relevance-pass.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import { createTurnRelevanceStore } from "../../src/domains/providers/turn-relevance.js";
import type { DecideOptions, DecideResult, DecisionAnswer } from "../../src/domains/providers/types/inference.js";

const ctx = { credentialsPresent: new Set<string>(), httpTimeoutMs: 5000 };

function providersWith(reply: (ids: string[]) => Record<string, DecisionAnswer> | Error): ProvidersContract {
	return {
		getTarget: () => ({ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }),
		getRuntime: () => ({
			...typesafeJev,
			async decide(_target: unknown, opts: DecideOptions): Promise<DecideResult> {
				const answers = reply(Object.keys(opts.questions));
				if (answers instanceof Error) throw answers;
				return { model: "jev-1.13.0", answers };
			},
		}),
	} as unknown as ProvidersContract;
}

function settingsFor(decisionProfiles: Record<string, string>) {
	return validateSettings({
		targets: [{ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }],
		fleet: { profiles: { "system-one": { target: "jev", model: "jev-latest" } }, decisionProfiles },
	}).settings;
}

const MEMORY: RelevanceSubject[] = [{ id: "m1", summary: "A lesson." }];
const SKILLS: RelevanceSubject[] = [{ id: "run", summary: "run: start the app" }];

interface Reads {
	memory: number;
	skills: number;
}

function storeFor(
	decisionProfiles: Record<string, string>,
	reply: (ids: string[]) => Record<string, DecisionAnswer> | Error,
	reads: Reads = { memory: 0, skills: 0 },
) {
	return {
		reads,
		store: createTurnRelevanceStore({
			resolve: () => ({ settings: settingsFor(decisionProfiles), providers: providersWith(reply), ctx }),
			listMemory: () => {
				reads.memory += 1;
				return MEMORY;
			},
			listSkills: () => {
				reads.skills += 1;
				return SKILLS;
			},
		}),
	};
}

const noul = (value: number): DecisionAnswer => ({ type: "noul", noul: value });
const answerAll = (ids: string[]) => Object.fromEntries(ids.map((id) => [id, noul(0.9)]));

describe("per-turn relevance store", () => {
	it("holds scores for both readers after one refresh", async () => {
		const { store } = storeFor({ memory: "system-one", skills: "system-one" }, answerAll);
		strictEqual(store.memory(), undefined);
		await store.refresh("a task");
		deepStrictEqual(store.memory()?.scores, { m1: 0.9 });
		deepStrictEqual(store.skills()?.scores, { run: 0.9 });
	});

	// Reading the memory store and loading every skill are the expensive part.
	// An operator who bound nothing must not pay for them once a turn.
	it("reads neither catalog when no site is bound", async () => {
		const { store, reads } = storeFor({}, answerAll);
		await store.refresh("a task");
		deepStrictEqual(reads, { memory: 0, skills: 0 });
		strictEqual(store.memory(), undefined);
	});

	it("reads only the catalog whose site is bound", async () => {
		const { store, reads } = storeFor({ memory: "system-one" }, answerAll);
		await store.refresh("a task");
		deepStrictEqual(reads, { memory: 1, skills: 0 });
		strictEqual(store.skills(), undefined);
	});

	// Last turn's scores are wrong for this one. They go before the new ones
	// arrive, so a failed pass cannot leave a stale ranking behind.
	it("clears the previous turn's scores when a refresh fails", async () => {
		let fail = false;
		const { store } = storeFor({ memory: "system-one" }, (ids) => (fail ? new Error("down") : answerAll(ids)));
		await store.refresh("first");
		deepStrictEqual(store.memory()?.scores, { m1: 0.9 });
		fail = true;
		await store.refresh("second");
		strictEqual(store.memory(), undefined);
	});

	// The store sits on the turn's critical path, so it must settle whatever the
	// subject readers or the settings snapshot do.
	it("settles when a subject reader throws", async () => {
		const store = createTurnRelevanceStore({
			resolve: () => ({ settings: settingsFor({ memory: "system-one" }), providers: providersWith(answerAll), ctx }),
			listMemory: () => {
				throw new Error("store unreadable");
			},
			listSkills: () => [],
		});
		await store.refresh("a task");
		strictEqual(store.memory(), undefined);
	});

	it("settles when the host has no settings snapshot yet", async () => {
		const store = createTurnRelevanceStore({ resolve: () => null, listMemory: () => MEMORY, listSkills: () => SKILLS });
		await store.refresh("a task");
		strictEqual(store.memory(), undefined);
		strictEqual(store.skills(), undefined);
	});

	it("drops its scores on clear", async () => {
		const { store } = storeFor({ memory: "system-one", skills: "system-one" }, answerAll);
		await store.refresh("a task");
		store.clear();
		strictEqual(store.memory(), undefined);
		strictEqual(store.skills(), undefined);
	});
});
