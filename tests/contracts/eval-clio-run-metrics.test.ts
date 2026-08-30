import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	runClioRunRunner,
	toolBehaviorMetricEntriesFromJsonl,
	toolCallMetricsFromJsonl,
} from "../../src/domains/eval/runners/clio-run.js";

function jsonl(events: ReadonlyArray<unknown>): string {
	return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("contracts/eval clio-run tool metrics", () => {
	it("counts unique terminal execution events and ignores starts and tool-result messages", () => {
		const stdout = [
			jsonl([
				{ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: {} },
				{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false },
				{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false },
				{ type: "message_end", message: { role: "toolResult", toolCallId: "read-1", isError: false } },
				{ type: "tool_execution_start", toolCallId: "bash-1", toolName: "bash", args: {} },
				{ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: true },
				{ type: "tool_execution_start", toolCallId: "dangling", toolName: "write", args: {} },
			]),
			"not-json",
		].join("\n");

		deepStrictEqual(toolCallMetricsFromJsonl(stdout), {
			totalCalls: 2,
			failed: 1,
			blocked: 0,
		});
	});

	it("prefers structured Clio finish outcomes over paired execution ends", () => {
		const stdout = jsonl([
			{ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false },
			{ type: "clio_tool_finish", payload: { tool: "read", outcome: "ok" } },
			{ type: "tool_execution_end", toolCallId: "write-1", toolName: "write", isError: true },
			{ type: "clio_tool_finish", payload: { tool: "write", outcome: "blocked" } },
			{ type: "tool_execution_end", toolCallId: "bash-1", toolName: "bash", isError: true },
			{ type: "clio_tool_finish", payload: { tool: "bash", outcome: "error" } },
		]);

		deepStrictEqual(toolCallMetricsFromJsonl(stdout), {
			totalCalls: 3,
			failed: 1,
			blocked: 1,
		});
	});

	it("accepts an explicit structured outcome on an execution terminal event", () => {
		const stdout = jsonl([
			{ type: "tool_execution_end", toolCallId: "write-1", isError: true, outcome: "blocked" },
			{ type: "tool_execution_end", toolCallId: "bash-1", isError: false, outcome: "error" },
		]);

		deepStrictEqual(toolCallMetricsFromJsonl(stdout), {
			totalCalls: 2,
			failed: 1,
			blocked: 1,
		});
	});

	it("derives per-tool, blocked, distinct-read, allowlist, and decoy facts without retaining paths", () => {
		const stdout = jsonl([
			{
				type: "tool_execution_start",
				toolCallId: "read-target",
				toolName: "read",
				args: { path: "fixtures/target.ts" },
			},
			{ type: "tool_execution_end", toolCallId: "read-target", toolName: "read", isError: false },
			{
				type: "tool_execution_start",
				toolCallId: "read-decoy",
				toolName: "read",
				args: { path: "fixtures/decoy/note.txt" },
			},
			{ type: "tool_execution_end", toolCallId: "read-decoy", toolName: "read", isError: false },
			{ type: "clio_tool_finish", payload: { tool: "read", toolCallId: "read-target", outcome: "ok" } },
			{ type: "clio_tool_finish", payload: { tool: "read", toolCallId: "read-decoy", outcome: "ok" } },
			{ type: "clio_tool_finish", payload: { tool: "bash", toolCallId: "bash-1", outcome: "blocked" } },
			{ type: "clio_tool_finish", payload: { tool: "dispatch", toolCallId: "dispatch-1", outcome: "ok" } },
		]);
		const metrics = toolBehaviorMetricEntriesFromJsonl(stdout, "/repo", {
			allowedPaths: ["fixtures/target.ts"],
			decoyPaths: ["fixtures/decoy"],
		});
		deepStrictEqual(metrics, {
			"tools.read.distinctPaths": 2,
			"tools.calls.bash": 1,
			"tools.blocked.bash": 1,
			"tools.calls.dispatch": 1,
			"tools.blocked.dispatch": 0,
			"tools.calls.read": 2,
			"tools.blocked.read": 0,
			"tools.read.outsideAllowed": 1,
			"tools.read.decoyHits": 1,
		});
		strictEqual(JSON.stringify(metrics).includes("target.ts"), false);
		strictEqual(JSON.stringify(metrics).includes("note.txt"), false);
	});

	it("treats the workspace root allowlist as covering only local read paths", () => {
		const stdout = jsonl([
			{ type: "tool_execution_start", toolCallId: "local", toolName: "read", args: { path: "fixtures/target.ts" } },
			{ type: "tool_execution_end", toolCallId: "local", toolName: "read", isError: false },
			{ type: "tool_execution_start", toolCallId: "outside", toolName: "read", args: { path: "../outside.txt" } },
			{ type: "tool_execution_end", toolCallId: "outside", toolName: "read", isError: false },
		]);
		const metrics = toolBehaviorMetricEntriesFromJsonl(stdout, "/repo", { allowedPaths: ["."], decoyPaths: [] });
		strictEqual(metrics["tools.read.outsideAllowed"], 1);
	});

	it("returns parsed tool metrics from the clio-run runner", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-tool-metrics-"));
		try {
			const entry = join(root, "fake-clio.mjs");
			writeFileSync(
				entry,
				`process.stdout.write(${JSON.stringify(
					jsonl([
						{ type: "tool_execution_end", toolCallId: "read-1", isError: false },
						{ type: "tool_execution_end", toolCallId: "bash-1", isError: true },
					]),
				)});\n`,
				"utf8",
			);

			const output = await runClioRunRunner({ kind: "clio-run", prompt: "test" }, root, entry, 5000, { id: "local" });

			deepStrictEqual(
				{
					totalCalls: output.metrics["tools.totalCalls"],
					failed: output.metrics["tools.failed"],
					blocked: output.metrics["tools.blocked"],
				},
				{ totalCalls: 2, failed: 1, blocked: 0 },
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins the child's Clio state directory to the environment the item was given", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-eval-state-env-"));
		try {
			const entry = join(root, "fake-clio.mjs");
			// The child reports the journal location it resolved. An item that
			// cannot pin it reads a state directory it does not own.
			writeFileSync(entry, "process.stdout.write(String(process.env.CLIO_CODER_STATE_DIR ?? 'unset'));\n", "utf8");
			const stateDir = join(root, "state");

			const output = await runClioRunRunner(
				{ kind: "clio-run", prompt: "test" },
				root,
				entry,
				5000,
				{ id: "local" },
				{
					CLIO_CODER_STATE_DIR: stateDir,
				},
			);

			strictEqual(output.stdout, stateDir);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
