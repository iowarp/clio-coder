import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.CLIO_CODER_WEB_FIXTURE_SCENARIO ?? "text";
let sessionId = randomUUID(),
	cancelled = false;
const pending = new Map();
const log = (event) => {
	if (process.env.CLIO_CODER_WEB_FIXTURE_LOG)
		appendFileSync(process.env.CLIO_CODER_WEB_FIXTURE_LOG, `${JSON.stringify(event)}\n`);
};
const send = (frame) => {
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`);
};
process.stdout.on("error", () => {});
const update = (
	value,
	meta = { "clio-coder/agent": [{ version: 1, role: "orchestrator", agentId: "orchestrator" }] },
) => send({ method: "session/update", params: { sessionId, update: value, ...(meta ? { _meta: meta } : {}) } });
const text = (value) => update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
const usage = { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, reasoning: 15, totalTokens: 50, costUsd: 0.001 };
const permission = async () => {
	const id = `permission-${randomUUID()}`;
	const promise = new Promise((resolve) => pending.set(id, resolve));
	send({
		id,
		method: "session/request_permission",
		params: {
			sessionId,
			toolCall: { toolCallId: "write-1", title: "Write fixture", kind: "edit", status: "pending" },
			options: [
				{ optionId: "allow", kind: "allow_once", name: "Allow once" },
				{ optionId: "reject", kind: "reject_once", name: "Reject" },
			],
		},
	});
	const result = await promise;
	const executed = result?.outcome?.optionId === "allow";
	log({ permission: result, toolExecuted: executed });
	text(executed ? "Tool executed." : "Permission rejected.");
};
async function handle(frame) {
	if (!frame.method) {
		pending.get(frame.id)?.(frame.result);
		pending.delete(frame.id);
		return;
	}
	log({ method: frame.method, params: frame.params });
	try {
		let result = {};
		switch (frame.method) {
			case "initialize": {
				const kinds = frame.params?.clientCapabilities?._meta?.["clio-coder/events"]?.kinds;
				if (!Array.isArray(kinds) || kinds.length !== 7) throw Error("event_opt_in");
				const rows = JSON.parse(readFileSync(join(process.env.CLIO_CODER_STATE_DIR, "web/children.json"), "utf8"));
				if (!rows.some((row) => row.pid === process.pid && row.ownerPid === process.ppid))
					throw Error("not_recorded_before_initialize");
				result = {
					protocolVersion: 1,
					agentInfo: { name: "fixture", version: "1" },
					agentCapabilities: { loadSession: true },
				};
				break;
			}
			case "session/new":
				if (["session_limit", "session_cwd_mismatch"].includes(scenario)) throw Error(scenario);
				result = { sessionId };
				break;
			case "session/load":
				sessionId = frame.params.sessionId;
				update(
					{ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Earlier prompt" } },
					{ "clio-coder/replay": { turn: 1 } },
				);
				update(
					{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Earlier reply" } },
					{ "clio-coder/replay": { turn: 1 } },
				);
				break;
			case "session/prompt": {
				cancelled = false;
				if (scenario === "crash") process.exit(9);
				if (scenario === "permission") await permission();
				else if (scenario === "slow") {
					while (!cancelled) await delay(100);
				} else if (scenario === "loop") {
					for (let i = 0; i < 1400 && !cancelled; i++) {
						text(`${i} `);
						await delay(1);
					}
				} else {
					update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Check the fixture." } });
					if (scenario === "tool") {
						update({
							sessionUpdate: "tool_call",
							toolCallId: "read-1",
							title: "Read README",
							kind: "read",
							status: "in_progress",
							locations: [{ path: "README.md", line: 0 }],
							rawInput: { path: "README.md" },
						});
						update({
							sessionUpdate: "tool_call_update",
							toolCallId: "read-1",
							title: "Read README",
							kind: "read",
							status: "completed",
							rawOutput: { result: "Fixture documentation" },
						});
					}
					for (const chunk of ["Hello ", "from ", "Clio."]) {
						if (cancelled) break;
						text(chunk);
						await delay(30);
					}
				}
				result = { stopReason: cancelled ? "cancelled" : "end_turn", _meta: { "clio-coder/usage": usage } };
				break;
			}
			case "session/cancel":
				cancelled = true;
				break;
			case "session/close":
				cancelled = true;
				break;
			default:
				throw Error("method_not_found");
		}
		if (frame.id !== undefined) send({ id: frame.id, result });
	} catch (error) {
		if (frame.id !== undefined)
			send({
				id: frame.id,
				error: {
					code: -32000,
					message: "Fixture refused request",
					data: { _meta: { "clio-coder/error": { version: 1, code: error.message } } },
				},
			});
	}
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	void handle(JSON.parse(line));
});
input.on("close", () => {
	if (scenario !== "slow") process.exit(0);
});
if (scenario === "slow") {
	setInterval(() => {}, 1000);
	process.on("SIGTERM", () => log({ signal: "SIGTERM" }));
} else
	process.on("SIGTERM", () => {
		log({ signal: "SIGTERM" });
		process.exit(0);
	});
