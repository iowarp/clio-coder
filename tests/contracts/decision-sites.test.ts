import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { validateSettings } from "../../src/core/config.js";
import { DECISION_SITES } from "../../src/core/defaults.js";
import { inspectDecisionSite, resolveDecider } from "../../src/domains/providers/decision-sites.js";
import { chosen, isTrue, rating } from "../../src/domains/providers/decisions.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
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
		deepStrictEqual([...DECISION_SITES], ["routing", "skills", "memory", "toolRisk"]);
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

	it("still reads an explicit confidence when the answer carries one", () => {
		strictEqual(rating({ type: "score", score: 0.81, confidence: 0.28 }, { minConfidence: 0.5 }), null);
		strictEqual(rating({ type: "score", score: 0.81, confidence: 0.28 }, { minConfidence: 0.2 }), 0.81);
	});
});
