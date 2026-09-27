import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { toolResultPayload } from "../../src/domains/context/working-set/payload.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { renderToolPreview } from "../../src/interactive/renderers/tool-execution.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { displayToolCall } from "../../src/tools/gateway-display.js";
import { effectiveToolCall } from "../../src/tools/surface.js";

/**
 * A chain whose step loaded a skill stamps `capability: "context"` and the
 * activation on its aggregate details, so activation telemetry and compaction
 * can find the load. The aggregate is still the chain (#F9 of the v0.5.7
 * release review): details-only consumers must not rename the whole plan a
 * context call, while an ordinary gateway op=call keeps its capability name
 * and the chain's skill row keeps its facts.
 */

const loadArgs = { scope: "skills", name: "diagram" };
const chainArgs = {
	op: "chain",
	steps: [
		{ id: "load", capability: "context", args: loadArgs },
		{ id: "save", capability: "write", after: ["load"], args: { path: "x.txt", content: "x" } },
	],
};
const activation = {
	name: "diagram",
	description: "Draw architecture diagrams from the code.",
	path: "/skills/diagram/SKILL.md",
	hash: "a".repeat(64),
	source: "clio-coder",
	sourceOrigin: "project",
	activation: "model",
};
const chainDetails = {
	...activation,
	capability: "context",
	op: "chain",
	steps: [{ id: "load", capability: "context", kind: "ok", truncated: false }],
	pending: ["save"],
	chainResults: [
		{
			id: "load",
			capability: "context",
			args: loadArgs,
			isError: false,
			result: {
				content: [{ type: "text", text: "Follow the diagram workflow." }],
				details: {
					...activation,
					kind: "ok",
					capability: "context",
					chainAdmission: { outcome: "ok", decision: "allowed", actionClass: "read" },
				},
			},
		},
	],
};
const chainResult = { content: [{ type: "text", text: "Chain paused: 1 of 2 steps settled." }], details: chainDetails };

test("an activation chain stays the chain for every details-based reader", () => {
	for (const args of [chainArgs, undefined]) {
		deepStrictEqual(
			[
				effectiveToolCall("gateway", args, chainDetails).toolName,
				effectiveToolCall("gateway", args, chainDetails).viaGateway,
			],
			["gateway", false],
		);
		strictEqual(displayToolCall("gateway", args, chainDetails).toolName, "gateway");
	}
	strictEqual(
		toolResultPayload({ toolCallId: "c", toolName: "gateway", isError: false, result: chainResult }).toolName,
		"gateway",
		"eviction markers and recall name the chain, not a context call",
	);
});

test("an ordinary gateway op=call still reads as the capability it ran", () => {
	const callArgs = { op: "call", capability: "context", args: loadArgs };
	const details = { ...activation, capability: "context" };
	for (const args of [callArgs, undefined]) {
		const call = effectiveToolCall("gateway", args, details);
		deepStrictEqual([call.toolName, call.viaGateway], ["context", true]);
	}
	deepStrictEqual(effectiveToolCall("gateway", callArgs).args, loadArgs);
	strictEqual(
		toolResultPayload({ toolCallId: "g", toolName: "gateway", result: { content: [], details } }).toolName,
		"context",
	);
	strictEqual(effectiveToolCall("gateway", { op: "find", query: "diagram" }, { op: "find" }).toolName, "gateway");
});

test("the TUI keeps the chain row with the loaded skill on its step", () => {
	const rows = renderToolPreview(
		{ toolCallId: "c", toolName: "gateway", args: chainArgs, result: chainResult, isError: false, durationMs: 10 },
		100,
		transcriptDetail("standard"),
	).map((row) => stripTerminalSequences(row));
	ok(/chained 2 steps · 1 not run/u.test(rows[0] ?? ""), rows.join("\n"));
	ok(
		rows.some((row) => row.includes("✓ context skill diagram")),
		rows.join("\n"),
	);
});
