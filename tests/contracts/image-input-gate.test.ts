import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { synthesizeCatalogBackedModel } from "../../src/domains/providers/catalog.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import { acceptsImageInput } from "../../src/domains/providers/image-input.js";
import { applyModelCapabilityPatch } from "../../src/domains/providers/model-capabilities.js";
import {
	refineRuntimeTargetWithModelHints,
	resolveRuntimeTarget,
} from "../../src/domains/providers/runtime-resolution.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { FileKnowledgeBase } from "../../src/domains/providers/types/knowledge-base.js";

describe("image input capability gate", () => {
	it("an explicit deployment false wins over a stale model input list", () => {
		strictEqual(acceptsImageInput({ vision: false, modelInput: ["text", "image"] }), false);
	});

	it("the same capability patch updates the model that serializes tool results", () => {
		const model = { input: ["text", "image"] as Array<"text" | "image"> };
		applyModelCapabilityPatch(model, { vision: false });
		deepStrictEqual(model.input, ["text"]);
		strictEqual(acceptsImageInput({ modelInput: model.input }), false);
		applyModelCapabilityPatch(model, { vision: true });
		deepStrictEqual(model.input, ["text", "image"]);
	});

	it("an unknown image capability fails closed", () => {
		strictEqual(acceptsImageInput({}), false);
	});

	it("a delegated text-only transport cannot advertise direct image blocks", () => {
		for (const runtimeId of ["claude-code", "claude-sdk", "antigravity-code", "codex-cli", "pi-cli", "opencode-cli"]) {
			strictEqual(acceptsImageInput({ runtimeId, vision: true }), false, runtimeId);
		}
	});

	it("catalog synthesis cannot give a text-only CLI peer image input through an override", () => {
		for (const runtimeId of ["codex-cli", "pi-cli", "opencode-cli"]) {
			const model = synthesizeCatalogBackedModel({
				target: { id: runtimeId, runtime: runtimeId, capabilities: { vision: true } },
				wireModelId: `${runtimeId}-default`,
				kb: null,
				defaultCapabilities: EMPTY_CAPABILITIES,
				runtimeId,
				provider: runtimeId,
				api: "external-agent-subprocess",
				defaultBaseUrl: `${runtimeId}://local`,
			});
			deepStrictEqual(model.input, ["text"], runtimeId);
		}
	});
});

// A gateway route whose probe reports image input, resolved the way a turn builds its runtime:
// resolve, synthesize the model without the probe, then refine with the model's hints.
describe("probed image input survives model-hint refinement", () => {
	const kb = new FileKnowledgeBase(fileURLToPath(new URL("../../src/domains/providers/models/", import.meta.url)));
	function resolveThroughHints(route: string, probedVision: boolean) {
		const target = { id: "blade", runtime: "litellm", url: "http://127.0.0.1:1", defaultModel: route };
		const status = {
			target,
			runtime: litellm,
			available: true,
			reason: "fixture",
			health: { status: "healthy", lastCheckAt: "2026-09-24T00:00:00.000Z", lastError: null, latencyMs: 1 },
			capabilities: { ...litellm.defaultCapabilities },
			discoveredModels: [route],
			probeModelCapabilities: { [route]: { chat: true, tools: true, vision: probedVision, contextWindow: 131072 } },
		};
		const providers = {
			getTarget: (id: string) => (id === target.id ? target : null),
			getRuntime: (id: string) => (id === "litellm" ? litellm : null),
			getDetectedReasoning: () => null,
			knowledgeBase: kb,
			list: () => [status],
		} as unknown as ProvidersContract;
		const resolved = resolveRuntimeTarget(providers, { targetId: "blade", wireModelId: route });
		if (!resolved.ok) throw new Error(resolved.diagnostics.map((entry) => entry.message).join("; "));
		const model = litellm.synthesizeModel(target, route, kb.lookup(route));
		return { before: resolved.target, after: refineRuntimeTargetWithModelHints(resolved.target, model, kb), model };
	}

	it("a probed vision route stays vision-capable after the probe-less model is folded in", () => {
		// The knowledge-base family for this route declares no vision, so the synthesized model is text-only.
		const { before, after, model } = resolveThroughHints("dynamo/qwopus3.8-27b-flash@q5_k_m", true);
		deepStrictEqual((model as { input: string[] }).input, ["text"]);
		strictEqual(before.capabilityDecisions.vision, true);
		strictEqual(after.capabilityDecisions.vision, true);
	});

	it("a probe that reports no image input is not overturned by a family that can see", () => {
		const { after } = resolveThroughHints("mini/qwopus3.6-35b-moe-q4km", false);
		strictEqual(after.capabilityDecisions.vision, false);
	});
});
