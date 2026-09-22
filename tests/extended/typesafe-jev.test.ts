import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { chosen, createDecider, isTrue, pick, rate, rating, yesNo } from "../../src/domains/providers/decisions.js";
import typesafeJev from "../../src/domains/providers/runtimes/cloud/typesafe-jev.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../src/domains/providers/types/target-descriptor.js";

const ctx: ProbeContext = { credentialsPresent: new Set(), httpTimeoutMs: 5000, authToken: "test-key" };

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

interface Captured {
	url: string;
	body: unknown;
	headers: Record<string, string>;
}

/** Stub global fetch with a fixed reply, recording what the runtime sent. */
function stubFetch(reply: () => Response): Captured {
	const captured: Captured = { url: "", body: null, headers: {} };
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		captured.url = String(input);
		captured.headers = (init?.headers ?? {}) as Record<string, string>;
		if (typeof init?.body === "string") captured.body = JSON.parse(init.body);
		return reply();
	}) as typeof fetch;
	return captured;
}

function json(value: unknown): Response {
	return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

const jevTarget: TargetDescriptor = { id: "jev", runtime: "typesafe-jev", defaultModel: "jev-latest" };

describe("typesafe-jev decide()", () => {
	// Recorded verbatim from api.typesafe.ai so the parser is pinned to the
	// real wire shape rather than to the documented one.
	const liveResponse = {
		model: "jev-1.13.0",
		answers: {
			route: {
				type: "choice",
				choice: "security",
				confidence: 1.0,
				probabilities: { security: 1.0, scout: 0.0, coder: 0.0 },
			},
			risk: {
				type: "score",
				score: 1.43,
				confidence: 0.35,
				legend: { "0": "Trivial", "1": "Moderate", "2": "Dangerous" },
				probabilities: { "0": 0.0, "1": 0.57, "2": 0.43 },
			},
			urgent: { type: "noul", noul: 0.65 },
		},
		usage: { input_tokens: 394, output_tokens: 53 },
	};

	const questions = {
		route: pick("Which worker takes this?", { scout: "Triage", coder: "Edits", security: "Auth" }),
		risk: rate("How risky?", ["Trivial", "Moderate", "Dangerous"]),
		urgent: yesNo("Is it urgent?", "Time-sensitive", "Not"),
	};

	it("parses every answer shape and reports usage", async () => {
		const captured = stubFetch(() => json(liveResponse));
		const result = await typesafeJev.decide?.(jevTarget, { state: "a diff", questions }, ctx);
		ok(result);
		strictEqual(result.model, "jev-1.13.0");
		deepStrictEqual(result.tokensUsed, { input: 394, output: 53 });

		strictEqual(result.answers.route?.choice, "security");
		deepStrictEqual(result.answers.route?.probabilities, { security: 1, scout: 0, coder: 0 });
		strictEqual(result.answers.risk?.score, 1.43);
		deepStrictEqual(result.answers.risk?.legend, { "0": "Trivial", "1": "Moderate", "2": "Dangerous" });
		strictEqual(result.answers.urgent?.noul, 0.65);

		strictEqual(captured.url, "https://api.typesafe.ai/v1/systemone");
		const body = captured.body as { model: string; state: string; questions: Record<string, unknown> };
		strictEqual(body.model, "jev-latest");
		strictEqual(body.state, "a diff");
		deepStrictEqual(Object.keys(body.questions).sort(), ["risk", "route", "urgent"]);
		strictEqual(captured.headers.authorization, "Bearer test-key");
	});

	it("sends a structured state unchanged", async () => {
		const captured = stubFetch(() => json({ ...liveResponse, answers: { urgent: { type: "noul", noul: 0.9 } } }));
		await typesafeJev.decide?.(
			jevTarget,
			{ state: { files: 3, tests: 0 }, questions: { urgent: questions.urgent } },
			ctx,
		);
		deepStrictEqual((captured.body as { state: unknown }).state, { files: 3, tests: 0 });
	});

	it("honours a per-call model override", async () => {
		const captured = stubFetch(() => json({ ...liveResponse, answers: { urgent: { type: "noul", noul: 0.1 } } }));
		await typesafeJev.decide?.(
			jevTarget,
			{ state: "s", questions: { urgent: questions.urgent }, model: "jev-preview" },
			ctx,
		);
		strictEqual((captured.body as { model: string }).model, "jev-preview");
	});

	// A caller gating dispatch on a decision must never receive a defaulted one.
	it("throws when an answer is missing", async () => {
		stubFetch(() => json({ model: "jev-1.13.0", answers: {} }));
		await rejects(
			() =>
				typesafeJev.decide?.(jevTarget, { state: "s", questions: { urgent: questions.urgent } }, ctx) as Promise<unknown>,
			(error: Error) => {
				match(error.message, /no usable answer for: urgent/);
				return true;
			},
		);
	});

	it("throws when an answer has an unrecognised type", async () => {
		stubFetch(() => json({ model: "jev-1.13.0", answers: { urgent: { type: "vibes", value: 1 } } }));
		await rejects(
			() =>
				typesafeJev.decide?.(jevTarget, { state: "s", questions: { urgent: questions.urgent } }, ctx) as Promise<unknown>,
			/no usable answer/,
		);
	});

	it("rejects an empty question set before hitting the network", async () => {
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return json({});
		}) as typeof fetch;
		await rejects(
			() => typesafeJev.decide?.(jevTarget, { state: "s", questions: {} }, ctx) as Promise<unknown>,
			/at least one question/,
		);
		strictEqual(called, false);
	});

	it("lists models with their descriptions", async () => {
		stubFetch(() =>
			json({
				models: [
					{ name: "jev-latest", description: "The latest iteration" },
					{ name: "jev-preview", description: "A preview version" },
				],
			}),
		);
		const result = await typesafeJev.probe?.(jevTarget, ctx);
		ok(result?.ok);
		deepStrictEqual(result.models, ["jev-latest", "jev-preview"]);
		strictEqual(result.modelLabels?.["jev-latest"], "The latest iteration");
	});

	it("is not a chat target", () => {
		strictEqual(typesafeJev.defaultCapabilities.chat, false);
		strictEqual(typesafeJev.defaultCapabilities.decisions, true);
		strictEqual(typesafeJev.hidden, true);
	});
});

describe("createDecider", () => {
	it("binds a runtime and returns answers without the envelope", async () => {
		stubFetch(() => json({ model: "jev-1.13.0", answers: { urgent: { type: "noul", noul: 0.7 } } }));
		const decider = createDecider(typesafeJev, jevTarget, ctx);
		const answers = await decider.ask("s", { urgent: yesNo("Urgent?", "Yes", "No") });
		strictEqual(answers.urgent?.noul, 0.7);
	});

	it("keeps the resolved model and usage on the detailed call", async () => {
		stubFetch(() =>
			json({
				model: "jev-1.13.0",
				answers: { urgent: { type: "noul", noul: 0.2 } },
				usage: { input_tokens: 11, output_tokens: 3 },
			}),
		);
		const result = await createDecider(typesafeJev, jevTarget, ctx).askDetailed("s", {
			urgent: yesNo("Urgent?", "Yes", "No"),
		});
		strictEqual(result.model, "jev-1.13.0");
		deepStrictEqual(result.tokensUsed, { input: 11, output: 3 });
	});

	// A misconfigured target must fail at the binding, not halfway through
	// whatever the caller was gating on the answer.
	it("refuses a runtime that cannot decide", () => {
		const { decide: _decide, ...chatOnly } = typesafeJev;
		throws(() => createDecider(chatOnly, jevTarget, ctx), /does not support decide\(\)/);
	});
});

describe("decisions readers", () => {
	it("reads a noul against a threshold", () => {
		strictEqual(isTrue({ type: "noul", noul: 0.65 }), true);
		strictEqual(isTrue({ type: "noul", noul: 0.65 }, { threshold: 0.8 }), false);
		strictEqual(isTrue(undefined), null);
	});

	// An abstention is not a negative; both must be distinguishable.
	it("returns null rather than false below the confidence floor", () => {
		strictEqual(isTrue({ type: "noul", noul: 0.9, confidence: 0.2 }, { minConfidence: 0.5 }), null);
		strictEqual(isTrue({ type: "noul", noul: 0.9, confidence: 0.8 }, { minConfidence: 0.5 }), true);
	});

	it("reads a choice, withholding one whose mass is too thin", () => {
		const answer = { type: "choice" as const, choice: "scout", probabilities: { scout: 0.4, coder: 0.35 } };
		strictEqual(chosen(answer), "scout");
		strictEqual(chosen(answer, { threshold: 0.6 }), null);
	});

	it("reads a score and refuses a mistyped answer", () => {
		strictEqual(rating({ type: "score", score: 1.43 }), 1.43);
		strictEqual(rating({ type: "noul", noul: 1 }), null);
		strictEqual(chosen({ type: "score", score: 2 }), null);
	});
});
