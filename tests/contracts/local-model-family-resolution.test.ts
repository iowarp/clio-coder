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

/**
 * The seven ids issue #263 names, plus the second router spelling of the omni
 * and the ThinkingCap q6 that was measured and then deleted from mini. Not
 * every id the router advertises: the catalog also claims `qwen3.6-27b-dense`,
 * `qwen3.8-27b-dense`, `ornith1.5-*` and the two `qwopus3.6-27b-dense` quants,
 * whose families predate this sweep and are pinned elsewhere or not at all.
 *
 * Each row carries the family the id must land on and the thinking mechanism
 * measured for that family on llama.cpp on 2026-09-02. The declared mechanism
 * is asserted beside the resolved one because they fail differently: a
 * misspelled `mechanism` is dropped silently by `extractLocalModelQuirks`, and
 * for every on-off family here the resolver then infers a plausible-looking
 * "on-off" anyway from the reasoning plus qwen-chat-template default branch, so
 * the resolved value alone would stay green with no mechanism declared at all.
 */
const routerIds = [
	{ id: "gemma4-26b-moe", family: "gemma4-26b-a4b", mechanism: "on-off" },
	{ id: "gemma4-31b-dense", family: "gemma-4-31b-it-qat-mtp", mechanism: "on-off" },
	{ id: "nemo3.5-30b-moe", family: "nemotron-3.5-lightning-30b-a3b", mechanism: "on-off" },
	{ id: "nemotron3-30b-moe-omni", family: "nemotron-3-nano-omni-30b-a3b-reasoning", mechanism: "on-off" },
	{ id: "nemotron3-30b-omni", family: "nemotron-3-nano-omni-30b-a3b-reasoning", mechanism: "on-off" },
	{ id: "muse-30b-dense", family: "muse-glimmer-30b", mechanism: "always-on" },
	{ id: "thinkingcap-27b-dense-q4", family: "thinkingcap-qwen3.6-27b", mechanism: "on-off" },
	// Deleted from mini after the sweep. The family names no q6 pattern; it
	// resolves through the shorter `thinkingcap-27b-dense` spelling, and this
	// row is what stops a later narrowing of that pattern from stranding a
	// restored quant.
	{ id: "thinkingcap-27b-dense-q6", family: "thinkingcap-qwen3.6-27b", mechanism: "on-off" },
	{ id: "qwopus3.6-35b-moe", family: "qwopus3.6-35b-a3b-coder", mechanism: "on-off" },
] as const;

/**
 * Ids no family may claim. Each is a plausible next checkpoint from a vendor
 * already in the catalog, and each would land on a sibling's entry if that
 * family declared the bare vendor-or-finetune-name pattern that issue #263
 * deleted from `qwopus3.6-27b-v1-preview`. Landing on the sibling would hand it
 * that checkpoint's sampler, context window and measured dial.
 */
const mustNotResolveTo = [
	{ id: "thinkingcap-qwen3.8-32b", family: "thinkingcap-qwen3.6-27b" },
	{ id: "muse-glimmer-70b", family: "muse-glimmer-30b" },
	{ id: "nemotron-3.5-lightning-8b", family: "nemotron-3.5-lightning-30b-a3b" },
	{ id: "qwopus3.6-49b-moe", family: "qwopus3.6-27b-v1-preview" },
] as const;

function resolveOn(runtimeId: string, modelId: string, level: "off" | "medium") {
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

	it("keeps qwopus3.6-27b-dense-q4 on the preview family after the bare pattern is gone", () => {
		// Deleting `qwopus3.6` left the preview with `qwopus3.6-27b-v1-preview`
		// and `qwopus3.6-27b`. The two 27B dense quants the router serves are
		// spelled neither way and reach the family only through the shorter of
		// those two.
		strictEqual(kb.lookup("qwopus3.6-27b-dense-q4")?.entry.family, "qwopus3.6-27b-v1-preview");
		strictEqual(kb.lookup("qwopus3.6-27b-dense-q5")?.entry.family, "qwopus3.6-27b-v1-preview");
	});

	it("puts the on-off switch on the wire at both ends of the dial", () => {
		const off = resolveOn("llamacpp", "thinkingcap-27b-dense-q4", "off");
		strictEqual(off.thinking.thinkingActive, false);
		strictEqual(off.request.chatTemplateKwargs?.enable_thinking, false);
		const on = resolveOn("llamacpp", "thinkingcap-27b-dense-q4", "medium");
		strictEqual(on.thinking.thinkingActive, true);
		strictEqual(on.request.chatTemplateKwargs?.enable_thinking, true);
		// reasoning_effort was inert on every model in the 2026-09-02 sweep, so
		// nothing in this catalog may send it to llama.cpp for an on-off family.
		strictEqual(on.request.reasoningEffort, undefined);
	});

	it("adds the LM Studio reasoning_effort spelling for an on-off family on that runtime", () => {
		// The half of the qwopus3.6-35b-a3b-coder reclassification that changes
		// an existing target's wire bytes. `REASONING_EFFORT_ON_OFF_RUNTIMES`
		// adds the effort spelling for runtime id `lmstudio` only, which is
		// where the family's 2026-08-08 finding says the template flag is inert
		// and reasoning_effort is the control that works.
		const off = resolveOn("lmstudio", "qwopus3.6-35b-moe", "off");
		strictEqual(off.request.reasoningEffort, "none");
		strictEqual(off.request.chatTemplateKwargs?.enable_thinking, false);
		const on = resolveOn("lmstudio", "qwopus3.6-35b-moe", "medium");
		// on-off has no dial above "low"; medium coerces rather than passing through.
		strictEqual(on.thinking.effectiveLevel, "low");
		strictEqual(on.request.reasoningEffort, "low");
		strictEqual(on.request.chatTemplateKwargs?.enable_thinking, true);
	});

	it("shows the muse dial as forced rather than as a switch that does nothing", () => {
		const resolved = resolveOn("llamacpp", "muse-30b-dense", "off");
		strictEqual(resolved.thinking.thinkingActive, true);
		strictEqual(resolved.thinking.display, "forced");
		// The dial stays forced, but the family's level-keyed kwarg (#267) now
		// carries the card's reasoning_strength on the wire instead of nothing.
		strictEqual(resolved.request.chatTemplateKwargs?.enable_thinking, undefined);
		strictEqual(typeof resolved.request.chatTemplateKwargs?.reasoning_strength, "string");
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
