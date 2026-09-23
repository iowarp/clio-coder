import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { streamWorkload } from "./stream-workload.mjs";

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
let writeCalls = 0;
// Settled frames mirror src/engine/acp/server.ts: `content` carries the result
// text and `rawOutput` is `{result, isError}`. A refusal is a FAILED call worded
// by src/tools/registry.ts, and an applied write carries `details.diff` in the
// numbered-row format of src/tools/edit-diff.ts.
const REFUSED_TEXT =
	"write blocked: write was not approved\nThis call was denied; no approval is pending.\nDo not retry the same call.";
const APPLIED_DIFF = "-1 draft\n+1 approved";
const settledWrite = (toolCallId, executed) => {
	const body = executed ? "Wrote 8 bytes to fixture.txt" : REFUSED_TEXT;
	return {
		sessionUpdate: "tool_call_update",
		toolCallId,
		title: "write",
		kind: "edit",
		status: executed ? "completed" : "failed",
		content: [{ type: "content", content: { type: "text", text: body } }],
		rawOutput: {
			result: {
				content: [{ type: "text", text: body }],
				...(executed ? { details: { diff: APPLIED_DIFF, firstChangedLine: 1 } } : {}),
			},
			isError: !executed,
		},
	};
};
const permission = async () => {
	const toolCallId = `write-${++writeCalls}`;
	const toolCall = {
		sessionUpdate: "tool_call",
		toolCallId,
		title: "write", // The runtime titles a call, and its permission request, with the tool name.
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
	update(settledWrite(toolCallId, executed));
	if (!cancelled) text(executed ? "Tool executed." : "Permission rejected.");
};
const event = (kind, payload, terminal = false) =>
	send({
		method: "clio-coder/event",
		params: {
			version: 1,
			workspaceInstanceId: "fixture",
			sessionId,
			turnId: null,
			sequence: ++eventSequence,
			kind,
			terminal,
			payload,
		},
	});
// The smoke scenario announces the steering surface the real engine does, so the composer's
// steer/queue/interrupt controls and the fleet strip's Guide/Stop are exercised in a browser.
// Every other scenario stays a v1 peer, which is what keeps the 409 degradation tested.
const STEERING =
	scenario === "markdown" || scenario === "steer"
		? {
				version: 1,
				main: true,
				dispatch: true,
				modes: ["next-slot", "end-of-turn"],
				interrupt: true,
				methods: {
					steer: "clio-coder/session/steer",
					queue: "clio-coder/session/queue",
					clear: "clio-coder/session/queue_clear",
					interrupt: "clio-coder/session/interrupt",
					dispatch: "clio-coder/dispatch/steer",
				},
			}
		: null;
const COMMANDS =
	scenario === "markdown"
		? {
				version: 1,
				commands: [
					{
						name: "doctor",
						summary: "Check this installation",
						usage: "/doctor [deep]",
						group: "Inspect",
						args: { positionals: [{ name: "depth", required: false, values: ["deep"] }] },
					},
					{
						name: "context",
						summary: "Work with project context",
						usage: "/context <compact>",
						group: "Session",
						requiresSubcommand: true,
						args: { subcommands: { compact: { positionals: [{ name: "instructions", required: false, rest: true }] } } },
					},
				],
			}
		: null;
// Visual review can ask the smoke scenario to advertise safe settings and targets, so the composer's
// route chip shows a reported model. The smoke itself leaves it off and asserts the missing controls.
const ROUTE = process.env.CLIO_CODER_WEB_FIXTURE_ROUTE === "1";
const queues = { steer: [], followUp: [] };
/** runId -> resolve. A held worker settles when it is stopped or the turn is cancelled. */
const liveRuns = new Map();
let liveRunCount = 0;
// The runtime keeps the orchestrator's `dispatch` call open for the worker's whole life and settles
// it after the run does, so the transcript shows the delegation as one running row beside the run.
const heldWorker = async () => {
	const runId = `run-live-${++liveRunCount}`;
	const toolCallId = `dispatch-${liveRunCount}`;
	const identity = {
		runId,
		agentId: "scout",
		taskPreview: "Survey the fixture",
		node: null,
		origin: "tool",
		attempt: 1,
	};
	update({
		sessionUpdate: "tool_call",
		toolCallId,
		title: "dispatch",
		kind: "other",
		status: "in_progress",
		rawInput: { agent: "scout", task: "Survey the fixture" },
	});
	event("dispatch.enqueued", identity);
	event("dispatch.started", identity);
	const stopped = await new Promise((resolve) => liveRuns.set(runId, resolve));
	liveRuns.delete(runId);
	const reason = stopped ? "operator_cancel" : "turn_cancelled";
	event("dispatch.failed", { runId, agentId: "scout", outcome: "cancelled", reason, durationMs: 25 }, true);
	const message = `dispatch failed: run ${runId} was cancelled (${reason})`;
	update({
		sessionUpdate: "tool_call_update",
		toolCallId,
		title: "dispatch",
		kind: "other",
		status: "failed",
		content: [{ type: "content", content: { type: "text", text: message } }],
		rawOutput: {
			result: {
				content: [{ type: "text", text: message }],
				// src/tools/dispatch-runner.ts reports a stopped run's outcome in the result details.
				details: { runId, outcome: "canceled", outcomeDetail: reason },
			},
			isError: true,
		},
	});
	if (!cancelled) text("The worker was stopped.");
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
		["compaction.end", { trigger: "threshold" }],
		["context.warning", { warning: "Context window is 85% full." }],
		[
			"safety.toolBudgetExceeded",
			{ tool: "bash", callsThisTurn: 41, softBudget: 40, hardCeiling: 60, interrupted: false },
		],
		["provider.health", { targetId: "fixture", status: "degraded", available: true, latencyMs: 5 }],
		// Not in ACP_TO_WEB_EVENT. A newer engine's kind must be dropped, not kill
		// the session, so every fleet-scenario test exercises that path too.
		["future.unknownKind", { anything: true }],
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
				if (!Array.isArray(kinds) || kinds.length !== 11) throw Error("event_opt_in");
				const rows = JSON.parse(readFileSync(join(process.env.CLIO_CODER_STATE_DIR, "gui/children.json"), "utf8"));
				if (!rows.some((row) => row.pid === process.pid && row.ownerPid === process.ppid))
					throw Error("not_recorded_before_initialize");
				result = {
					protocolVersion: 1,
					agentInfo: { name: "fixture", version: "1" },
					agentCapabilities: {
						loadSession: true,
						...(STEERING
							? {
									_meta: {
										"clio-coder/steering": STEERING,
										...(ROUTE
											? {
													"clio-coder/settings": { get_safe: true, patch_safe: true },
													"clio-coder/targets": { list: true, probe: true },
												}
											: {}),
										...(COMMANDS
											? {
													"clio-coder/commands": {
														version: 1,
														list: "clio-coder/commands/list",
														invoke: "clio-coder/commands/invoke",
														count: COMMANDS.commands.length,
													},
												}
											: {}),
									},
								}
							: {}),
					},
				};
				break;
			}
			case "session/new":
				if (["session_limit", "session_cwd_mismatch"].includes(scenario)) throw Error(scenario);
				result = { sessionId };
				if (ROUTE)
					setTimeout(
						() => event("provider.health", { targetId: "fixture", status: "healthy", available: true, latencyMs: 5 }),
						50,
					);
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
				const promptText = frame.params.prompt?.map((block) => block.text).join(" ") ?? "";
				const turnScenario =
					scenario === "markdown" && promptText.includes("[approval]")
						? "permission"
						: scenario === "markdown" && promptText.includes("[stream]")
							? "loop"
							: scenario === "markdown" && promptText.includes("[workload")
								? "workload"
								: STEERING && promptText.includes("[fleet]")
									? "held-worker"
									: scenario;
				cancelled = false;
				if (scenario === "crash") process.exit(9);
				if (turnScenario.startsWith("permission")) await permission();
				else if (turnScenario === "held-worker") await heldWorker();
				else if (turnScenario === "slow") {
					while (!cancelled) await delay(100);
				} else if (turnScenario === "workload") {
					// `[workload 16384]` asks for an answer of at least that many bytes.
					const bytes = Number(/\[workload (\d+)\]/.exec(promptText)?.[1] ?? 0);
					await streamWorkload({ update, text, delay, cancelled: () => cancelled, bytes });
				} else if (turnScenario === "loop") {
					for (let i = 0; i < 1400 && !cancelled; i++) {
						text(`${i} `);
						await delay(1);
					}
				} else {
					if (scenario === "fleet") fleet();
					if (scenario === "markdown") {
						for (const chunk of [
							"# Fixture findings\n\nThe change is **verified** against a local fixture.\n\n",
							"```ts\nconst answer: number = 42;\nconsole.log('A deliberately long code line verifies keyboard scrolling without widening the page', answer);\n```\n\n",
							"```mermaid\nflowchart LR\n  Request --> Review\n  Review --> Result\n```\n\n",
							"<script>window.modelMarkupExecuted = true</script>\n\n[Unsafe](javascript:alert(1)) and [Reference](https://example.org).\n\n| Check | Result |\n| --- | --- |\n| Fixture | Passed |\n\n",
						]) {
							if (cancelled) break;
							text(chunk);
							await delay(100);
						}
					}
					update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Check the fixture." } });
					// A `sessionUpdate` kind this app has never heard of is a newer engine,
					// not a broken one, so every ordinary turn carries one and still has to
					// settle. Its sibling below is the sharp line: a MALFORMED frame of a
					// kind the app DOES handle stays fatal, because continuing there means
					// drawing a shape no contract describes.
					update({ sessionUpdate: "future_unknown_kind", anything: true });
					if (scenario === "malformed-update")
						update({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "not-text" } });
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
			case "clio-coder/commands/list":
				if (!COMMANDS) throw Error("method_not_found");
				result = COMMANDS;
				break;
			case "clio-coder/commands/invoke": {
				if (!COMMANDS?.commands.some((row) => row.name === frame.params.command)) throw Error("command_not_exposed");
				const { command, argv = [] } = frame.params;
				result =
					command === "doctor"
						? { level: "success", lines: [argv.includes("deep") ? "Deep checks completed." : "Checks completed."] }
						: { level: "info", lines: [`Context action: ${argv.join(" ")}`] };
				break;
			}
			case "clio-coder/session/steer": {
				const followUp = frame.params.mode === "end-of-turn";
				(followUp ? queues.followUp : queues.steer).push(frame.params.text);
				result = { accepted: true, queue: followUp ? "follow-up" : "steer" };
				break;
			}
			case "clio-coder/session/queue":
				result = queues;
				break;
			case "clio-coder/session/queue_clear":
				result = { restored: [...queues.steer.splice(0), ...queues.followUp.splice(0)] };
				break;
			case "clio-coder/session/interrupt":
				result = { cancelled: false, refusal: "A dispatched worker is attached; stop the turn instead." };
				break;
			case "clio-coder/dispatch/steer": {
				const { runId, action } = frame.params;
				const settle = liveRuns.get(runId);
				if (settle === undefined) result = { accepted: false, reason: "run-not-active" };
				else if (action === "cancel") {
					settle(true);
					result = { accepted: true };
				} else {
					event("dispatch.progress", { runId, agentId: "scout", progressCount: 1, truncated: false });
					result = { accepted: true };
				}
				break;
			}
			case "session/cancel":
				cancelled = true;
				for (const settle of liveRuns.values()) settle(false);
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
						// A second target with a catalog, so choosing one in the route picker changes the model list.
						...(ROUTE
							? [
									{
										id: "field-station",
										runtime: "openai-compatible",
										models: ["survey-large", "survey-small"],
										isOrchestrator: true,
									},
								]
							: []),
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
