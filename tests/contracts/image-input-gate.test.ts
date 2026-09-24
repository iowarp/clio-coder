import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { acceptsImageInput } from "../../src/domains/providers/image-input.js";
import { applyModelCapabilityPatch } from "../../src/domains/providers/model-capabilities.js";

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
		strictEqual(acceptsImageInput({ runtimeId: "claude-code", vision: true }), false);
		strictEqual(acceptsImageInput({ runtimeId: "claude-sdk", vision: true }), false);
		strictEqual(acceptsImageInput({ runtimeId: "antigravity-code", vision: true }), false);
	});
});
