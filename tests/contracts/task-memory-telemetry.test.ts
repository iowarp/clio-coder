import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import {
	createTaskMemoryTelemetrySink,
	parseTaskMemoryTelemetryRecord,
	TASK_MEMORY_TELEMETRY_FILE,
	TASK_MEMORY_TELEMETRY_MAX_BYTES,
	taskMemoryBankDelta,
} from "../../src/domains/memory/task-memory-telemetry.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";

describe("contracts/task memory telemetry", () => {
	it("writes content-free JSONL records that satisfy the exact schema", () => {
		const logDir = mkdtempSync(join(tmpdir(), "clio-memory-telemetry-"));
		try {
			const bank = new TaskMemoryBank();
			const before = bank.snapshot();
			bank.updateStatus("private status that must not reach telemetry");
			bank.saveKnowledge("secret task fact that must not reach telemetry");
			const sink = createTaskMemoryTelemetrySink({
				logDir,
				now: () => new Date("2026-07-13T12:00:00.000Z"),
			});
			sink.record({
				triggerReasons: ["interval", "tool_error_streak"],
				tier: "llm",
				bankDelta: taskMemoryBankDelta(before, bank.snapshot()),
				decision: "injected",
				citedEntries: 1,
				inputTokens: 17,
				outputTokens: 9,
				latencyMs: 12.5,
			});

			const line = readFileSync(join(logDir, TASK_MEMORY_TELEMETRY_FILE), "utf8").trim();
			ok(!line.includes("private status"));
			ok(!line.includes("secret task fact"));
			const parsed = parseTaskMemoryTelemetryRecord(JSON.parse(line) as unknown);
			ok(parsed);
			deepStrictEqual(parsed, {
				version: 1,
				at: "2026-07-13T12:00:00.000Z",
				triggerReasons: ["interval", "tool_error_streak"],
				tier: "llm",
				bankDelta: {
					status: { added: 1, updated: 0, deleted: 0 },
					knowledge: { added: 1, updated: 0, deleted: 0 },
					procedural: { added: 0, updated: 0, deleted: 0 },
				},
				decision: "injected",
				citedEntries: 1,
				tokenCost: { input: 17, output: 9, total: 26 },
				latencyMs: 12.5,
			});
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("rotates the bounded log before appending the next record", () => {
		const logDir = mkdtempSync(join(tmpdir(), "clio-memory-telemetry-rotate-"));
		try {
			const path = join(logDir, TASK_MEMORY_TELEMETRY_FILE);
			writeFileSync(path, "x".repeat(TASK_MEMORY_TELEMETRY_MAX_BYTES + 1));
			createTaskMemoryTelemetrySink({ logDir }).record({
				triggerReasons: ["turn_end"],
				tier: "rules",
				bankDelta: {
					status: { added: 0, updated: 0, deleted: 0 },
					knowledge: { added: 0, updated: 0, deleted: 0 },
					procedural: { added: 0, updated: 0, deleted: 0 },
				},
				decision: "silent",
				citedEntries: 0,
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 0,
			});
			ok(existsSync(`${path}.1`));
			ok(parseTaskMemoryTelemetryRecord(JSON.parse(readFileSync(path, "utf8").trim()) as unknown));
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});

	it("rejects malformed, unbounded, and internally inconsistent records", () => {
		const valid = {
			version: 1,
			at: "2026-07-13T12:00:00.000Z",
			triggerReasons: ["manual"],
			tier: "rules",
			bankDelta: {
				status: { added: 0, updated: 0, deleted: 0 },
				knowledge: { added: 0, updated: 0, deleted: 0 },
				procedural: { added: 0, updated: 0, deleted: 0 },
			},
			decision: "silent",
			citedEntries: 0,
			tokenCost: { input: 0, output: 0, total: 0 },
			latencyMs: 0,
		};
		ok(parseTaskMemoryTelemetryRecord(valid));
		for (const malformed of [
			{ ...valid, task: "content leak" },
			{ ...valid, triggerReasons: [] },
			{ ...valid, triggerReasons: ["interval", "interval"] },
			{ ...valid, triggerReasons: ["interval", "tool_error_streak", "loop_signal", "manual"] },
			{ ...valid, decision: "unknown" },
			{ ...valid, tokenCost: { input: 1, output: 2, total: 4 } },
			{ ...valid, latencyMs: -1 },
		]) {
			strictEqual(parseTaskMemoryTelemetryRecord(malformed), null, JSON.stringify(malformed));
		}
	});

	it("captures rules and prompted steps while sink failures leave behavior unchanged", async () => {
		const records: unknown[] = [];
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({
			bank,
			everyNTools: 2,
			telemetry: { record: (record) => records.push(record) },
			getModelClient: () => ({
				async complete() {
					return {
						text:
							'<operations>[{"op":"save_knowledge","content":"The suite uses node:test."}]</operations>\n<no_intervention/>',
						inputTokens: 10,
						outputTokens: 4,
					};
				},
			}),
		});
		for (let call = 1; call <= 2; call += 1) {
			registration.evaluate({ hook: "before_tool", toolCallId: `${call}`, toolName: "bash", toolArgs: { call } });
			registration.evaluate({
				hook: "after_tool",
				toolCallId: `${call}`,
				toolName: "bash",
				toolArgs: { call },
				metadata: { resultKind: "ok" },
			});
		}
		registration.evaluate({ hook: "turn_end", turnId: "turn-1" });
		await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-1" });
		// The prompted step is detached from the boundary that started it, so its
		// telemetry row lands after the turn has already been released.
		await registration.whenIdle();

		strictEqual(records.length, 2);
		deepStrictEqual((records[0] as { triggerReasons: string[] }).triggerReasons, ["turn_end"]);
		deepStrictEqual((records[1] as { triggerReasons: string[] }).triggerReasons, ["interval"]);
		strictEqual((records[1] as { tier: string }).tier, "llm");
		strictEqual((records[1] as { decision: string }).decision, "silent");
		deepStrictEqual((records[1] as { bankDelta: { knowledge: unknown } }).bankDelta.knowledge, {
			added: 1,
			updated: 0,
			deleted: 0,
		});

		const failing = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			telemetry: {
				record() {
					throw new Error("disk full");
				},
			},
		});
		failing.evaluate({ hook: "before_tool", toolCallId: "healthy", toolName: "bash", toolArgs: {} });
		failing.evaluate({
			hook: "after_tool",
			toolCallId: "healthy",
			toolName: "bash",
			toolArgs: {},
			metadata: { resultKind: "ok" },
		});
		deepStrictEqual(failing.evaluate({ hook: "turn_end" }), []);
		strictEqual(failing.lastDecision(), "silent");
	});
});
