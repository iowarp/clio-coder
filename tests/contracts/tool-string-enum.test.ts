import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { StringEnum } from "@earendil-works/pi-ai";
import { stringEnum } from "../../src/tools/string-enum.js";

describe("contracts/tool-string-enum", () => {
	it("emits pi-ai's StringEnum schema instead of a TypeBox anyOf union", () => {
		const schema = JSON.parse(JSON.stringify(stringEnum(["guide", "cancel"], "What to do."))) as Record<string, unknown>;
		deepStrictEqual(schema, { type: "string", enum: ["guide", "cancel"], description: "What to do." });
		deepStrictEqual(schema, JSON.parse(JSON.stringify(StringEnum(["guide", "cancel"], { description: "What to do." }))));
		strictEqual("anyOf" in schema, false);
	});

	it("omits the description key when none is given", () => {
		const schema = JSON.parse(JSON.stringify(stringEnum(["a", "b"]))) as Record<string, unknown>;
		deepStrictEqual(schema, { type: "string", enum: ["a", "b"] });
	});
});
