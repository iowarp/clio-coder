import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { synthesizeCatalogBackedModel } from "../../src/domains/providers/catalog.js";
import { acceptsImageInput } from "../../src/domains/providers/image-input.js";
import { applyModelCapabilityPatch } from "../../src/domains/providers/model-capabilities.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";

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
