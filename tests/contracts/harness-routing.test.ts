import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { runPreTurnBrief } from "../../src/domains/providers/pre-turn-brief.js";
import { relevanceSite } from "../../src/domains/providers/relevance-pass.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import { createHarnessRoutingSite, type HarnessCandidate } from "../../src/domains/providers/sites/harness-routing.js";
import { turnScopeSite } from "../../src/domains/providers/sites/turn-scope.js";
import type { DecideOptions, DecisionAnswer } from "../../src/domains/providers/types/inference.js";

function fixture(bound = true) {
	const calls: DecideOptions[] = [];
	const runtime = {
		...typesafeJev,
		async decide(_target: unknown, options: DecideOptions) {
			calls.push(options);
			return {
				model: "fixture",
				answers: Object.fromEntries(
					Object.keys(options.questions).map((id) => [
						id,
						id === "harnessRouting.intent"
							? { type: "choice", choice: "inspect", probabilities: { inspect: 0.96, implement: 0.04 } }
							: { type: "noul", noul: 0.9 },
					]),
				) as Record<string, DecisionAnswer>,
			};
		},
	};
	const settings = validateSettings({
		targets: [{ id: "s1", runtime: "typesafe-jev", defaultModel: "fixture" }],
		fleet: {
			profiles: { router: { target: "s1", model: "fixture" } },
			decisionProfiles: bound ? { harnessRouting: "router", turnScope: "router", skills: "router" } : {},
		},
	}).settings;
	return {
		calls,
		input: {
			settings,
			providers: {
				getTarget: () => ({ id: "s1", runtime: "typesafe-jev", defaultModel: "fixture" }),
				getRuntime: () => runtime,
			} as unknown as ProvidersContract,
			ctx: { credentialsPresent: new Set<string>(), httpTimeoutMs: 1000 },
		},
	};
}

describe("optional System One harness routing foundation", () => {
	it("does no catalog work or inference when unbound", async () => {
		const { calls, input } = fixture(false);
		let lists = 0;
		const site = createHarnessRoutingSite(() => {
			lists++;
			return [];
		});
		const brief = await runPreTurnBrief(input, [site], { task: "hi" });
		strictEqual(brief.size, 0);
		strictEqual(lists, 0);
		strictEqual(calls.length, 0);
	});

	it("batches intent and mixed-catalog relevance with existing turn decisions", async () => {
		const { calls, input } = fixture();
		const candidates: HarnessCandidate[] = [
			{ kind: "tool", id: "code_nav", description: "Navigate symbols." },
			{ kind: "agent", id: "scout", description: "Explore repositories." },
			{ kind: "skill", id: "debug", description: "Diagnose failures." },
		];
		const site = createHarnessRoutingSite(() => candidates);
		const skillSite = relevanceSite("skills", () => [{ id: "tool:code_nav", summary: "A distinct skill summary." }]);
		const brief = await runPreTurnBrief(input, [site, turnScopeSite, skillSite], {
			task: "Inspect this failure",
			previous: "I proposed investigation",
		});
		strictEqual(calls.length, 1);
		ok(Object.hasOwn(calls[0]?.questions ?? {}, "turnScope.direct"));
		const state = calls[0]?.state as { harnessCandidates: Record<string, string>; candidates: Record<string, string> };
		strictEqual(state.harnessCandidates["tool:code_nav"], "Navigate symbols.");
		strictEqual(state.candidates["tool:code_nav"], "A distinct skill summary.");
		const answer = brief.get("harnessRouting");
		ok(answer);
		strictEqual(answer.source, "s1/fixture");
		const routing = answer.value as ReturnType<typeof site.read>;
		ok(routing);
		strictEqual(routing.intent, "inspect");
		strictEqual(routing.shortlist.length, 3);
		deepStrictEqual(new Set(routing.shortlist.map((candidate) => candidate.kind)), new Set(["tool", "skill", "agent"]));
		match(site.hint?.(routing) ?? "", /advisory and incomplete/u);
		match(site.hint?.(routing) ?? "", /grants no authority/u);
	});

	it("caps the scored pool and shortlist while retrieving relevant tail candidates from a thousand entries", () => {
		const candidates: HarnessCandidate[] = Array.from({ length: 1000 }, (_, index) => ({
			kind: "tool",
			id: `item_${String(index).padStart(4, "0")}`,
			description: index === 999 ? "Specialized boundary condition investigation." : "Generic unrelated data.",
		}));
		const site = createHarnessRoutingSite(() => candidates);
		const ask = site.prepare({ task: "boundary condition", previous: "" });
		ok(ask);
		strictEqual(Object.keys(ask.questions).length, 257);
		ok(Object.hasOwn(ask.state?.harnessCandidates ?? {}, "tool:item_0999"));
		const routing = site.read(
			Object.fromEntries(
				Object.keys(ask.questions).map((id) => [
					id,
					id === "intent" ? { type: "choice", choice: "inspect", confidence: 0.9 } : { type: "noul", noul: 0.9 },
				]),
			) as Record<string, DecisionAnswer>,
			ask,
		);
		ok(routing);
		strictEqual(routing.catalogSize, 1000);
		strictEqual(routing.shortlist.length, 10);
	});

	it("abstains on uncertain intent and ignores unknown or malformed candidate scores", () => {
		const site = createHarnessRoutingSite(() => [{ kind: "tool", id: "read", description: "Read a file." }]);
		const ask = site.prepare({ task: "okay", previous: "" });
		ok(ask);
		for (const confidence of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2]) {
			strictEqual(site.read({ intent: { type: "choice", choice: "implement", confidence } }, ask), null);
		}
		strictEqual(
			site.read(
				{
					intent: { type: "choice", choice: "implement", confidence: 0.2 },
					"candidate:tool:invented": { type: "noul", noul: 1 },
					"candidate:tool:read": { type: "noul", noul: Number.NaN },
				},
				ask,
			),
			null,
		);
		const routing = site.read(
			{
				intent: { type: "choice", choice: "invented", confidence: 1 },
				"candidate:tool:read": { type: "noul", noul: 0.9 },
			},
			ask,
		);
		ok(routing);
		strictEqual(routing.intent, "unknown");
		deepStrictEqual(
			routing.shortlist.map((candidate) => candidate.id),
			["read"],
		);
	});
});
