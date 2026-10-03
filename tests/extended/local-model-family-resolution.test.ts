import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMPTY_CAPABILITIES, mergeCapabilities } from "../../src/domains/providers/index.js";
import { resolveModelRuntimeCapabilities } from "../../src/domains/providers/model-runtime-capabilities.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";
import { extractLocalModelQuirks } from "../../src/domains/providers/types/local-model-quirks.js";

/**
 * The bundled catalog only. `resolveProviderKnowledgeBaseRoots` also appends
 * `<config>/model-catalog.d`, `<cwd>/.clio-coder/model-catalog.d` and
 * `CLIO_CODER_MODEL_CATALOG_DIRS`, all three at higher precedence than the
 * bundled file, and an operator overlay on the machine running the suite would
 * silently change every answer below. The config-dir overlay is the one most
 * likely to exist on a maintainer's machine.
 */
const catalogRoot = fileURLToPath(new URL("../../src/domains/providers/models/", import.meta.url));
const kb = new FileKnowledgeBase(catalogRoot);

// Public checkpoint names and quant suffixes from the five packaged families.
const routerIds = [
	{ id: "google/gemma-4-26B-A4B-it", family: "gemma4-26b-a4b", mechanism: "on-off" },
	{
		id: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16",
		family: "nemotron-3.5-lightning-30b-a3b",
		mechanism: "on-off",
	},
	{ id: "Qwen/Qwen3.5-4B", family: "qwen3.5-4b", mechanism: "on-off" },
	{ id: "Qwen/Qwen3.8-27B", family: "qwen3.8-27b", mechanism: "effort-levels" },
	{ id: "openai/gpt-oss-20b", family: "openai-gpt-oss", mechanism: "effort-levels" },
] as const;

const mustNotResolveTo = [
	{ id: "qwen3.8-32b", family: "qwen3.8-27b" },
	{ id: "gemma-4-70b-it", family: "gemma4-26b-a4b" },
	{ id: "nemotron-3.5-lightning-8b", family: "nemotron-3.5-lightning-30b-a3b" },
	{ id: "gpt-oss-120b", family: "openai-gpt-oss" },
] as const;

function resolveOn(runtimeId: string, modelId: string, level: "off" | "medium" | "high") {
	const kbHit = kb.lookup(modelId);
	ok(kbHit, `${modelId} resolves to no knowledge-base family`);
	return resolveModelRuntimeCapabilities({
		runtimeId,
		apiFamily: "openai-completions",
		modelId,
		capabilities: mergeCapabilities(EMPTY_CAPABILITIES, kbHit.entry.capabilities, null, null),
		kbHit,
		configuredThinkingLevel: level,
	});
}

describe("local model family resolution", () => {
	for (const { id, family, mechanism } of routerIds) {
		it(`resolves ${id} to ${family}, mechanism ${mechanism}`, () => {
			const hit = kb.lookup(id);
			ok(hit, `${id} resolves to no knowledge-base family`);
			strictEqual(hit.entry.family, family);
			strictEqual(extractLocalModelQuirks(hit.entry.quirks)?.thinking?.mechanism, mechanism);
			strictEqual(resolveOn("llamacpp", id, "off").thinking.mechanism, mechanism);
		});
	}

	for (const { id, family } of mustNotResolveTo) {
		it(`keeps ${id} off the ${family} family`, () => {
			const resolved = kb.lookup(id)?.entry.family;
			ok(resolved !== family, `${id} landed on ${family}; a pattern there is short enough to swallow it`);
		});
	}

	it("puts the on-off switch on the wire at both ends of the dial", () => {
		const off = resolveOn("llamacpp", "Qwen/Qwen3.5-4B", "off");
		strictEqual(off.thinking.thinkingActive, false);
		strictEqual(off.request.chatTemplateKwargs?.enable_thinking, false);
		const on = resolveOn("llamacpp", "Qwen/Qwen3.5-4B", "medium");
		strictEqual(on.thinking.thinkingActive, true);
		strictEqual(on.request.chatTemplateKwargs?.enable_thinking, true);
		strictEqual(on.request.reasoningEffort, undefined);
	});

	it("adds the LM Studio reasoning_effort spelling for an on-off family on that runtime", () => {
		const off = resolveOn("lmstudio", "google/gemma-4-26B-A4B-it", "off");
		strictEqual(off.request.reasoningEffort, "none");
		strictEqual(off.request.chatTemplateKwargs?.enable_thinking, false);
		const on = resolveOn("lmstudio", "google/gemma-4-26B-A4B-it", "medium");
		// on-off has no dial above "low"; medium coerces rather than passing through.
		strictEqual(on.thinking.effectiveLevel, "low");
		strictEqual(on.request.reasoningEffort, "low");
		strictEqual(on.request.chatTemplateKwargs?.enable_thinking, true);
	});

	it("declares each match pattern in exactly one family", () => {
		// The matcher ranks by pattern length and breaks an exact tie with `>=`,
		// so two families declaring the same string resolve to whichever loads
		// last, silently. Nothing else detects that.
		const owners = new Map<string, string[]>();
		for (const entry of kb.entries()) {
			ok(entry.matchPatterns.length > 0, `entry ${entry.family} declares no match patterns`);
			for (const pattern of entry.matchPatterns) {
				const key = pattern.toLowerCase();
				owners.set(key, [...(owners.get(key) ?? []), entry.family]);
			}
		}
		const collisions = [...owners].filter(([, families]) => families.length > 1);
		strictEqual(collisions.length, 0, `patterns claimed by more than one family: ${JSON.stringify(collisions)}`);
	});
});
