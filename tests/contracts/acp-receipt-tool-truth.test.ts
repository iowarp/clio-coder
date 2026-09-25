import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

beforeEach(() => isolateDispatchState());
afterEach(() => restoreDispatchState());

const PEER = `
const send = (message) => process.stdout.write(JSON.stringify({jsonrpc: "2.0", ...message}) + "\\n");
require("node:readline").createInterface({input: process.stdin}).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({id: request.id, result: {protocolVersion: 1}});
  if (request.method === "session/new") send({id: request.id, result: {sessionId: "receipt-fixture"}});
  if (request.method === "session/prompt") {
    for (const [id, kind, title] of [["e1", "edit", "lib/math.js"], ["x1", "execute", "npm test"]]) {
      send({method: "session/update", params: {sessionId: "receipt-fixture", update: {
        sessionUpdate: "tool_call", toolCallId: id, kind, title, status: "in_progress"
      }}});
      send({method: "session/update", params: {sessionId: "receipt-fixture", update: {
        sessionUpdate: "tool_call_update", toolCallId: id, title, status: "completed"
      }}});
    }
    send({method: "session/update", params: {sessionId: "receipt-fixture", update: {
      sessionUpdate: "agent_message_chunk", content: {type: "text", text: "Edited and tested fixture."}
    }}});
    send({id: request.id, result: {stopReason: "end_turn"}});
  }
});
`;

it("records ACP tool kinds, completed spans, mutations, and only mediated safety decisions", async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.fleet.retry.maxRetries = 0;
	settings.integrations.externalAgents.entries = [
		{
			id: "receipt-fixture",
			command: process.execPath,
			args: ["-e", PEER],
			toolGovernance: "clio-coder-policy",
		},
	];
	const bundle = makeDispatchBundle(dispatchStubContext({ settings }));
	await bundle.extension.start();
	try {
		const run = await bundle.contract.dispatch({
			agentId: "receipt-fixture",
			task: "Inspect and edit fixture.",
			executionRole: "researcher",
			requestOrigin: "internal",
		});
		const receipt = await run.finalPromise;
		strictEqual(
			receipt.outcome,
			"succeeded",
			JSON.stringify({ detail: receipt.outcomeDetail, failure: receipt.failureMessage }),
		);
		deepStrictEqual(
			receipt.toolStats?.map(({ tool, count, ok }) => ({ tool, count, ok })),
			[
				{ tool: "edit", count: 1, ok: 1 },
				{ tool: "execute", count: 1, ok: 1 },
			],
		);
		deepStrictEqual(receipt.safety?.toolTelemetry?.unfinished, []);
		strictEqual(receipt.toolActivity?.mutatingSucceeded, true);
		deepStrictEqual(receipt.safety?.decisions, { allowed: 0, blocked: 0, permissionRequested: 0 });
	} finally {
		await bundle.extension.stop?.();
	}
});
