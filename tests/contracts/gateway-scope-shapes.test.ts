import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { scopedCapabilityShapes } from "../../src/tools/gateway/scope-shapes.js";
import type { ToolSpec } from "../../src/tools/registry.js";

test("a turn's scope names the argument shapes of the extension capabilities it admits", () => {
	const record = {
		name: "extension_desk__record",
		description: "Write a record",
		parameters: Type.Object({
			uri: Type.String(),
			record: Type.Object({}),
			expect_revision: Type.Optional(Type.Integer()),
			mode: Type.Optional(Type.Union([Type.Literal("create"), Type.Literal("update")])),
		}),
	} as unknown as ToolSpec;
	const registry = { get: (name: string) => (name === record.name ? record : undefined) };
	const text = scopedCapabilityShapes(registry, ["read", "extension_desk__record", "extension_desk__missing"]);
	strictEqual(
		text.split("\n")[1],
		'- extension_desk__record(uri: string, record: object, expect_revision?: integer, mode?: "create"|"update")',
	);
	strictEqual(text.split("\n").length, 2, "built-in read and an unregistered name add no line");
	strictEqual(scopedCapabilityShapes(registry, undefined), "");
	strictEqual(scopedCapabilityShapes(registry, ["read"]), "");
});
