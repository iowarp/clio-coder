import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isClioWorkerEvent, isToolApprovalRequest, isToolApprovalResponse } from "../../../src/engine/worker-events.js";

describe("engine/worker-events: approval event types", () => {
	it("isToolApprovalRequest accepts a well-formed payload", () => {
		const ev = {
			type: "clio_tool_approval_request",
			payload: {
				requestId: "req-1",
				claudeToolName: "Bash",
				clioToolName: "bash",
				args: { command: "ls" },
				classification: { actionClass: "execute", reasons: [] },
				mode: "default",
			},
		};
		strictEqual(isToolApprovalRequest(ev), true);
		strictEqual(isClioWorkerEvent(ev), true);
	});

	it("isToolApprovalResponse accepts a well-formed payload", () => {
		const ev = {
			type: "clio_tool_approval_response",
			payload: { requestId: "req-1", decision: "allow", reason: "user approved" },
		};
		strictEqual(isToolApprovalResponse(ev), true);
	});

	it("isToolApprovalRequest rejects bad shapes", () => {
		strictEqual(isToolApprovalRequest(null), false);
		strictEqual(isToolApprovalRequest({ type: "clio_tool_approval_request" }), false);
		strictEqual(isToolApprovalRequest({ type: "clio_tool_approval_request", payload: {} }), false);
	});

	it("isToolApprovalResponse rejects decisions other than allow/deny", () => {
		const ev = { type: "clio_tool_approval_response", payload: { requestId: "x", decision: "maybe" } };
		strictEqual(isToolApprovalResponse(ev), false);
	});
});
