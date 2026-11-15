import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";

test("a required capability clears when a gateway call carries it, not on other gateway ops", () => {
	const control = createMiddlewareToolChoiceControl();
	control.apply([{ kind: "require_tool", toolName: "extension_desk__gate" }]);
	control.toolStarted("gateway", { op: "describe", capability: "extension_desk__gate" });
	deepStrictEqual(control.current(), { kind: "required", toolName: "extension_desk__gate" });
	control.toolStarted("gateway", { op: "call", capability: "extension_desk__status", args: {} });
	deepStrictEqual(control.current(), { kind: "required", toolName: "extension_desk__gate" });
	control.toolStarted("gateway", { op: "call", capability: "extension_desk__gate", args: {} });
	deepStrictEqual(control.current(), { kind: "auto" });
	control.apply([{ kind: "require_tool", toolName: "read" }]);
	control.toolStarted("read", { path: "a.ts" });
	deepStrictEqual(control.current(), { kind: "auto" });
});
