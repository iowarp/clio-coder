import { deepStrictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";

const ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * An ACP result over the 32 KiB raw record cap arrives without details, and the
 * eval restores them from the session ledger. ACP aliases a repeated engine id
 * to clio-coder-tool-<n> while the ledger keeps the engine id, so the restore
 * must pair calls by occurrence, never by looking the wire id up.
 */
describe("eval-onboarding --rescore restores truncated ACP results from the ledger", () => {
	const dir = mkdtempSync(join(tmpdir(), "clio-eval-rescore-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("gives each of two calls sharing an engine id its own result", () => {
		const run = join(dir, "runs", "dispatch-review-acp-1");
		const session = join(run, "home", "state", "sessions", "ws", "s1");
		mkdirSync(session, { recursive: true });
		const truncated = { isError: false, details: {}, truncated: true };
		const record = {
			caseId: "dispatch-review",
			surface: "acp",
			rep: 1,
			pass: false,
			checks: {},
			tools: [
				{ name: "dispatch", tool: "dispatch", args: {}, id: "call_1", settled: truncated },
				{ name: "dispatch", tool: "dispatch", args: {}, id: "clio-coder-tool-1", settled: truncated },
			],
			modelCalls: null,
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			latencyMs: 1,
			stoppedEarly: false,
			finalText: "",
			error: null,
		};
		writeFileSync(join(run, "record.json"), JSON.stringify(record));
		const call = {
			kind: "message",
			role: "assistant",
			payload: { content: [{ type: "toolCall", id: "call_1", name: "dispatch", arguments: {} }] },
		};
		const result = (marker: string) => ({
			kind: "message",
			role: "tool_result",
			payload: { toolCallId: "call_1", isError: false, result: { details: { runs: [{ exitCode: 0, marker }] } } },
		});
		const ledger = [call, result("first"), call, result("second")].map((entry) => JSON.stringify(entry));
		writeFileSync(join(session, "current.jsonl"), `${ledger.join("\n")}\n`);

		execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "eval-onboarding.ts"), "--rescore", dir], {
			cwd: ROOT,
			stdio: "pipe",
		});

		const rescored = JSON.parse(readFileSync(join(run, "record.json"), "utf8")) as {
			tools: Array<{ settled: { truncated?: true; details: { runs?: Array<{ marker: string }> } } }>;
		};
		deepStrictEqual(
			rescored.tools.map((tool) => [tool.settled.truncated ?? false, tool.settled.details.runs?.[0]?.marker]),
			[
				[false, "first"],
				[false, "second"],
			],
		);
	});
});
