import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import { createTaskMemoryTrace, taskMemoryTracePath } from "../../src/domains/memory/task-memory-trace.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";

describe("contracts/task memory envelope trace", () => {
	it("stays off unless the operator names a file", () => {
		strictEqual(taskMemoryTracePath({}), null);
		strictEqual(taskMemoryTracePath({ CLIO_CODER_MEMORY_TRACE: "" }), null);
		strictEqual(taskMemoryTracePath({ CLIO_CODER_MEMORY_TRACE: "   " }), null);
		strictEqual(taskMemoryTracePath({ CLIO_CODER_MEMORY_TRACE: " /tmp/trace.jsonl " }), "/tmp/trace.jsonl");
	});

	it("writes nothing until a step happens, then one row carrying what the model actually said", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-memory-trace-"));
		try {
			const path = join(dir, "nested", "trace.jsonl");
			const trace = createTaskMemoryTrace(path, () => new Date("2026-08-11T09:00:00.000Z"));
			ok(!existsSync(path), "an opened trace with no steps must not create a file");

			trace.record({
				systemPrompt: "system",
				userPrompt: "task and bank render",
				response: "I will save something.",
				decision: "malformed",
				reason: "unparseable",
				bankOperations: 0,
				droppedOperations: 0,
				reminder: null,
				error: null,
			});

			const rows = readFileSync(path, "utf8").trim().split("\n");
			strictEqual(rows.length, 1);
			deepStrictEqual(JSON.parse(rows[0] ?? ""), {
				at: "2026-08-11T09:00:00.000Z",
				decision: "malformed",
				reason: "unparseable",
				bankOperations: 0,
				droppedOperations: 0,
				reminder: null,
				error: null,
				response: "I will save something.",
				responseChars: 22,
				userPrompt: "task and bank render",
				userPromptChars: 20,
				systemPromptChars: 6,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("bounds a looping model's output while keeping its true length", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-memory-trace-bound-"));
		try {
			const path = join(dir, "trace.jsonl");
			createTaskMemoryTrace(path).record({
				systemPrompt: "",
				userPrompt: "",
				response: "x".repeat(40_000),
				decision: "malformed",
				reason: "unparseable",
				bankOperations: 0,
				droppedOperations: 0,
				reminder: null,
				error: null,
			});

			const row = JSON.parse(readFileSync(path, "utf8").trim()) as { response: string; responseChars: number };
			strictEqual(row.responseChars, 40_000, "the real size survives even though the text does not");
			ok(row.response.length < 9_000, "a 40k-character loop must not make the trace unreadable");
			match(row.response, /truncated/u);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reaches the trace from a live memory step, naming a broken route rather than a silent model", async () => {
		const envelopes: Array<{ reason: string; error: string | null }> = [];
		const registration = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			onEnvelope: (envelope) => envelopes.push({ reason: envelope.reason, error: envelope.error }),
			getModelClient: () => ({
				async complete() {
					throw new Error("connect ECONNREFUSED 127.0.0.1:1234");
				},
			}),
		});

		const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "probe the route" });

		strictEqual(result.decision, "silent");
		strictEqual(result.reason, "client_error");
		strictEqual(envelopes.length, 1);
		strictEqual(envelopes[0]?.reason, "client_error");
		match(envelopes[0]?.error ?? "", /ECONNREFUSED/u);
	});
});
