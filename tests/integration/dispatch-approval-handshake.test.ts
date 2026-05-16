import { ok, strictEqual } from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { spawnNativeWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { WORKER_RUNTIME_DESCRIPTOR_VERSION, WORKER_SPEC_VERSION } from "../../src/worker/spec-contract.js";

describe("dispatch approval handshake", () => {
	let scratch: string;
	let stubEntry: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-approval-"));
		stubEntry = join(scratch, "stub-entry.js");
		writeFileSync(
			stubEntry,
			`
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let gotSpec = false;
let approvalRequestId = "abc";
rl.on("line", (line) => {
	if (!gotSpec) {
		gotSpec = true;
		process.stdout.write(JSON.stringify({ type: "clio_tool_approval_request", payload: { requestId: approvalRequestId, claudeToolName: "Bash", clioToolName: "bash", args: { command: "ls" }, classification: { actionClass: "execute", reasons: [] }, mode: "default" } }) + "\\n");
		return;
	}
	const parsed = JSON.parse(line);
	if (parsed.type === "clio_tool_approval_response" && parsed.payload.requestId === approvalRequestId) {
		process.stdout.write(JSON.stringify({ type: "test_result", payload: parsed.payload }) + "\\n");
		process.exit(0);
	}
});
`,
		);
		chmodSync(stubEntry, 0o755);
	});
	afterEach(() => rmSync(scratch, { recursive: true, force: true }));

	it("delivers an approval response to the worker after receiving its request", async () => {
		const worker = spawnNativeWorker(
			{
				specVersion: WORKER_SPEC_VERSION,
				systemPrompt: "",
				task: "t",
				endpoint: { id: "e", runtime: "x" } as never,
				runtime: {
					version: WORKER_RUNTIME_DESCRIPTOR_VERSION,
					id: "x",
					kind: "http",
					apiFamily: "openai-responses",
					auth: "none",
				},
				runtimeId: "x",
				wireModelId: "m",
			},
			{ workerEntryPath: stubEntry },
		);

		let request: unknown = null;
		worker.onApprovalRequest(async (req) => {
			request = req;
			return { requestId: req.requestId, decision: "allow" as const, reason: "test" };
		});

		const events: unknown[] = [];
		for await (const ev of worker.events) events.push(ev);
		const exit = await worker.promise;
		strictEqual(exit.exitCode, 0);
		ok(request !== null, "approval request was forwarded to callback");
		const testResult = events.find((e) => (e as { type?: string }).type === "test_result");
		ok(testResult, "worker received the approval response");
	});
});
