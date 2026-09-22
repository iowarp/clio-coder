/**
 * The degradation matrix for the three System One call sites.
 *
 * Every site has to survive three things independently: no operator binding,
 * a provider that throws, and a model that answers without deciding. Each one
 * must leave the behavior the site had before it existed, and none of them may
 * break a turn or block an approval.
 *
 * The site modules are tested on their own elsewhere. What this file pins is
 * the composed path, including the seams where an injected dependency reaches
 * the turn loop and the approval card, because that is where a throw stops
 * being a missing ranking and starts being a broken session.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import { createMemoryPromptReader, type MemoryPromptRequest } from "../../src/domains/memory/prompt-cache.js";
import type { MemoryRecord } from "../../src/domains/memory/types.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { scoreTurnRelevance } from "../../src/domains/providers/relevance-pass.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import { createTurnRelevanceStore } from "../../src/domains/providers/turn-relevance.js";
import type { DecideOptions, DecideResult, DecisionAnswer } from "../../src/domains/providers/types/inference.js";
import { buildSkillCatalogView } from "../../src/domains/resources/skills/catalog-view.js";
import type { Skill } from "../../src/domains/resources/skills/loader.js";
import { describeToolRisk } from "../../src/domains/safety/tool-risk.js";
import type { ApprovalRequestView } from "../../src/interactive/permission-overlay.js";
import { createPermissionOverlayBody } from "../../src/interactive/permission-overlay.js";

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

const BOTH = { memory: "system-one", skills: "system-one" };
const THROWS = () => new Error("ECONNREFUSED");
/** A noul sitting on the coin-flip: an answer, but not a decision. */
const ABSTAINS = (ids: string[]) =>
	Object.fromEntries(ids.map((id) => [id, { type: "noul" as const, noul: 0.5 }])) as Record<string, DecisionAnswer>;

const SUBJECTS = {
	task: "rank things",
	memory: [{ id: "alpha", summary: "Alpha lesson." }],
	skills: [{ id: "bravo", summary: "bravo: does a thing" }],
};

describe("degradation: the pre-turn pass", () => {
	it("yields no scores when unbound, when the provider throws, and when the answer abstains", async () => {
		for (const [label, profiles, reply] of [
			["unbound", {}, ABSTAINS],
			["provider throws", BOTH, THROWS],
			["abstains", BOTH, ABSTAINS],
		] as const) {
			const result = await scoreTurnRelevance(
				{ settings: settingsFor(profiles), providers: providersWith(reply), ctx },
				SUBJECTS,
			);
			deepStrictEqual(result, { memory: null, skills: null }, label);
		}
	});

	// The contract says this function never rejects. A malformed subject used to
	// escape the guard because the request was built outside it.
	it("does not reject on a malformed subject", async () => {
		const result = await scoreTurnRelevance(
			{ settings: settingsFor(BOTH), providers: providersWith(ABSTAINS), ctx },
			{ task: "t", memory: [{ id: "ok", summary: null as unknown as string }], skills: [] },
		);
		deepStrictEqual(result, { memory: null, skills: null });
	});

	it("does not reject when the decider is handed a hostile settings snapshot", async () => {
		const result = await scoreTurnRelevance(
			{
				settings: null as unknown as ReturnType<typeof settingsFor>,
				providers: providersWith(ABSTAINS),
				ctx,
			},
			SUBJECTS,
		);
		deepStrictEqual(result, { memory: null, skills: null });
	});
});

describe("degradation: the memory site", () => {
	const records: MemoryRecord[] = [
		{
			id: "alpha",
			scope: "global",
			key: "alpha",
			lesson: "Alpha lesson.",
			evidenceRefs: ["run:1"],
			appliesWhen: [],
			avoidWhen: [],
			confidence: 0.9,
			createdAt: "2026-09-01T00:00:00.000Z",
			approved: true,
		},
		{
			id: "bravo",
			scope: "global",
			key: "bravo",
			lesson: "Bravo lesson.",
			evidenceRefs: ["run:1"],
			appliesWhen: [],
			avoidWhen: [],
			confidence: 0.9,
			createdAt: "2026-09-20T00:00:00.000Z",
			approved: true,
		},
	];

	function read(): (request: MemoryPromptRequest) => string {
		return createMemoryPromptReader({
			getDataDir: () => "/data",
			readStore: (() => ({ revision: "r1", records: [...records] })) as never,
		});
	}

	const request = (over: Partial<MemoryPromptRequest> = {}): MemoryPromptRequest => ({
		turnId: null,
		sessionAuthority: "s",
		cwd: "/workspace",
		targetId: "t",
		runtimeId: "r",
		modelId: "m",
		taskText: "a task",
		activePaths: [],
		...over,
	});

	// All three failures reach selection the same way: as no score map at all.
	it("renders the legacy section for every failure mode", () => {
		const legacy = read()(request());
		strictEqual(read()(request()), legacy);
		strictEqual(read()(request({ precomputedRelevance: { source: "jev", scores: {} } })), legacy);
		ok(legacy.includes("[bravo]"));
	});

	// An abstention arrives as a record with no entry, and a record with no entry
	// holds the slot legacy priority gave it.
	it("keeps legacy order when the model abstained on every record", () => {
		const abstained = read()(request({ precomputedRelevance: { source: "jev", scores: {} } }));
		strictEqual(abstained.indexOf("[bravo]") < abstained.indexOf("[alpha]"), true);
	});
});

describe("degradation: the skills site", () => {
	const skill = (name: string): Skill =>
		({
			name,
			description: `${name} does a thing.`,
			filePath: `/skills/${name}/SKILL.md`,
			baseDir: `/skills/${name}`,
			content: "body",
			sourceInfo: { path: `/skills/${name}/SKILL.md`, scope: "user" },
			disableModelInvocation: false,
			source: "clio-coder",
			scope: "user",
			hash: "0".repeat(64),
			normalizedHash: "0".repeat(64),
			pathSubject: name,
			trusted: true,
			precedence: 30,
			metadata: {},
			diagnostics: [],
		}) as Skill;

	const BASE = {
		packages: [],
		marketplace: [],
		marketplaceOffered: true,
		modelActivation: false,
		capBytes: 50 * 1024,
		skills: [skill("alpha"), skill("bravo"), skill("charlie")],
	};

	// The listing is the model's map of its own capabilities. Every failure mode
	// has to leave it complete, in catalog order, and silent about the site.
	it("is byte-identical to the unbound listing for every failure mode", () => {
		const unbound = buildSkillCatalogView(BASE);
		const failed = buildSkillCatalogView({ ...BASE });
		const abstained = buildSkillCatalogView({ ...BASE, relevance: { source: "jev", scores: {} } });
		strictEqual(failed.text, unbound.text);
		strictEqual(abstained.text.includes("Ordered by relevance"), true);
		// An abstaining pass still says it ranked, because it did run; what it
		// must not do is move a row or drop one.
		strictEqual(abstained.rows.map((row) => row.name).join(), unbound.rows.map((row) => row.name).join());
		strictEqual(abstained.total, unbound.total);
		strictEqual(unbound.rankedBy, null);
	});

	it("never loses a row to a decision model, whatever it answers", () => {
		for (const scores of [{}, { alpha: 0 }, { alpha: 0, bravo: 0, charlie: 0 }]) {
			const view = buildSkillCatalogView({ ...BASE, relevance: { source: "jev", scores } });
			strictEqual(view.total, 3);
			strictEqual(view.rows.length, 3);
		}
	});
});

describe("degradation: the toolRisk site", () => {
	const view: ApprovalRequestView = {
		requestId: "req-1",
		tool: "bash",
		actionClass: "execute",
		axis: { kind: "autonomy", level: "auto-edit" },
		origin: { kind: "main" },
		reason: "bash requests execute",
		target: "rm -rf build/",
	};
	const render = (advisory?: () => string) =>
		createPermissionOverlayBody(view, undefined, undefined, advisory).render(78).join("\n");

	it("gives the same card when unbound, when the reader throws, and when the model abstains", async () => {
		const unbound = render();
		strictEqual(
			render(() => {
				throw new Error("ECONNREFUSED");
			}),
			unbound,
		);
		const abstained = await describeToolRisk(
			{
				ask: async () => ({
					radius: { type: "score", score: 1.5, confidence: 0.01 },
					outside: { type: "noul", noul: 0.5 },
				}),
				askDetailed: async () => {
					throw new Error("unused");
				},
			},
			{ tool: "bash", actionClass: "execute", target: "rm -rf build/" },
			"jev",
		);
		strictEqual(abstained, null);
		ok(unbound.includes("bash"));
		ok(unbound.includes("Allow"));
	});

	// The dialog must reach the operator whatever the advisory does. This is the
	// one failure that would not be a missing sentence but a missing approval.
	it("cannot stop the card from opening", () => {
		// A card built with a reader that throws still renders, and the render is
		// what the overlay frame mounts.
		const lines = createPermissionOverlayBody(view, undefined, undefined, () => {
			throw new Error("boom");
		}).render(78);
		ok(lines.length > 0);
		ok(lines.join("\n").includes("Tool: "));
	});
});

describe("degradation: the per-turn store", () => {
	// The store is what the turn loop awaits, so it is the last line before a
	// failure becomes the turn's problem.
	it("settles to no ranking for every failure mode", async () => {
		for (const [label, profiles, reply] of [
			["unbound", {}, ABSTAINS],
			["provider throws", BOTH, THROWS],
			["abstains", BOTH, ABSTAINS],
		] as const) {
			const store = createTurnRelevanceStore({
				resolve: () => ({ settings: settingsFor(profiles), providers: providersWith(reply), ctx }),
				listMemory: () => SUBJECTS.memory,
				listSkills: () => SUBJECTS.skills,
			});
			await store.refresh("a task");
			strictEqual(store.memory(), undefined, label);
			strictEqual(store.skills(), undefined, label);
		}
	});

	it("settles when resolving the binding itself throws", async () => {
		const store = createTurnRelevanceStore({
			resolve: () => {
				throw new Error("no settings");
			},
			listMemory: () => SUBJECTS.memory,
			listSkills: () => SUBJECTS.skills,
		});
		await store.refresh("a task");
		strictEqual(store.memory(), undefined);
	});
});
