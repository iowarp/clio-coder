import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import {
	foldTaskMemorySpend,
	formatTaskMemorySpend,
	readTaskMemorySpendSummary,
	taskMemoryStepsPath,
} from "../../src/domains/memory/task-memory-spend.js";
import type { TaskMemoryTelemetryStep } from "../../src/domains/memory/task-memory-telemetry.js";
import {
	parseTaskMemoryTelemetryRecord,
	taskMemoryTelemetryRecord,
} from "../../src/domains/memory/task-memory-telemetry.js";
import { makeScratchHome } from "../harness/scratch-env.js";

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

test("spend folds both retained generations and invalidates on replacement with the same size and mtime", (t) => {
	const home = makeScratchHome("clio-coder-memory-spend-");
	t.after(home.cleanup);
	const path = taskMemoryStepsPath(home.dir);
	mkdirSync(dirname(path), { recursive: true });
	const row = taskMemoryTelemetryRecord(STEP, AT);
	writeFileSync(`${path}.1`, `${JSON.stringify(row)}\n`);
	writeFileSync(path, `${JSON.stringify(row)}\n`);
	utimesSync(path, AT, AT);
	const initial = readTaskMemorySpendSummary(home.dir);
	strictEqual(initial.llmSteps, 2);
	strictEqual(initial.totalTokens, 2_658);
	strictEqual(readTaskMemorySpendSummary(home.dir), initial, "unchanged retained history reuses the fold");
	const original = statSync(path);
	const replacement = `${path}.replacement`;
	writeFileSync(replacement, `${JSON.stringify({ ...row, tokenCost: { input: 1_318, output: 12, total: 1_330 } })}\n`);
	utimesSync(replacement, original.atime, original.mtime);
	renameSync(replacement, path);
	strictEqual(statSync(path).size, original.size);
	strictEqual(statSync(path).mtimeMs, original.mtimeMs);
	strictEqual(readTaskMemorySpendSummary(home.dir).totalTokens, 2_659);
	renameSync(path, `${path}.1`);
	writeFileSync(path, `${JSON.stringify({ ...row, tokenCost: { input: 1_319, output: 12, total: 1_331 } })}\n`);
	utimesSync(path, AT, AT);
	strictEqual(readTaskMemorySpendSummary(home.dir).totalTokens, 2_661, "rotation replaces the retained generation");
	rmSync(path);
	strictEqual(readTaskMemorySpendSummary(home.dir).llmSteps, 1, "rotation-only history remains readable");
	rmSync(`${path}.1`);
	strictEqual(readTaskMemorySpendSummary(home.dir).llmSteps, 0, "removal invalidates both cached generations");
});

test("spend distinguishes absent, unreadable, and partial retained history and retries read failures", (t) => {
	const home = makeScratchHome("clio-coder-memory-spend-errors-");
	t.after(home.cleanup);
	const path = taskMemoryStepsPath(home.dir);
	const absent = readTaskMemorySpendSummary(home.dir);
	strictEqual(absent.readableFiles, 0);
	strictEqual(absent.unreadableFiles, 0);
	match(formatTaskMemorySpend(absent), /no history/u);
	mkdirSync(`${path}.1`, { recursive: true });
	const unavailable = readTaskMemorySpendSummary(home.dir);
	strictEqual(unavailable.unreadableFiles, 1);
	match(formatTaskMemorySpend(unavailable), /^partial retained spend.*unavailable/u);
	const row = taskMemoryTelemetryRecord({ ...STEP, missingTokenCalls: 0 }, AT);
	writeFileSync(path, `${JSON.stringify(row)}\n`);
	const partial = readTaskMemorySpendSummary(home.dir);
	strictEqual(partial.readableFiles, 1);
	strictEqual(partial.unreadableFiles, 1);
	strictEqual(partial.totalTokens, 1_329);
	match(formatTaskMemorySpend(partial), /^partial retained spend.*unreadable.*known 1\.3k tok/u);
	rmSync(`${path}.1`, { recursive: true });
	writeFileSync(`${path}.1`, `${JSON.stringify(row)}\n`);
	const recovered = readTaskMemorySpendSummary(home.dir);
	strictEqual(recovered.unreadableFiles, 0);
	strictEqual(recovered.readableFiles, 2);
	strictEqual(recovered.totalTokens, 2_658);
});

test("spend keeps a known subtotal beside invalid rows, explicit missing usage, and unreported legacy coverage", () => {
	const row = taskMemoryTelemetryRecord({ ...STEP, missingTokenCalls: 0 }, AT);
	const missing = taskMemoryTelemetryRecord({ ...STEP, inputTokens: 0, outputTokens: 0, missingTokenCalls: 1 }, AT);
	deepStrictEqual(parseTaskMemoryTelemetryRecord(missing), missing);
	strictEqual(parseTaskMemoryTelemetryRecord({ ...row, missingTokenCalls: -1 }), null);
	const skipped = taskMemoryTelemetryRecord(
		{ ...STEP, inputTokens: 0, outputTokens: 0, decision: "dropped", reason: "endpoint_busy" },
		AT,
	);
	const summary = foldTaskMemorySpend([
		JSON.stringify(row),
		JSON.stringify(missing),
		JSON.stringify(skipped),
		JSON.stringify({ ...row, tokenCost: null }),
		JSON.stringify({ ...row, version: 1 }),
		'{"version":',
		" ",
	]);
	strictEqual(summary.totalTokens, 1_329);
	strictEqual(summary.invalidRows, 3);
	strictEqual(summary.missingTokenCalls, 1, "a skipped boundary is not an extra missing model call");
	strictEqual(summary.unreportedUsageSteps, 1, "absent historical coverage remains unreported");
	match(formatTaskMemorySpend(summary), /^partial retained spend.*3 invalid rows.*1 calls missing usage/u);
});
