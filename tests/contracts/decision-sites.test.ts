import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import { DECISION_SITES } from "../../src/core/defaults.js";
import { inspectDecisionSite, resolveDecider } from "../../src/domains/providers/decision-sites.js";
import { chosen, isTrue, rating } from "../../src/domains/providers/decisions.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import { askSite } from "../../src/domains/providers/site-ask.js";
import { rankCapabilities } from "../../src/domains/providers/sites/capabilities.js";
import { TURN_SITES } from "../../src/domains/providers/sites/index.js";
import { createTurnRelevanceStore } from "../../src/domains/providers/turn-relevance.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";

const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 5000 };

/** Settings carrying a jev target and the profile a site binds to. */
function settingsWith(decisionProfiles: Record<string, unknown>) {
	return validateSettings({
		targets: [{ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }],
		fleet: {
			profiles: { "system-one": { target: "jev", model: "jev-latest" } },
			decisionProfiles,
		},
	});
}

const noProviders = {} as ProvidersContract;

describe("fleet.decisionProfiles validation", () => {
	it("accepts a site bound to a defined profile", () => {
		const { settings, issues } = settingsWith({ routing: "system-one" });
		deepStrictEqual(issues, []);
		strictEqual(settings.fleet.decisionProfiles.routing, "system-one");
	});

	it("leaves every site unbound by default", () => {
		const { settings } = validateSettings({});
		deepStrictEqual(settings.fleet.decisionProfiles, {});
	});

	// A typo in a site name would otherwise be silently inert, and the operator
	// would be left debugging a feature they believe they enabled.
	it("rejects an unknown decision site by name", () => {
		const { settings, issues } = settingsWith({ rooting: "system-one" });
		ok(issues.some((issue) => /unknown decision site 'rooting'/.test(issue.message)));
		strictEqual(settings.fleet.decisionProfiles.routing, undefined);
	});

	// The binding must fail where the operator wrote it, not later at a call
	// site that cannot explain which line was wrong.
	it("rejects a profile that fleet.profiles does not define", () => {
		const { settings, issues } = settingsWith({ routing: "does-not-exist" });
		ok(issues.some((issue) => /profile 'does-not-exist' is not defined/.test(issue.message)));
		strictEqual(settings.fleet.decisionProfiles.routing, undefined);
	});

	it("rejects a non-map decisionProfiles", () => {
		const { issues } = validateSettings({ fleet: { decisionProfiles: ["routing"] } });
		ok(issues.some((issue) => issue.path === "fleet.decisionProfiles"));
	});

	it("names every site the harness knows", () => {
		deepStrictEqual(
			[...DECISION_SITES],
			["routing", "skills", "memory", "toolRisk", "drafts", "turnScope", "dispatchForecast", "capabilities", "consult"],
		);
	});
});

describe("decision site credentials", () => {
	it("counts credential resolution against the decision timeout", async () => {
		const { settings } = settingsWith({ toolRisk: "system-one" });
		let releaseAuth = () => {};
		const waitingForAuth = new Promise<{ apiKey: string }>((resolve) => {
			releaseAuth = () => resolve({ apiKey: "key" });
		});
		let decisions = 0;
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }),
			getRuntime: () => ({
				...typesafeJev,
				async decide() {
					decisions += 1;
					return { model: "jev", answers: { q: { type: "noul", noul: 0.9 } } };
				},
			}),
			auth: { resolveForTarget: () => waitingForAuth },
		} as unknown as ProvidersContract;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<string>((resolve) => {
			watchdog = setTimeout(() => resolve("still waiting"), 150);
		});
		const question = { q: { type: "noul" as const, instructions: "?", criteria: { true: "yes", false: "no" } } };
		const result = await Promise.race([
			askSite("toolRisk", { settings, providers, ctx: { ...ctx, httpTimeoutMs: 25 } }, {}, question),
			late,
		]);
		clearTimeout(watchdog);
		releaseAuth();
		strictEqual(result, null, "the site should abstain before slow credential resolution completes");
		await new Promise(setImmediate);
		strictEqual(decisions, 0, "a late credential must not start the decision request");
	});

	// A Jev target's key normally lives in the credential store under
	// auth.apiKeyRef, and the sites pass only which env vars are set. Before the
	// decider resolved the stored key, every request went out without it, got a
	// 401, and every site silently fell back as if it were unbound.
	it("sends the target's stored key on every decision", async () => {
		const { settings } = settingsWith({ toolRisk: "system-one" });
		const resolved: string[] = [];
		const providers = {
			getTarget: () => ({
				id: "jev",
				runtime: "typesafe-jev",
				defaultModel: "jev-latest",
				auth: { apiKeyRef: "target:jev" },
			}),
			getRuntime: () => typesafeJev,
			auth: {
				resolveForTarget: async (target: { id: string }) => {
					resolved.push(target.id);
					return { apiKey: "stored-key" };
				},
			},
		} as unknown as ProvidersContract;
		const status = inspectDecisionSite("toolRisk", { settings, providers, ctx });
		ok(status.bound);
		const seen: Array<string | null> = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			seen.push(new Headers(init?.headers).get("authorization"));
			return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			await status.decider.ask(
				{ task: "x" },
				{ q: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } },
			);
			await status.decider.ask(
				{ task: "y" },
				{ q: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } },
			);
		} finally {
			globalThis.fetch = realFetch;
		}
		deepStrictEqual(seen, ["Bearer stored-key", "Bearer stored-key"]);
		deepStrictEqual(resolved, ["jev", "jev"], "the key is read per call, so a rotation applies on the next one");
	});

	// The profile names the model that answers, and the brief records it as the
	// source. The decider sent the target's default instead, so a profile bound
	// to jev-preview was answered by jev-latest and recorded as jev-preview.
	it("asks the model the bound profile names, not the target's default", async () => {
		const settings = validateSettings({
			targets: [{ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }],
			fleet: {
				profiles: {
					"system-one": { target: "jev", model: "jev-preview" },
					"target-default": { target: "jev" },
				},
				decisionProfiles: { toolRisk: "system-one", drafts: "target-default" },
			},
		}).settings;
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }),
			getRuntime: () => typesafeJev,
		} as unknown as ProvidersContract;
		const models: unknown[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			models.push(JSON.parse(String(init?.body)).model);
			return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		const question = { q: { type: "noul" as const, instructions: "?", criteria: { true: "y", false: "n" } } };
		try {
			for (const site of ["toolRisk", "drafts"] as const) {
				const status = inspectDecisionSite(site, { settings, providers, ctx });
				ok(status.bound);
				await status.decider.ask({ task: "x" }, question);
			}
			const bound = inspectDecisionSite("toolRisk", { settings, providers, ctx });
			ok(bound.bound);
			await bound.decider.ask({ task: "x" }, question, { model: "jev-override" });
		} finally {
			globalThis.fetch = realFetch;
		}
		deepStrictEqual(models, ["jev-preview", "jev-latest", "jev-override"]);
	});

	it("posts to the decision endpoint once when the target URL already names it", async () => {
		const target = { id: "jev", runtime: "typesafe-jev", url: "https://api.typesafe.ai/v1/systemone/" };
		const urls: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: unknown) => {
			urls.push(String(url));
			return new Response(JSON.stringify({ answers: { q: { type: "noul", noul: 0.9 } } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch;
		try {
			await typesafeJev.decide?.(
				target as never,
				{ state: {}, questions: { q: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } } },
				ctx,
			);
		} finally {
			globalThis.fetch = realFetch;
		}
		deepStrictEqual(urls, ["https://api.typesafe.ai/v1/systemone"]);
	});
});

describe("decision site resolution", () => {
	// Null is the ordinary case, not a failure: it is what every caller sees
	// until an operator binds the site.
	it("resolves an unbound site to null without consulting providers", () => {
		const { settings } = settingsWith({});
		strictEqual(resolveDecider("routing", { settings, providers: noProviders, ctx }), null);
		deepStrictEqual(inspectDecisionSite("memory", { settings, providers: noProviders, ctx }), {
			bound: false,
			reason: "unbound",
		});
	});

	// Building a probe context reads the credential store. Every host passes it
	// as a function, so an operator with nothing bound pays for no read on any
	// turn, gateway find or approval.
	it("never builds the probe context while nothing is bound", async () => {
		const { settings } = settingsWith({});
		let built = 0;
		const lazy = (): ProbeContext => {
			built += 1;
			return ctx;
		};
		const input = { settings, providers: noProviders, ctx: lazy };
		for (const site of DECISION_SITES) strictEqual(inspectDecisionSite(site, input).bound, false);
		const turn = createTurnRelevanceStore({
			resolve: () => input,
			listMemory: () => [{ id: "m", summary: "a lesson" }],
			listSkills: () => [{ id: "s", summary: "a skill" }],
			sites: TURN_SITES,
		});
		await turn.refresh({ task: "explore this repository", previous: "" });
		strictEqual(turn.current().size, 0);
		strictEqual(
			await rankCapabilities(input, { query: "open a pr", task: "t" }, [{ name: "gh", description: "d" }]),
			null,
		);
		strictEqual(built, 0);

		const bound = settingsWith({ memory: "system-one" }).settings;
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }),
			getRuntime: () => typesafeJev,
		} as unknown as ProvidersContract;
		strictEqual(inspectDecisionSite("memory", { settings: bound, providers, ctx: lazy }).bound, true);
		strictEqual(built, 1);
	});

	it("reports a binding whose profile disappeared", () => {
		const { settings } = settingsWith({ routing: "system-one" });
		delete settings.fleet.profiles["system-one"];
		const status = inspectDecisionSite("routing", { settings, providers: noProviders, ctx });
		strictEqual(status.bound, false);
		strictEqual(status.bound === false ? status.reason : null, "profile-missing");
	});

	it("reports a target that does not resolve", () => {
		const { settings } = settingsWith({ routing: "system-one" });
		const providers = {
			getTarget: () => null,
		} as unknown as ProvidersContract;
		const status = inspectDecisionSite("routing", { settings, providers, ctx });
		strictEqual(status.bound, false);
		strictEqual(status.bound === false ? status.reason : null, "target-unresolved");
	});

	it("reports a runtime the registry does not know", () => {
		const { settings } = settingsWith({ routing: "system-one" });
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev" }),
			getRuntime: () => null,
		} as unknown as ProvidersContract;
		const status = inspectDecisionSite("routing", { settings, providers, ctx });
		strictEqual(status.bound, false);
		strictEqual(status.bound === false ? status.reason : null, "target-unresolved");
	});

	// A System One model advertises `chat: false` by construction, so resolving a
	// decision binding through the conversational target resolver made every Jev
	// target unresolvable and the whole setting inert.
	it("binds a target that does not advertise chat", () => {
		const { settings } = settingsWith({ routing: "system-one" });
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" }),
			getRuntime: () => typesafeJev,
		} as unknown as ProvidersContract;
		strictEqual(typesafeJev.defaultCapabilities.chat, false);
		const status = inspectDecisionSite("routing", { settings, providers, ctx });
		strictEqual(status.bound, true);
		strictEqual(status.bound === true ? status.targetId : null, "jev");
		strictEqual(status.bound === true ? status.model : null, "jev-latest");
		ok(resolveDecider("routing", { settings, providers, ctx }));
	});

	// Declaring the capability and implementing the verb are separate claims, and
	// a target bound here by mistake is likelier to be an ordinary chat model.
	it("refuses a runtime that declares decisions but has no decide verb", () => {
		const { decide: _decide, ...withoutVerb } = typesafeJev;
		const { settings } = settingsWith({ routing: "system-one" });
		const providers = {
			getTarget: () => ({ id: "jev", runtime: "typesafe-jev" }),
			getRuntime: () => withoutVerb,
		} as unknown as ProvidersContract;
		const status = inspectDecisionSite("routing", { settings, providers, ctx });
		strictEqual(status.bound, false);
		strictEqual(status.bound === false ? status.reason : null, "runtime-cannot-decide");
	});
});

describe("answer certainty", () => {
	// The live wire response omits `confidence` on a noul entirely. Reading it
	// as zero made every minConfidence check abstain unconditionally.
	it("derives a noul's certainty from its distance off the coin-flip", () => {
		strictEqual(isTrue({ type: "noul", noul: 0.82 }, { minConfidence: 0.5 }), true);
		strictEqual(isTrue({ type: "noul", noul: 0.18 }, { minConfidence: 0.5 }), false);
		strictEqual(isTrue({ type: "noul", noul: 0.55 }, { minConfidence: 0.5 }), null);
	});

	// A two-option choice at mass p and a noul at p describe the same
	// distribution, so they must report the same certainty.
	it("agrees with a two-option choice at the same mass", () => {
		const half = { type: "choice" as const, choice: "yes", confidence: 0.3, probabilities: { yes: 0.65, no: 0.35 } };
		strictEqual(chosen(half, { minConfidence: 0.3 }), "yes");
		strictEqual(isTrue({ type: "noul", noul: 0.65 }, { minConfidence: 0.3 }), true);
		strictEqual(chosen(half, { minConfidence: 0.31 }), null);
		strictEqual(isTrue({ type: "noul", noul: 0.65 }, { minConfidence: 0.31 }), null);
	});

	it("uses the distribution for choice and score certainty across provider scales", () => {
		const uncertainChoice = {
			type: "choice" as const,
			choice: "yes",
			probabilities: { yes: 0.52, no: 0.48 },
			confidence: 0.99,
		};
		strictEqual(chosen(uncertainChoice, { minConfidence: 0.2 }), null);
		const decisiveChoice = {
			...uncertainChoice,
			probabilities: { yes: 0.8, no: 0.2 },
			confidence: 0.1,
		};
		strictEqual(chosen(decisiveChoice, { minConfidence: 0.5 }), "yes");
		strictEqual(
			rating(
				{ type: "score", score: 0.48, probabilities: { "0": 0.52, "1": 0.48 }, confidence: 0.99 },
				{ minConfidence: 0.2 },
			),
			null,
		);
	});

	it("still reads an explicit confidence when the answer carries one", () => {
		strictEqual(rating({ type: "score", score: 0.81, confidence: 0.28 }, { minConfidence: 0.5 }), null);
		strictEqual(rating({ type: "score", score: 0.81, confidence: 0.28 }, { minConfidence: 0.2 }), 0.81);
	});

	// laya-serve speaks this wire and puts `confidence: max(p, 1 - p)` on every
	// noul, a scale that never drops below 0.5. Read as certainty, a 0.52 cleared
	// every abstention floor, and live every skill scored as an opinion.
	it("reads a wire noul's certainty from its probability, ignoring a reported confidence", async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify({
					model: "laya-rl-agent",
					answers: {
						near: { type: "noul", noul: 0.52, confidence: 0.52 },
						sure: { type: "noul", noul: 0.91, confidence: 0.91 },
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			)) as typeof fetch;
		let answers: Awaited<ReturnType<NonNullable<typeof typesafeJev.decide>>>["answers"];
		try {
			const question = { type: "noul" as const, instructions: "?", criteria: { true: "y", false: "n" } };
			const result = await typesafeJev.decide?.(
				{ id: "laya", runtime: "typesafe-jev", url: "http://127.0.0.1:8000/v1" } as never,
				{ state: {}, questions: { near: question, sure: question } },
				ctx,
			);
			ok(result);
			answers = result.answers;
		} finally {
			globalThis.fetch = realFetch;
		}
		strictEqual(answers.near?.confidence, undefined);
		strictEqual(isTrue(answers.near, { minConfidence: 0.2 }), null);
		strictEqual(isTrue(answers.sure, { minConfidence: 0.2 }), true);
	});
});
