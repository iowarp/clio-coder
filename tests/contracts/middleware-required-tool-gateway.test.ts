import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/tool-choice-control.js";
import type { ToolRoundRecord } from "../../src/engine/types.js";
import { effectiveToolCall } from "../../src/tools/surface.js";

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

test("a gateway shorthand the gateway runs as a call meets the requirement at start and at round completion", () => {
	const shorthand = { capability: "extension_desk__next", args: "{}" };
	deepStrictEqual(effectiveToolCall("gateway", shorthand), {
		toolName: "extension_desk__next",
		args: {},
		viaGateway: true,
	});
	const control = createMiddlewareToolChoiceControl();
	control.apply([{ kind: "require_tool", toolName: "extension_desk__next" }]);
	control.toolStarted("gateway", { capability: "extension_desk__next" });
	deepStrictEqual(control.current(), { kind: "required", toolName: "extension_desk__next" });
	const round = { kind: "required", toolName: "extension_desk__next", choice: "auto", attempt: 0 } as ToolRoundRecord;
	const message = {
		role: "assistant",
		content: [{ type: "toolCall", id: "c1", name: "gateway", arguments: shorthand }],
		stopReason: "toolUse",
		toolRounds: [round],
	} as unknown as Parameters<typeof control.completeRound>[0];
	strictEqual(control.completeRound(message), null);
	strictEqual(round.enforcement, undefined);
	control.toolStarted("gateway", shorthand);
	deepStrictEqual(control.current(), { kind: "auto" });
});
