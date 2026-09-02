import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { EMPTY_CAPABILITIES, mergeCapabilities } from "../../src/domains/providers/index.js";
import { resolveModelRuntimeCapabilities } from "../../src/domains/providers/model-runtime-capabilities.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";

/**
 * The bundled catalog only. `resolveProviderKnowledgeBaseRoots` also appends
 * `<cwd>/.clio-coder/model-catalog.d` and `CLIO_CODER_MODEL_CATALOG_DIRS`, and
 * an operator overlay on the machine running the suite would silently change
 * every answer below.
 */
const catalogRoot = fileURLToPath(new URL("../../src/domains/providers/models/", import.meta.url));
const kb = new FileKnowledgeBase(catalogRoot);

/**
 * Every model id the mini llama.cpp router advertises that this catalog claims,
 * with the family it must land on and the thinking mechanism measured for that
 * family on llama.cpp on 2026-09-02 (issue #263). Asserting the family alone is
 * not enough: a misspelled `mechanism` is dropped silently by
 * `extractLocalModelQuirks` and the resolver then infers a plausible-looking
 * "on-off" from the reasoning plus qwen-chat-template default branch.
 */
const routerIds = [
	{ id: "gemma4-26b-moe", family: "gemma4-26b-a4b", mechanism: "on-off" },
	{ id: "gemma4-31b-dense", family: "gemma-4-31b-it-qat-mtp", mechanism: "on-off" },
	{ id: "nemo3.5-30b-moe", family: "nemotron-3.5-lightning-30b-a3b", mechanism: "on-off" },
	{ id: "nemotron3-30b-moe-omni", family: "nemotron-3-nano-omni-30b-a3b-reasoning", mechanism: "on-off" },
	{ id: "nemotron3-30b-omni", family: "nemotron-3-nano-omni-30b-a3b-reasoning", mechanism: "on-off" },
	{ id: "muse-30b-dense", family: "muse-glimmer-30b", mechanism: "always-on" },
	{ id: "thinkingcap-27b-dense-q4", family: "thinkingcap-qwen3.6-27b", mechanism: "on-off" },
	{ id: "qwopus3.6-35b-moe", family: "qwopus3.6-35b-a3b-coder", mechanism: "on-off" },
] as const;

function resolveOnLlamaCpp(modelId: string, level: "off" | "medium") {
	const kbHit = kb.lookup(modelId);
	ok(kbHit, `${modelId} resolves to no knowledge-base family`);
	return resolveModelRuntimeCapabilities({
		runtimeId: "llamacpp",
		apiFamily: "openai-completions",
		modelId,
		capabilities: mergeCapabilities(EMPTY_CAPABILITIES, kbHit.entry.capabilities, null, null),
		kbHit,
		configuredThinkingLevel: level,
	});
}

describe("local model family resolution", () => {
	for (const { id, family, mechanism } of routerIds) {
		it(`resolves ${id} to ${family} with a ${mechanism} dial`, () => {
			strictEqual(kb.lookup(id)?.entry.family, family);
			strictEqual(resolveOnLlamaCpp(id, "off").thinking.mechanism, mechanism);
		});
	}

	it("keeps qwopus3.6-35b-moe off the 27B preview family", () => {
		// The preview's pattern list carried a bare `qwopus3.6` that swallowed
		// this id and handed it a budget-tokens dial that emits nothing on
		// llama.cpp. The positive assertion above would still pass if someone
		// re-added a long `qwopus3.6-27b-...` pattern that happened to match, so
		// name the wrong family too.
		notStrictEqual(kb.lookup("qwopus3.6-35b-moe")?.entry.family, "qwopus3.6-27b-v1-preview");
		strictEqual(kb.lookup("qwopus3.6-27b-dense-q4")?.entry.family, "qwopus3.6-27b-v1-preview");
	});

	it("puts the on-off switch on the wire at both ends of the dial", () => {
		const off = resolveOnLlamaCpp("thinkingcap-27b-dense-q4", "off");
		strictEqual(off.thinking.thinkingActive, false);
		strictEqual(off.request.chatTemplateKwargs?.enable_thinking, false);
		const on = resolveOnLlamaCpp("thinkingcap-27b-dense-q4", "medium");
		strictEqual(on.thinking.thinkingActive, true);
		strictEqual(on.request.chatTemplateKwargs?.enable_thinking, true);
		// reasoning_effort was inert on every model in the 2026-09-02 sweep, so
		// nothing in this catalog may send it to llama.cpp for an on-off family.
		strictEqual(on.request.reasoningEffort, undefined);
	});

	it("shows the muse dial as forced rather than as a switch that does nothing", () => {
		const resolved = resolveOnLlamaCpp("muse-30b-dense", "off");
		strictEqual(resolved.thinking.thinkingActive, true);
		strictEqual(resolved.thinking.display, "forced");
		strictEqual(resolved.request.chatTemplateKwargs, undefined);
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
