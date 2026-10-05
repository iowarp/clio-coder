import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { streamWorkload } from "./stream-workload.mjs";

const scenario = process.env.CLIO_CODER_WEB_FIXTURE_SCENARIO ?? "text";
let sessionId = randomUUID(),
	cancelled = false;
let eventSequence = 0,
	autonomy = "default";
const settings = {
	chat: { target: "fixture", model: "fixture-model", thinkingLevel: "off" },
	safety: { autonomy: "default" },
};
const editable = ["chat.target", "chat.model", "chat.thinkingLevel", "safety.autonomy"];
const configOptions = () => [
	{ id: "autonomy", currentValue: autonomy, options: [] },
	{
		id: "model",
		currentValue: settings.chat.model,
		options: (settings.chat.target === "field-station"
			? ["survey-large", "survey-small"]
			: ["fixture-model", "fixture-small"]
		).map((value) => ({ value, name: value })),
	},
	{
		id: "thinkingLevel",
		currentValue: settings.chat.thinkingLevel,
		options: ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((value) => ({ value, name: value })),
	},
];
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
// A plan-scale dispatch the agent parks for approval, carrying the plan admission rendered.
const PLAN_HASH = "3f2a9c1e04b7d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e";
const planPermission = async () => {
	const toolCallId = `dispatch-plan-${++writeCalls}`;
	const tasks = [
		{ agent: "scout", task: "Survey the soil samples" },
		{ agent: "writer", task: "Draft the comparison report" },
	];
	const toolCall = {
		sessionUpdate: "tool_call",
		toolCallId,
		title: "dispatch",
		kind: "other",
		status: "pending",
		rawInput: { tasks },
	};
	update(toolCall);
	const id = `permission-${randomUUID()}`;
	const promise = new Promise((resolve) => pending.set(id, resolve));
	send({
		id,
		method: "session/request_permission",
		params: {
			sessionId,
			toolCall,
			options: [
				{ optionId: "allow-once", kind: "allow_once", name: "Approve plan" },
				{ optionId: "reject-once", kind: "reject_once", name: "Deny" },
			],
			_meta: {
				"clio-coder/dispatchPlan": {
					version: 1,
					topology: "parallel",
					taskCount: 2,
					planScale: true,
					hash: PLAN_HASH,
					tasks: [
						{ ...tasks[0], target: "fixture", model: "fixture-model", dependencies: [] },
						{ ...tasks[1], target: "fixture", model: "fixture-small", worktree: true, apply: "preserve", dependencies: [] },
					],
					truncated: false,
					unknownFutureField: "ignored",
				},
			},
		},
	});
	const result = await promise;
	const approved = result?.outcome?.optionId === "allow-once";
	log({ planPermission: result, approved });
	update({
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: approved ? "completed" : "failed",
		content: [{ type: "content", content: { type: "text", text: approved ? "Plan dispatched." : "Plan not approved." } }],
	});
	if (!cancelled) text(approved ? "The plan is running." : "The plan was not approved.");
};
const event = (kind, payload, terminal = false) =>
	send({
		method: "_clio-coder/event",
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
					steer: "_clio-coder/session/steer",
					queue: "_clio-coder/session/queue",
					clear: "_clio-coder/session/queue_clear",
					interrupt: "_clio-coder/session/interrupt",
					dispatch: "_clio-coder/dispatch/steer",
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
						usage: "/context <compact|reset|recover>",
						group: "Session",
						requiresSubcommand: true,
						promptTurnSubcommands: ["recover"],
						args: {
							subcommands: {
								compact: { positionals: [{ name: "instructions", required: false, rest: true }] },
								reset: { flags: [{ name: "--yes" }, { name: "--all" }] },
								recover: {
									positionals: [
										{ name: "handoffId", required: true },
										{ name: "action", required: true, values: ["reduce", "deliver"] },
									],
								},
							},
						},
					},
					{
						name: "skill",
						summary: "Use a skill",
						usage: "/skill <name>",
						group: "Session",
						injectsUserTurn: true,
						args: { positionals: [{ name: "name", required: true }] },
					},
					{
						name: "council",
						summary: "Ask a roster the same task",
						usage: "/council [--roster <name>] <task>",
						group: "Work",
						streams: "dispatch",
						promptTurn: true,
						args: {
							flags: [{ name: "--roster", takesValue: true }],
							positionals: [{ name: "task", required: true, rest: true }],
						},
					},
					{
						name: "tasks",
						summary: "Keep your own task list",
						usage: "/tasks <add|hand|done|drop>",
						injectsUserTurn: true,
						group: "Session",
						requiresSubcommand: true,
						args: {
							subcommands: {
								add: { positionals: [{ name: "text", required: true, rest: true }] },
								hand: { positionals: [{ name: "id", required: true }] },
								done: { positionals: [{ name: "id", required: true }] },
								drop: { positionals: [{ name: "id", required: true }] },
							},
						},
					},
				],
				prompts: ["review-pr"],
			}
		: null;
// The session board a real agent folds from its ledger: the operator's tasks change through the
// `tasks` command above; the plan and decisions are the agent's own report.
const BOARD = {
	version: 1,
	operatorTasks: [],
	plan: {
		title: "Survey the fixture",
		tasks: [
			{ id: "1", title: "Read the fixture workspace", status: "completed", origin: "agent", reason: null },
			{ id: "2", title: "Summarize the findings", status: "active", origin: "agent", reason: null },
		],
	},
	decisions: [
		{
			ref: "interview-1/format",
			interviewId: "interview-1",
			key: "format",
			label: "Report format",
			value: "Markdown with one table",
			status: "active",
			source: "operator",
			decidedAt: "2026-09-26T00:00:00.000Z",
			rationale: null,
			correction: null,
		},
	],
	memory: {
		enabled: true,
		tier: "rules",
		entries: 2,
		stepInFlight: false,
		bank: [
			{ id: "k1", kind: "knowledge", content: "Sample B reads 4.2 on the field instrument." },
			{ id: "p1", kind: "procedural", content: "Read README.md before measuring." },
		],
	},
	truncated: false,
};
const invokeTask = (argv) => {
	const [action, ...rest] = argv;
	if (action === "add") {
		const id = `u${BOARD.operatorTasks.length + 1}`;
		BOARD.operatorTasks.push({ id, title: rest.join(" "), status: "open", expectedOutputs: [], verificationChecks: 0 });
		return { level: "success", lines: [`added ${id}`] };
	}
	const task = BOARD.operatorTasks.find((row) => row.id === rest[0]);
	if (task) task.status = action === "hand" ? "handed" : action === "done" ? "done" : "dropped";
	return task
		? { level: "success", lines: [`${task.id} ${task.status}`] }
		: { level: "error", lines: [`no task ${rest[0]}`] };
};
// The /tree a real agent projects from its ledger: a first exchange, then two
// branches under its reply. The newest, a sibling question, is where the next
// request lands until a person moves the append point.
const TREE_TURNS = {
	u1: { parentId: null, kind: "user", preview: "Earlier prompt", reply: null },
	a1: { parentId: "u1", kind: "assistant", preview: "Earlier reply", reply: null },
	u2: { parentId: "a1", kind: "user", preview: "Measure the second sample", reply: null },
	a2: { parentId: "u2", kind: "assistant", preview: "The second sample reads 4.2", reply: null },
	u3: { parentId: "a1", kind: "user", preview: "Try the other instrument", reply: null },
	a3: { parentId: "u3", kind: "assistant", preview: "The other instrument agrees", reply: null },
};
let treeLeaf = "a3";
const treePath = (leaf) => {
	const path = [];
	for (let id = leaf; id; id = TREE_TURNS[id]?.parentId) path.unshift(id);
	return path;
};
const sessionTree = () => {
	const active = new Set(treePath(treeLeaf));
	return {
		version: 1,
		sessionId,
		leafId: treeLeaf,
		parentSessionId: null,
		parentTurnId: null,
		nodes: Object.entries(TREE_TURNS).map(([id, node], index) => ({
			id,
			parentId: node.parentId,
			kind: node.kind,
			at: `2026-09-26T09:00:0${index}.000Z`,
			label: id === "a1" ? "Baseline" : null,
			preview: node.preview,
			active: active.has(id),
			selectable: true,
		})),
		truncated: false,
	};
};
/** The replay `session/load` sends, restricted to one branch's path. */
const replayPath = (leaf) => {
	let turn = 0;
	for (const id of treePath(leaf)) {
		const node = TREE_TURNS[id];
		if (node.kind === "user") turn++;
		update(
			{
				sessionUpdate: node.kind === "user" ? "user_message_chunk" : "agent_message_chunk",
				content: { type: "text", text: node.preview },
			},
			{ "clio-coder/replay": { turn } },
		);
	}
	return turn;
};
// One fleet contract, "survey": two agent steps in two waves. Its hash covers the vars, as the
// real plan's does through the rendered task, so a changed variable is a changed plan.
const fleetHash = (vars) =>
	createHash("sha256")
		.update(`survey:${JSON.stringify(vars ?? {})}`)
		.digest("hex");
const fleetPreview = (name, vars) =>
	name !== "survey"
		? {
				status: "refused",
				name,
				diagnostics: [`fleet contract not found: .clio-coder/fleets/${name}.md (and no builtin named '${name}')`],
			}
		: {
				status: "ready",
				name,
				planHash: fleetHash(vars),
				stepCount: 2,
				waves: [
					{
						index: 0,
						steps: [
							{
								stepId: "survey",
								kind: "agent",
								scope: "readonly",
								agentId: "scout",
								writes: null,
								route: { targetId: "fixture", model: "fixture-model", nodeId: "local" },
							},
						],
					},
					{
						index: 1,
						steps: [
							{
								stepId: "report",
								kind: "agent",
								scope: "workspace",
								agentId: "writer",
								writes: ["reports/"],
								route: { targetId: "fixture", model: "fixture-small", nodeId: "local" },
							},
						],
					},
				],
				budget: { ceilingUsd: 5, currentUsd: 0.25, contractUsd: 1 },
				truncated: false,
			};
// The /handoff lifecycle a real agent runs through its shared service: a draft is
// held under an id until it is committed, discarded, or a request moves the session.
let pendingHandoff = null;
const proposedMemory = new Set();
let extensionGeneration = 1;
let libraryGeneration = 1;
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
		[
			"dispatch.scopeNotice",
			{ code: "write_root_dot_unconfined", level: "warning", message: "[dispatch scope] a root of '.' set no boundary." },
		],
		// Not in ACP_TO_WEB_EVENT. A newer engine's kind must be dropped, not kill
		// the session, so every fleet-scenario test exercises that path too.
		["future.unknownKind", { anything: true }],
	])
		send({
			method: "_clio-coder/event",
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
				if (!Array.isArray(kinds) || kinds.length !== 13 || !kinds.includes("context.activity"))
					throw Error("event_opt_in");
				const rows = JSON.parse(readFileSync(join(process.env.CLIO_CODER_STATE_DIR, "gui/children.json"), "utf8"));
				if (!rows.some((row) => row.pid === process.pid && row.ownerPid === process.ppid))
					throw Error("not_recorded_before_initialize");
				result = {
					protocolVersion: 1,
					agentInfo: { name: "fixture", version: "1" },
					agentCapabilities: {
						loadSession: true,
						promptCapabilities: { audio: false, embeddedContext: scenario === "markdown", image: scenario === "markdown" },
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
														list: "_clio-coder/commands/list",
														invoke: "_clio-coder/commands/invoke",
														count: COMMANDS.commands.length,
														...(process.env.CLIO_CODER_WEB_FIXTURE_PROMPT_TURNS !== "0" ? { promptTurns: true } : {}),
													},
													"clio-coder/board": {
														version: 1,
														method: "_clio-coder/session/board",
														supersede: "_clio-coder/decisions/supersede",
														proposeMemory: "_clio-coder/memory/propose",
													},
													"clio-coder/context": { version: 1, ledger: "_clio-coder/context/ledger" },
													"clio-coder/extensions": {
														version: 1,
														list: "_clio-coder/extensions/list",
														reload: "_clio-coder/extensions/reload",
													},
													"clio-coder/library": { version: 1, reload: "_clio-coder/library/reload" },
													"clio-coder/accounting": { version: 1, read: "_clio-coder/usage/read" },
													"clio-coder/aside": {
														version: 1,
														ask: "_clio-coder/aside/ask",
														draft: "_clio-coder/aside/draft",
														cancel: "_clio-coder/aside/cancel",
														draftCounts: { min: 1, max: 4, default: 3 },
													},
													"clio-coder/fleet": {
														version: 1,
														preview: "_clio-coder/fleet/preview",
														run: "_clio-coder/fleet/run",
													},
													"clio-coder/handoff": {
														version: 1,
														prepare: "_clio-coder/session/handoff/prepare",
														commit: "_clio-coder/session/handoff/commit",
														cancel: "_clio-coder/session/handoff/cancel",
													},
													"clio-coder/branches": {
														version: 1,
														tree: "_clio-coder/session/tree",
														switchTurn: "_clio-coder/session/switch_turn",
														fork: "_clio-coder/session/fork",
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
				update({ sessionUpdate: "available_commands_update", availableCommands: [] });
				result = {
					sessionId,
					...(ROUTE
						? { configOptions: configOptions(), _meta: { "clio-coder/session": { target: settings.chat.target } } }
						: {}),
					modes: {
						currentModeId: autonomy,
						availableModes: [
							{ id: "default", name: "Default" },
							{ id: "yolo", name: "Yolo" },
						],
					},
				};
				if (ROUTE)
					setTimeout(
						() => event("provider.health", { targetId: "fixture", status: "healthy", available: true, latencyMs: 5 }),
						50,
					);
				break;
			case "session/load":
				sessionId = frame.params.sessionId;
				result = {
					...(ROUTE
						? { configOptions: configOptions(), _meta: { "clio-coder/session": { target: settings.chat.target } } }
						: {}),
					modes: {
						currentModeId: autonomy,
						availableModes: [
							{ id: "default", name: "Default" },
							{ id: "yolo", name: "Yolo" },
						],
					},
				};
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
				pendingHandoff = null;
				const promptText = frame.params.prompt?.map((block) => block.text).join(" ") ?? "";
				const turnScenario =
					scenario === "markdown" && promptText.includes("[approval]")
						? "permission"
						: scenario === "markdown" && promptText.includes("[plan]")
							? "plan-permission"
							: scenario === "markdown" && promptText.includes("[stream]")
								? "loop"
								: scenario === "markdown" && promptText.includes("[workload")
									? "workload"
									: STEERING && promptText.includes("[fleet]")
										? "held-worker"
										: scenario;
				cancelled = false;
				if (scenario === "crash") process.exit(9);
				if (promptText.startsWith("/context recover ")) {
					await delay(40);
					text("The paused turn continued from the handoff.\n\nHandoff delivered.");
					result = { stopReason: "end_turn", _meta: { "clio-coder/usage": usage } };
					break;
				}
				if (promptText.startsWith("/council ")) {
					// The council's dispatch call is announced in the turn, as the agent's host does.
					update({
						sessionUpdate: "tool_call",
						toolCallId: "council-1",
						title: "dispatch",
						kind: "other",
						status: "in_progress",
						rawInput: { mode: "council", roster: "review", task: promptText.slice(9) },
					});
					await delay(60);
					update({
						sessionUpdate: "tool_call_update",
						toolCallId: "council-1",
						status: "completed",
						content: [{ type: "content", content: { type: "text", text: "council dispatched: 2 members" } }],
					});
					result = { stopReason: "end_turn", _meta: { "clio-coder/usage": usage } };
					break;
				}
				if (promptText.startsWith("/tasks ") || promptText.startsWith("/skill ")) {
					if (promptText.startsWith("/tasks ")) {
						const argv = promptText.slice(7).trim().split(/\s+/u);
						const notice = invokeTask(argv);
						if (argv[0] === "hand") {
							await delay(120);
							if (!cancelled) text("Working on the handed task");
						}
						text(`${argv[0] === "hand" ? "\n\n" : ""}${notice.lines.join("\n")}`);
					} else {
						await delay(120);
						if (!cancelled) text("Visible skill response");
					}
					result = { stopReason: cancelled ? "cancelled" : "end_turn", _meta: { "clio-coder/usage": usage } };
					break;
				}
				if (turnScenario === "plan-permission") await planPermission();
				else if (turnScenario.startsWith("permission")) await permission();
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
					const images = frame.params.prompt?.filter((block) => block.type === "image").length ?? 0;
					if (images > 0) text(`Received ${images} ${images === 1 ? "image" : "images"} with the request.\n\n`);
					const files = frame.params.prompt?.filter((block) => block.type === "resource").length ?? 0;
					if (files > 0) text(`Received ${files} ${files === 1 ? "file" : "files"} with the request.\n\n`);
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
					if (["gateway-chain", "gateway-chain-failed", "unrelated-chain"].includes(scenario)) {
						const failed = scenario === "gateway-chain-failed";
						const title = scenario === "unrelated-chain" ? "mcp_fixture__compose" : "gateway chain(grep, read, ls)";
						const steps = [
							{ id: "search", capability: "grep", args: { pattern: "TODO", path: "src" } },
							{ id: "read", capability: "read", args: { path: "src/x.ts" }, after: ["search"] },
							{ id: "later", capability: "ls", args: { path: "docs" }, after: ["read"] },
						];
						// The start, progress and terminal envelopes match ACP server.ts;
						// progress carries content only, so normalization must retain the input and title.
						update({
							sessionUpdate: "tool_call",
							toolCallId: "chain-1",
							name: scenario === "unrelated-chain" ? "mcp_fixture__compose" : "gateway",
							title,
							kind: "other",
							status: "in_progress",
							rawInput: { op: "chain", steps },
						});
						update({
							sessionUpdate: "tool_call_update",
							toolCallId: "chain-1",
							status: "in_progress",
							content: [{ type: "content", content: { type: "text", text: "Searching sources" } }],
						});
						const settled = failed ? steps.slice(0, 2) : steps;
						const body = failed
							? "Chain failed: 2 of 3 steps settled. Pending: later."
							: "Chain complete: 3 of 3 steps settled.";
						update({
							sessionUpdate: "tool_call_update",
							toolCallId: "chain-1",
							title,
							kind: "other",
							status: failed ? "failed" : "completed",
							content: [{ type: "content", content: { type: "text", text: body } }],
							rawOutput: {
								result: {
									content: [{ type: "text", text: body }],
									details: {
										op: "chain",
										pending: failed ? ["later"] : [],
										chainResults: settled.map((step) => ({
											id: step.id,
											capability: step.capability,
											args: step.args,
											isError: failed && step.id === "read",
											result: {
												content: [{ type: "text", text: failed && step.id === "read" ? "unavailable" : "ok" }],
												details: { kind: failed && step.id === "read" ? "error" : "ok" },
											},
										})),
									},
								},
								isError: failed,
							},
						});
					}
					if (scenario === "tool" || scenario === "tool-progress-no-content") {
						update({
							sessionUpdate: "tool_call",
							toolCallId: "read-1",
							title: "Read README",
							kind: "read",
							status: "in_progress",
							locations: [{ path: "README.md", line: 0 }],
							rawInput: { path: "README.md" },
						});
						if (scenario === "tool-progress-no-content") {
							update({
								sessionUpdate: "tool_call_update",
								toolCallId: "read-1",
								title: "Read README",
								kind: "read",
								status: "in_progress",
								content: [{ type: "content", content: { type: "text", text: "partial output" } }],
							});
							update({
								sessionUpdate: "tool_call_update",
								toolCallId: "read-1",
								title: "Read README",
								kind: "read",
								status: "in_progress",
							});
						}
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
			case "_clio-coder/commands/list":
				if (!COMMANDS) throw Error("method_not_found");
				result = COMMANDS;
				break;
			case "_clio-coder/commands/invoke": {
				if (!COMMANDS?.commands.some((row) => row.name === frame.params.command)) throw Error("command_not_exposed");
				const { command, argv = [] } = frame.params;
				if (command === "tasks") {
					result = invokeTask(argv);
					break;
				}
				result =
					command === "doctor"
						? { level: "success", lines: [argv.includes("deep") ? "Deep checks completed." : "Checks completed."] }
						: { level: "info", lines: [`Context action: ${argv.join(" ")}`] };
				break;
			}
			case "_clio-coder/session/board":
				if (!COMMANDS) throw Error("method_not_found");
				result = BOARD;
				break;
			case "_clio-coder/decisions/supersede": {
				const decision = BOARD.decisions.find(
					(row) => row.interviewId === frame.params.interviewId && row.key === frame.params.key,
				);
				if (!decision) {
					result = { status: "refused", reason: `decision ${frame.params.key} is not on the board` };
					break;
				}
				if (decision.status !== "active") {
					result = { status: "already_superseded" };
					break;
				}
				decision.status = "superseded";
				log({ superseded: decision.key, correction: frame.params.correction ?? null });
				if (frame.params.correction) decision.correction = frame.params.correction;
				result = {
					status: "superseded",
					...(frame.params.correction
						? {
								correctionTurn: `Decision "${decision.label}" (previously: ${decision.value}) is superseded by the operator. New direction: ${frame.params.correction}. Acknowledge and adjust the plan.`,
							}
						: {}),
				};
				break;
			}
			case "_clio-coder/memory/propose": {
				const entry = BOARD.memory.bank.find((row) => row.id === frame.params.entryId);
				if (!entry) {
					result = { status: "refused", reason: `task-bank entry ${frame.params.entryId} is not in this session` };
					break;
				}
				if (frame.params.scope === "global" && frame.params.acknowledgeGlobal !== true) {
					result = { status: "needs_acknowledgement", reason: "global scope broadens where this lesson applies" };
					break;
				}
				const recordId = `memory-${entry.id}-${frame.params.scope}`;
				proposedMemory.has(recordId) ? null : log({ proposed: recordId });
				result = { status: proposedMemory.has(recordId) ? "existing" : "proposed", recordId };
				proposedMemory.add(recordId);
				break;
			}
			case "_clio-coder/session/tree":
				if (!COMMANDS) throw Error("method_not_found");
				result = sessionTree();
				break;
			case "_clio-coder/session/switch_turn": {
				if (!COMMANDS) throw Error("method_not_found");
				if (!TREE_TURNS[frame.params.turnId]) throw Error("turn_unknown");
				treeLeaf = frame.params.turnId;
				const turns = replayPath(treeLeaf);
				result = {
					sessionId,
					leafId: treeLeaf,
					_meta: { "clio-coder/session": { replayed: { turns, truncated: false } } },
				};
				break;
			}
			// Rounds beside the conversation: nothing here touches the transcript or the turn state.
			case "_clio-coder/aside/ask":
				result = { status: "answered", text: "The readings are in README.md.", truncated: false };
				break;
			case "_clio-coder/aside/draft": {
				const drafts = [
					"Show the readings in one table with a unit column.",
					"List each sample with its reading and the date it was taken.",
					"endpoint reset",
					"Plot the readings and cite the table under the plot.",
				].slice(0, frame.params.count);
				const candidates = drafts.map((text, index) =>
					index === 2
						? { label: "C", status: "failed", reason: text }
						: { label: "ABCD"[index], status: "drafted", text, truncated: false },
				);
				result = {
					status: "drafted",
					aborted: false,
					candidates,
					judgment: candidates.some((candidate) => candidate.status === "failed")
						? { status: "unjudged", reason: "not judged: a draft failed or came back empty" }
						: {
								status: "judged",
								picked: "A",
								probabilities: Object.fromEntries(
									candidates.map((c, i) => [c.label, i === 0 ? 0.7 : 0.3 / (candidates.length - 1 || 1)]),
								),
								sound: Object.fromEntries(candidates.map((c, i) => [c.label, i === 0])),
								source: "fixture/judge",
								elapsedMs: 12,
							},
				};
				break;
			}
			case "_clio-coder/usage/read": {
				const cost = { knownUsd: 0.0421, calls: 3, estimated: false, unknown: false, free: false };
				result = {
					version: 1,
					session: {
						cost,
						tokens: 5200,
						rows: [
							{
								provider: "local",
								model: "fixture-model",
								runs: 2,
								calls: 3,
								tokens: { input: 4000, output: 1000, cacheRead: 150, cacheWrite: 50, reasoning: 0, total: 5200 },
								beside: { sideQuestions: 1, handoffs: 0, prewarms: 0, backgroundMemory: 0 },
								cost,
							},
						],
						truncated: false,
					},
					quota: {
						status: "read",
						providers: [
							{
								provider: "fixture-plan",
								name: "Fixture plan",
								status: "ok",
								plan: "Team",
								message: null,
								credits: null,
								stale: false,
								fetchedAt: "2026-09-26T10:00:00.000Z",
								retryAfterSeconds: null,
								windows: [
									{ label: "5h", usedPct: 71.4, resetsAt: "2026-09-26T13:00:00.000Z", scope: null, active: true },
									{ label: "Weekly", usedPct: 12, resetsAt: null, scope: null, active: false },
								],
							},
						],
					},
				};
				break;
			}
			case "_clio-coder/aside/cancel":
				result = { cancelled: false };
				break;
			case "_clio-coder/extensions/list":
				result = {
					version: 1,
					extensions: [
						{
							id: "survey-tools",
							name: "Survey tools",
							version: "1.2.0",
							description: "Field survey helpers",
							scope: "project",
							state: "eligible",
							runtime: false,
							problems: 0,
							diagnostics: [],
						},
						{
							id: "old-plotter",
							name: "Old plotter",
							version: "0.3.0",
							description: "Plots survey grids",
							scope: "user",
							state: "incompatible",
							runtime: false,
							problems: 1,
							diagnostics: ["requires Clio Coder 0.4 or earlier"],
						},
					],
					truncated: false,
				};
				break;
			case "_clio-coder/extensions/reload":
				extensionGeneration++;
				log({ extensionsReloaded: extensionGeneration });
				result = {
					status: "committed",
					generation: extensionGeneration,
					changed: false,
					added: 0,
					removed: 0,
					modified: 0,
					hooks: { registered: 2, dropped: 0, issues: 0, overridden: 0 },
					lines: [],
				};
				break;
			case "_clio-coder/library/reload":
				if (process.env.CLIO_CODER_WEB_FIXTURE_LIBRARY_RELOAD === "fail") {
					result = { status: "failed", error: "plugin tree digest mismatch" };
					break;
				}
				libraryGeneration++;
				log({ libraryReloaded: libraryGeneration });
				result = {
					status: "refreshed",
					generation: libraryGeneration,
					previousGeneration: libraryGeneration - 1,
					changed: true,
				};
				break;
			case "_clio-coder/context/ledger":
				if (!COMMANDS) throw Error("method_not_found");
				result = {
					version: 1,
					provider: "fixture",
					model: "fixture-model",
					contextWindow: 131072,
					contextWindowSource: "loaded",
					contextWindowSlots: null,
					usedTokens: 20480,
					reserveTokens: 16384,
					freeTokens: 94208,
					percent: 15.625,
					measured: true,
					compactionThreshold: 0.8,
					compactionAuto: true,
					projectPreload: null,
					projectHandbookFiles: ["CLIO-CODER.md"],
					toolCount: 14,
					groups: [
						{ category: "system", label: "System prompt", tokens: 4096, percent: 3.125 },
						{ category: "messages", label: "Conversation", tokens: 16384, percent: 12.5 },
					],
					lastCompaction: null,
					promptCache: {
						shellReused: true,
						cacheReadTokens: 8000,
						cacheWriteTokens: null,
						uncachedInputTokens: 400,
						backendVerdict: "hot",
					},
				};
				break;
			case "_clio-coder/fleet/preview":
				if (!COMMANDS) throw Error("method_not_found");
				result = fleetPreview(frame.params.name, frame.params.vars);
				break;
			case "_clio-coder/fleet/run": {
				if (!COMMANDS) throw Error("method_not_found");
				const preview = fleetPreview(frame.params.name, frame.params.vars);
				if (preview.status !== "ready") result = preview;
				else if (preview.planHash !== frame.params.planHash)
					result = {
						status: "changed",
						name: preview.name,
						planHash: preview.planHash,
						reason: "the plan changed since it was previewed; review it again. Nothing was dispatched",
					};
				else if (frame.params.vars?.site === "blocked")
					result = {
						status: "failed",
						name: preview.name,
						planHash: preview.planHash,
						fleetRootId: "fleet-0123456789ab",
						reason: "dispatch: agent 'writer' is not admitted for this task",
					};
				else {
					log({ fleetStarted: preview.planHash });
					result = {
						status: "started",
						name: preview.name,
						planHash: preview.planHash,
						fleetRootId: "fleet-0123456789ab",
						stepCount: 2,
					};
				}
				break;
			}
			case "_clio-coder/session/handoff/prepare": {
				if (!COMMANDS) throw Error("method_not_found");
				const goal = frame.params.goal.trim();
				if (goal.length < 12) {
					result = {
						status: "refused",
						level: "warn",
						code: "goal",
						reason: `/handoff needs a goal of at least 12 characters; "${goal}" is ${goal.length}`,
					};
					break;
				}
				await delay(40);
				pendingHandoff = { handoffId: randomUUID(), sessionId };
				result = {
					status: "ready",
					handoffId: pendingHandoff.handoffId,
					goal,
					fromSessionId: sessionId,
					document: `# Handoff\n\nGoal: ${goal}\n\n## Facts\n\n- The second sample reads 4.2.\n`,
				};
				break;
			}
			case "_clio-coder/session/handoff/commit": {
				if (!COMMANDS) throw Error("method_not_found");
				if (pendingHandoff?.handoffId !== frame.params.handoffId || pendingHandoff.sessionId !== sessionId) {
					result = { status: "refused", level: "warn", code: "stale", reason: "draw it up again" };
					break;
				}
				if (frame.params.document.trim() === "") {
					result = { status: "refused", level: "warn", code: "empty", reason: "the reviewed document was empty" };
					break;
				}
				pendingHandoff = null;
				const fromSessionId = sessionId;
				sessionId = randomUUID();
				treeLeaf = "u1";
				log({ handedOff: sessionId, from: fromSessionId, document: frame.params.document });
				update({ sessionUpdate: "available_commands_update", availableCommands: [] });
				result = {
					status: "committed",
					sessionId,
					fromSessionId,
					warnings: [],
					configOptions: configOptions(),
					_meta: { "clio-coder/session": { resumed: false } },
				};
				break;
			}
			case "_clio-coder/session/handoff/cancel": {
				const cancelled = pendingHandoff?.handoffId === frame.params.handoffId;
				if (cancelled) pendingHandoff = null;
				result = { cancelled };
				break;
			}
			case "_clio-coder/session/fork": {
				if (!COMMANDS) throw Error("method_not_found");
				const turnId = frame.params.turnId;
				if (!TREE_TURNS[turnId]) throw Error("turn_unknown");
				const parentSessionId = sessionId;
				sessionId = randomUUID();
				treeLeaf = turnId;
				update({ sessionUpdate: "available_commands_update", availableCommands: [] });
				const turns = replayPath(turnId);
				log({ forked: sessionId, from: parentSessionId, at: turnId });
				result = {
					sessionId,
					parentSessionId,
					parentTurnId: turnId,
					configOptions: configOptions(),
					_meta: { "clio-coder/session": { resumed: true, replayed: { turns, truncated: false } } },
				};
				break;
			}
			case "_clio-coder/session/steer": {
				const followUp = frame.params.mode === "end-of-turn";
				(followUp ? queues.followUp : queues.steer).push(frame.params.text);
				result = { accepted: true, queue: followUp ? "follow-up" : "steer" };
				break;
			}
			case "_clio-coder/session/queue":
				result = queues;
				break;
			case "_clio-coder/session/queue_clear":
				result = { restored: [...queues.steer.splice(0), ...queues.followUp.splice(0)] };
				break;
			case "_clio-coder/session/interrupt":
				result = { cancelled: false, refusal: "A dispatched worker is attached; stop the turn instead." };
				break;
			case "_clio-coder/dispatch/steer": {
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
			case "_clio-coder/settings/patch_safe":
				for (const [key, value] of Object.entries(frame.params.patch)) {
					if (!editable.includes(key)) throw Error("invalid_params");
					const [group, name] = key.split(".");
					settings[group][name] = value;
				}
				result = { settings, editable };
				if (ROUTE)
					update(
						{ sessionUpdate: "config_option_update", configOptions: configOptions() },
						{ "clio-coder/session": { target: settings.chat.target } },
					);
				break;
			case "_clio-coder/settings/get_safe":
				result = { settings, editable, privateCredential: "must-be-stripped" };
				break;
			case "_clio-coder/targets/list":
				result = {
					targets: [
						{
							id: "fixture",
							runtime: "openai-compatible",
							models: ["fixture-model", "fixture-small"],
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
			case "_clio-coder/targets/probe":
				result = { targetId: frame.params.targetId, healthy: true, latencyMs: 5, reason: null };
				break;
			case "session/set_config_option": {
				const option = configOptions().find((row) => row.id === frame.params.configId);
				if (!option?.options.some((row) => row.value === frame.params.value)) throw Error("invalid_params");
				settings.chat[frame.params.configId] = frame.params.value;
				update({ sessionUpdate: "config_option_update", configOptions: configOptions() });
				result = { configOptions: configOptions() };
				break;
			}
			case "session/set_mode":
				autonomy = frame.params.modeId;
				update({ sessionUpdate: "current_mode_update", currentModeId: autonomy });
				update({ sessionUpdate: "config_option_update", configOptions: ROUTE ? configOptions() : [] });
				break;
			case "_clio-coder/session/label":
			case "session/delete":
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
