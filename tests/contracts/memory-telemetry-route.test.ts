import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import {
	parseTaskMemoryTelemetryRecord,
	type TaskMemoryTelemetryStep,
	taskMemoryTelemetryRecord,
} from "../../src/domains/memory/task-memory-telemetry.js";

const ZERO = { added: 0, updated: 0, deleted: 0 };
const STEP: TaskMemoryTelemetryStep = {
	triggerReasons: ["interval"],
	tier: "llm",
	bankDelta: { status: ZERO, knowledge: ZERO, procedural: ZERO },
	decision: "silent",
	reason: "model_silent",
	bankOperations: 0,
	droppedOperations: 0,
	citedEntries: 0,
	inputTokens: 1_317,
	outputTokens: 12,
	latencyMs: 40,
};
const AT = new Date("2026-09-29T10:00:00.000Z");

test("a step row records the resolved target and model and round-trips through the parser", () => {
	const row = taskMemoryTelemetryRecord(
		{ ...STEP, route: { targetId: "zbook-lemonade", modelId: "Gemma-4-26B-A4B-it-MTP-GGUF" } },
		AT,
	);
	strictEqual(row.targetId, "zbook-lemonade");
	strictEqual(row.modelId, "Gemma-4-26B-A4B-it-MTP-GGUF");
	deepStrictEqual(parseTaskMemoryTelemetryRecord(JSON.parse(JSON.stringify(row))), row);
});

test("rows written before the route pair existed still parse, and a step without a route omits the pair", () => {
	const row = taskMemoryTelemetryRecord(STEP, AT);
	strictEqual("targetId" in row, false);
	strictEqual("modelId" in row, false);
	deepStrictEqual(parseTaskMemoryTelemetryRecord(JSON.parse(JSON.stringify(row))), row);
});

test("a half-written route pair is a corrupt row", () => {
	const row = taskMemoryTelemetryRecord({ ...STEP, route: { targetId: "chat", modelId: "m" } }, AT);
	const { modelId: _modelId, ...halfPair } = row;
	strictEqual(parseTaskMemoryTelemetryRecord(JSON.parse(JSON.stringify(halfPair))), null);
	strictEqual(parseTaskMemoryTelemetryRecord({ ...row, modelId: "" }), null);
});
