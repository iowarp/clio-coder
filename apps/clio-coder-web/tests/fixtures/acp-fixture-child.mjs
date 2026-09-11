import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.CLIO_CODER_WEB_FIXTURE_SCENARIO ?? "text";
let sessionId = randomUUID(),
	cancelled = false;
let eventSequence = 0,
	autonomy = "suggest";
const settings = {
	chat: { target: "fixture", model: "fixture-model", thinkingLevel: "off" },
	safety: { autonomy: "suggest" },
};
const editable = ["chat.target", "chat.model", "chat.thinkingLevel", "safety.autonomy"];
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
	const toolCall = {
		sessionUpdate: "tool_call",
		toolCallId: "write-1",
		title: "Write fixture",
		kind: "edit",
		status: "pending",
		rawInput: { path: "fixture.txt", content: "approved" },
		locations: [{ path: "fixture.txt" }],
	};
	update(toolCall);
	const id = `permission-${randomUUID()}`;
	const promise = new Promise((resolve) => pending.set(id, resolve));
	send({
		id,
		method: "session/request_permission",
		params: {
			sessionId,
			toolCall: scenario === "permission-mismatch" ? { ...toolCall, rawInput: { path: "different.txt" } } : toolCall,
			options: [
				{ optionId: "allow", kind: "allow_once", name: "Allow once" },
				{ optionId: "reject", kind: "reject_once", name: "Reject" },
			],
		},
	});
	const result = await promise;
	const executed = result?.outcome?.optionId === "allow";
	log({ permission: result, toolExecuted: executed });
	update({ sessionUpdate: "tool_call_update", toolCallId: "write-1", status: executed ? "completed" : "failed" });
	if (!cancelled) text(executed ? "Tool executed." : "Permission rejected.");
};
const fleet = () => {
	const identity = {
		runId: "run-1",
		agentId: "worker-1",
		taskPreview: "Bounded task",
		node: null,
		origin: "tool",
		attempt: 1,
	};
	for (const [kind, payload] of [
		[
			"safety.loopBlocked",
			{
				toolCallId: null,
				tool: "read",
				repeatCount: 2,
				blocksThisTurn: 1,
				budget: 3,
				disposition: "block",
				interrupted: false,
				shape: null,
			},
		],
		["dispatch.enqueued", identity],
		["dispatch.started", identity],
		["dispatch.progress", { runId: "run-1", agentId: "worker-1", progressCount: 1, truncated: false }],
		[
			"dispatch.completed",
			{ runId: "run-1", agentId: "worker-1", outcome: "success", outcomeCode: "done", durationMs: 10, tokenCount: 23 },
		],
		["dispatch.failed", { runId: "run-2", agentId: "worker-2", outcome: "error", reason: "tool_failed", durationMs: 12 }],
		[
			"accountability.evidenceReady",
			{ runId: "run-1", evidenceId: "evidence-1", firstPassSuccess: true, findingCount: 2, tags: ["fixture"] },
		],
	])
		send({
			method: "clio-coder/event",
			params: {
				version: 1,
				workspaceInstanceId: "fixture",
				sessionId,
				turnId: null,
				sequence: ++eventSequence,
				kind,
				terminal: ["dispatch.completed", "dispatch.failed", "accountability.evidenceReady"].includes(kind),
				payload: { ...payload, excludedProviderBody: "private" },
			},
		});
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
				if (scenario.startsWith("permission")) await permission();
				else if (scenario === "slow") {
					while (!cancelled) await delay(100);
				} else if (scenario === "loop") {
					for (let i = 0; i < 1400 && !cancelled; i++) {
						text(`${i} `);
						await delay(1);
					}
				} else {
					if (scenario === "fleet") fleet();
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
				for (const resolve of pending.values()) resolve({ outcome: { outcome: "cancelled" } });
				pending.clear();
				break;
			case "session/close":
				cancelled = true;
				break;
			case "clio-coder/settings/patch_safe":
				for (const [key, value] of Object.entries(frame.params.patch)) {
					if (!editable.includes(key)) throw Error("invalid_params");
					const [group, name] = key.split(".");
					settings[group][name] = value;
				}
				result = { settings, editable };
				break;
			case "clio-coder/settings/get_safe":
				result = { settings, editable, privateCredential: "must-be-stripped" };
				break;
			case "clio-coder/targets/list":
				result = {
					targets: [
						{
							id: "fixture",
							runtime: "openai-compatible",
							models: ["fixture-model"],
							isOrchestrator: true,
							apiKey: "must-be-stripped",
						},
					],
					_meta: { "clio-coder/truncated": true },
				};
				break;
			case "clio-coder/targets/probe":
				result = { targetId: frame.params.targetId, healthy: true, latencyMs: 5, reason: null };
				break;
			case "clio-coder/session/autonomy":
				autonomy = frame.params.level ?? autonomy;
				result = { level: autonomy, source: "session" };
				break;
			case "clio-coder/session/label":
			case "clio-coder/session/delete":
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
