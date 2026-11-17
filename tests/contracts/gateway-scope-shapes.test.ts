import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { hostFramedTexts, systemReminderBlock } from "../../src/core/reminder-framing.js";
import {
	SCOPE_SHAPES_MAX_BYTES,
	scopedCapabilityShapes,
	scopeShapesDelta,
} from "../../src/tools/gateway/scope-shapes.js";
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

test("the whole shapes block fits its budget and goes again only once the context lost it", () => {
	const specs = Array.from(
		{ length: 40 },
		(_, at) =>
			({
				name: `extension_desk__op_${String(at).padStart(2, "0")}`,
				description: "An operation",
				parameters: Type.Object({ uri: Type.String(), payload: Type.Object({}), revision: Type.Optional(Type.Integer()) }),
			}) as unknown as ToolSpec,
	);
	const registry = { get: (name: string) => specs.find((spec) => spec.name === name) };
	const shapes = scopedCapabilityShapes(
		registry,
		specs.map((spec) => spec.name),
	);
	ok(Buffer.byteLength(shapes) <= SCOPE_SHAPES_MAX_BYTES, `${Buffer.byteLength(shapes)} bytes`);
	const lines = shapes.split("\n");
	const shown = lines.filter((line) => line.startsWith("- ")).length;
	strictEqual(lines.at(-1), `Describe for the shapes of the other ${40 - shown} allowed capabilities.`);
	ok(!shapes.includes("extension_desk__op_39"), "the overflow is a count, not a second list of names");

	const message = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
	const scope = "Allowed capabilities for this turn: extension_desk__op_00.";
	strictEqual(scopeShapesDelta(shapes, hostFramedTexts([])), shapes);
	const carried = hostFramedTexts([message(`${systemReminderBlock([scope, shapes])}\n\nAdvance one step.`)]);
	strictEqual(scopeShapesDelta(shapes, carried), "", "an identical block still in context is not sent again");
	strictEqual(scopeShapesDelta(shapes, hostFramedTexts([message(`${systemReminderBlock([scope])}\n\nNext.`)])), shapes);
});
