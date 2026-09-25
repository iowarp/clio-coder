import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startAcpDelegationRun } from "../../src/engine/acp/adapter.js";
import { AcpEventMapper } from "../../src/engine/acp/event-mapper.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

test("ACP provider error streamed as text is marked as a failed turn", () => {
	const mapper = new AcpEventMapper();
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Warning: model metadata missing.\n" },
		},
	});
	mapper.mapUpdate({
		update: {
			sessionUpdate: "agent_message_chunk",
			content: {
				type: "text",
				text:
					'{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The model is not supported."}}',
			},
		},
	});
	const failure = mapper.reportedFailure();
	strictEqual(failure, "ACP peer reported HTTP 400: The model is not supported.");
	const events = mapper.finalEvents({ stopReason: "end_turn" }, failure);
	const terminal = events[0] as { message: { stopReason: string; errorMessage: string } };
	strictEqual(terminal.message.stopReason, "error");
	strictEqual(terminal.message.errorMessage, failure);
});

test("ACP ordinary text and quoted error examples do not become failures", () => {
	for (const text of [
		"The package version is 0.5.5.",
		'An example error is {"type":"error","status":400,"error":{"message":"example"}}',
		'{"type":"error","status":200,"error":{"message":"example"}}',
	]) {
		const mapper = new AcpEventMapper();
		mapper.mapUpdate({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
		strictEqual(mapper.reportedFailure(), null);
	}
});

test("ACP adapter fails a peer turn that returns an error envelope with end_turn", async () => {
	const cwd = process.cwd();
	const run = startAcpDelegationRun({
		agent: {
			id: "error-fixture",
			command: process.execPath,
			args: [fileURLToPath(new URL("../fixtures/acp-error-peer.mjs", import.meta.url))],
			connectTimeoutMs: 5_000,
		},
		task: "report package version",
		cwd,
		safety: createWorkerSafety({ cwd }),
	});
	const result = await run.promise;
	strictEqual(result.exitCode, 1);
	strictEqual(result.failureMessage, "ACP peer reported HTTP 400: The model is not supported.");
});
