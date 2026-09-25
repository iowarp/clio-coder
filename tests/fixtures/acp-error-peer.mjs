import { createInterface } from "node:readline";

function send(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

for await (const line of createInterface({ input: process.stdin })) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	if (request.method === "initialize") {
		send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentInfo: { name: "error-fixture" } } });
	} else if (request.method === "session/new") {
		send({ jsonrpc: "2.0", id: request.id, result: { sessionId: "error-session" } });
	} else if (request.method === "session/prompt") {
		send({
			jsonrpc: "2.0",
			method: "session/update",
			params: {
				sessionId: "error-session",
				update: {
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text:
							'Warning: model metadata missing.\n{"type":"error","status":400,"error":{"message":"The model is not supported."}}',
					},
				},
			},
		});
		send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
	}
}
