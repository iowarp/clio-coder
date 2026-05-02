import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { extractLocalModelQuirks } from "../../../src/domains/providers/types/local-model-quirks.js";
import { applyThinkingMechanism } from "../../../src/engine/apis/thinking-mechanism.js";

describe("providers/local-model-quirks extractor", () => {
	it("returns undefined for missing or non-record input", () => {
		strictEqual(extractLocalModelQuirks(undefined), undefined);
		strictEqual(extractLocalModelQuirks(null), undefined);
		strictEqual(extractLocalModelQuirks("hello"), undefined);
		strictEqual(extractLocalModelQuirks([1, 2]), undefined);
	});

	it("ignores free-form catalog fields (gpuTiers, runtimePreference, ...)", () => {
		strictEqual(
			extractLocalModelQuirks({
				gpuTiers: { "32gb": "fits at f16 KV" },
				runtimePreference: { lmstudioNative: "primary" },
				serving: "official card recommends 128K context",
			}),
			undefined,
		);
	});

	it("extracts kvCache quants and useFp16 from a YAML record", () => {
		const out = extractLocalModelQuirks({
			kvCache: { kQuant: "q8_0", vQuant: "q8_0", useFp16: true },
		});
		deepStrictEqual(out, { kvCache: { kQuant: "q8_0", vQuant: "q8_0", useFp16: true } });
	});

	it("rejects unknown KV quant strings while accepting `false` to disable quantization", () => {
		const out = extractLocalModelQuirks({
			kvCache: { kQuant: "garbage", vQuant: false, useFp16: false },
		});
		// vQuant: false is permitted (disable quant). kQuant: "garbage" is dropped.
		deepStrictEqual(out, { kvCache: { vQuant: false, useFp16: false } });
	});

	it("extracts a thinking sampling profile and normalizes repetitionPenalty alias", () => {
		const out = extractLocalModelQuirks({
			sampling: {
				thinking: {
					temperature: 0.6,
					topP: 0.95,
					topK: 20,
					minP: 0,
					repetitionPenalty: 1.0,
					presencePenalty: 0.5,
					maxTokens: 16384,
				},
			},
		});
		deepStrictEqual(out, {
			sampling: {
				thinking: {
					temperature: 0.6,
					topP: 0.95,
					topK: 20,
					minP: 0,
					repeatPenalty: 1.0,
					presencePenalty: 0.5,
					maxTokens: 16384,
				},
			},
		});
	});

	it("prefers repeatPenalty over repetitionPenalty when both are present", () => {
		const out = extractLocalModelQuirks({
			sampling: {
				instruct: { repeatPenalty: 1.05, repetitionPenalty: 1.0 },
			},
		});
		strictEqual(out?.sampling?.instruct?.repeatPenalty, 1.05);
	});

	it("extracts both thinking and instruct profiles independently", () => {
		const out = extractLocalModelQuirks({
			sampling: {
				thinking: { temperature: 0.6, topP: 0.95, topK: 20 },
				instruct: { temperature: 0.2, topP: 0.9, topK: 20 },
			},
		});
		strictEqual(out?.sampling?.thinking?.temperature, 0.6);
		strictEqual(out?.sampling?.instruct?.temperature, 0.2);
	});

	it("drops non-numeric sampler fields and yields undefined when nothing remained", () => {
		const out = extractLocalModelQuirks({
			sampling: { thinking: { temperature: "hot", topP: false } },
		});
		strictEqual(out, undefined);
	});

	it("drops non-integer topK", () => {
		const out = extractLocalModelQuirks({
			sampling: { thinking: { topK: 19.5 } },
		});
		strictEqual(out, undefined);
	});

	it("extracts a ThinkingQuirks block with mechanism, budgetByLevel, and guidance", () => {
		const out = extractLocalModelQuirks({
			thinking: {
				mechanism: "budget-tokens",
				budgetByLevel: { low: 1024, medium: 4096, high: 16384 },
				guidance: "preserve thinking across coding turns",
			},
		});
		deepStrictEqual(out?.thinking, {
			mechanism: "budget-tokens",
			budgetByLevel: { low: 1024, medium: 4096, high: 16384 },
			guidance: "preserve thinking across coding turns",
		});
	});

	it("rejects unknown mechanisms and yields undefined when no other quirks remain", () => {
		const out = extractLocalModelQuirks({ thinking: { mechanism: "garbage" } });
		strictEqual(out, undefined);
	});

	it("extracts effortByLevel for effort-levels mechanism", () => {
		const out = extractLocalModelQuirks({
			thinking: {
				mechanism: "effort-levels",
				effortByLevel: { low: "low", medium: "medium", high: "high" },
			},
		});
		strictEqual(out?.thinking?.mechanism, "effort-levels");
		strictEqual(out?.thinking?.effortByLevel?.medium, "medium");
	});
});

describe("engine/thinking-mechanism applyThinkingMechanism", () => {
	it("returns thinkingActive=false and a notice for `none` mechanism when level is non-off", () => {
		const applied = applyThinkingMechanism({ thinking: { mechanism: "none" } }, "high");
		strictEqual(applied.thinkingActive, false);
		strictEqual(applied.mechanism, "none");
		strictEqual(applied.noticeKind, "unsupported");
	});

	it("forces thinkingActive=true for `always-on` and emits a notice when off was requested", () => {
		const applied = applyThinkingMechanism({ thinking: { mechanism: "always-on" } }, "off");
		strictEqual(applied.thinkingActive, true);
		strictEqual(applied.noticeKind, "always-on");
	});

	it("coerces medium to on for `on-off` and writes chat_template_kwargs", () => {
		const applied = applyThinkingMechanism({ thinking: { mechanism: "on-off" } }, "medium");
		strictEqual(applied.thinkingActive, true);
		deepStrictEqual(applied.chatTemplateKwargs, { enable_thinking: true });
		strictEqual(applied.noticeKind, "ignored-on-off");
	});

	it("for `budget-tokens`, picks the budget for the requested level", () => {
		const applied = applyThinkingMechanism(
			{
				thinking: {
					mechanism: "budget-tokens",
					budgetByLevel: { low: 1024, medium: 4096, high: 16384 },
				},
			},
			"medium",
		);
		strictEqual(applied.thinkingActive, true);
		strictEqual(applied.budgetTokens, 4096);
	});

	it("for `effort-levels`, picks the effort string for the requested level", () => {
		const applied = applyThinkingMechanism(
			{
				thinking: {
					mechanism: "effort-levels",
					effortByLevel: { low: "low", medium: "medium", high: "high" },
				},
			},
			"high",
		);
		strictEqual(applied.thinkingActive, true);
		strictEqual(applied.effort, "high");
	});

	it("falls back to mechanism `none` when the model does not advertise reasoning", () => {
		const applied = applyThinkingMechanism(undefined, "off", { reasoning: false });
		strictEqual(applied.mechanism, "none");
	});

	it("falls back to mechanism `budget-tokens` when thinkingFormat is anthropic-extended", () => {
		const applied = applyThinkingMechanism(undefined, "medium", {
			reasoning: true,
			thinkingFormat: "anthropic-extended",
		});
		strictEqual(applied.mechanism, "budget-tokens");
	});

	it("falls back to mechanism `effort-levels` when thinkingFormat is openai-codex", () => {
		const applied = applyThinkingMechanism(undefined, "medium", {
			reasoning: true,
			thinkingFormat: "openai-codex",
		});
		strictEqual(applied.mechanism, "effort-levels");
	});

	it("falls back to mechanism `on-off` for other thinking formats", () => {
		const applied = applyThinkingMechanism(undefined, "medium", {
			reasoning: true,
			thinkingFormat: "qwen-chat-template",
		});
		strictEqual(applied.mechanism, "on-off");
	});
});
