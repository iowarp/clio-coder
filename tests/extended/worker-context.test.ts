import { deepStrictEqual, equal, match, notEqual, ok, throws } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { workerAgent } from "../../src/core/telemetry/context.js";
import {
	createTelemetryForwarder,
	readWorkerTelemetryFrame,
	type WorkerTelemetryFrame,
} from "../../src/core/telemetry/forwarder.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import type { ContextFoldPayload } from "../../src/core/telemetry/live-events.js";
import type { ToolName } from "../../src/core/tool-names.js";
import { resultContractRepairMessages } from "../../src/domains/agents/result-contract.js";
import { parseWorkerContextPolicy } from "../../src/domains/context/worker/contract.js";
import { createWorkerContextGuard } from "../../src/domains/context/worker/pressure.js";
import { createWorkerObservationStore } from "../../src/domains/context/worker/recall.js";
import { selectWorkerContext } from "../../src/domains/context/worker/select.js";
import { captureWorkerContext, completeHistoryLength, contextHash } from "../../src/domains/context/worker/snapshot.js";
import { persistWorkerContextSeed } from "../../src/domains/context/worker/store.js";
import { renderMarker } from "../../src/domains/context/working-set/marker.js";
import { createWorkerOutputCapture } from "../../src/domains/dispatch/event-pump.js";
import type { RunRole } from "../../src/domains/dispatch/obligation.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import { LOCAL_CONTEXT_OVERFLOW_PREFIX } from "../../src/engine/apis/output-budget.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { boundWorkerResponse } from "../../src/engine/worker-response-stream.js";
import { startWorkerRun, type WorkerRunHandle } from "../../src/engine/worker-runtime.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createDispatchAdmissionController } from "../../src/tools/dispatch-admission.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import { parseWorkerContextSeed, seededWorkerMessages, seedRecallLineage } from "../../src/worker/context-seed.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { settledRunTrust } from "../harness/settled-run.js";

const source = { sessionId: "parent", leafTurnId: "leaf", cwd: "/repo" };
function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 };
}
function assistant(id?: string, path = "src/a.ts", name = "read"): AgentMessage {
	return {
		role: "assistant",
		content: id ? [{ type: "toolCall", id, name, arguments: { path } }] : [{ type: "text", text: "Done." }],
		stopReason: id ? "toolUse" : "stop",
		timestamp: 2,
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function result(id: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError,
		timestamp: 3,
	};
}
function history(): AgentMessage[] {
	return [
		user("Preserve compatibility."),
		assistant("read-a"),
		result("read-a", "EXACT A\nline 2"),
		assistant("dispatch", "", "dispatch"),
	];
}

test("capture drops the complete pending dispatch batch and copies nested state", () => {
	const original = history();
	const snapshot = captureWorkerContext(source, original);
	equal(snapshot.messages.length, 3);
	equal(snapshot.excludedTailMessages, 1);
	const before = JSON.stringify(snapshot);
	const message = original[1];
	if (message?.role === "assistant" && message.content[0]?.type === "toolCall")
		message.content[0].arguments.path = "changed";
	equal(JSON.stringify(snapshot), before);
	const worker = seededWorkerMessages(selectWorkerContext(snapshot, { mode: "fork" }));
	const child = worker[1];
	if (child?.role === "assistant" && child.content[0]?.type === "toolCall") child.content[0].arguments.path = "child";
	equal(JSON.stringify(snapshot), before);
});

test("a partial final multi-tool batch is dropped atomically and malformed historical pairs fail", () => {
	const batch = assistant("one");
	if (batch.role === "assistant") batch.content.push({ type: "toolCall", id: "two", name: "read", arguments: {} });
	equal(completeHistoryLength([user("task"), batch, result("one", "done")], true), 1);
	throws(() => captureWorkerContext(source, [batch, user("interrupt")]), /incomplete historical/);
	throws(() => completeHistoryLength([result("orphan", "bad")]), /orphaned/);
	throws(() => completeHistoryLength([assistant("one"), result("one", "a"), result("one", "b")]), /duplicate/);
});

test("a resumed conversation follows Pi's interrupted-response filter and records the exclusion", () => {
	const interrupted = assistant("interrupted");
	if (interrupted.role === "assistant") interrupted.stopReason = "aborted";
	const snapshot = captureWorkerContext(source, [
		user("Keep this constraint."),
		interrupted,
		result("interrupted", "INCOMPLETE_DATA", true),
		user("Continue the task."),
		assistant("complete"),
		result("complete", "COMPLETE_DATA"),
	]);
	equal(snapshot.excludedInterruptedMessages, 2);
	equal(snapshot.excludedTailMessages, 0);
	const fork = selectWorkerContext(snapshot, { mode: "fork" });
	parseWorkerContextSeed(fork);
	match(JSON.stringify(fork.messages), /Keep this constraint/);
	match(JSON.stringify(fork.messages), /COMPLETE_DATA/);
	ok(!JSON.stringify(fork.messages).includes("INCOMPLETE_DATA"));
	equal(fork.provenance.excludedInterruptedMessages, 2);
});

test("splice selects exact path evidence without unrelated assistant conclusions or stale duplicate reads", () => {
	const messages = [
		user("Keep the public API."),
		assistant("old"),
		result("old", "STALE"),
		assistant("new"),
		result("new", "CURRENT"),
		assistant("other", "src/b.ts"),
		result("other", "UNRELATED"),
		assistant(),
	];
	const seed = selectWorkerContext(captureWorkerContext(source, messages), { mode: "splice", paths: ["src/a.ts"] });
	const packet = JSON.stringify(seed.messages);
	match(packet, /Keep the public API/);
	match(packet, /CURRENT/);
	ok(!packet.includes("STALE") && !packet.includes("UNRELATED") && !packet.includes("Done."));
	deepStrictEqual(seed.provenance.selectedRefs, ["message:0", "tool:new"]);
	ok(seed.provenance.omittedMessages > 0);
	deepStrictEqual(seededWorkerMessages(seed), [], "portable splices ride dynamic prompt messages exactly once");
});

test("explicit refs override selection but cannot escape the frozen snapshot or silently exceed the budget", () => {
	const snapshot = captureWorkerContext(source, [
		user("task"),
		assistant("a"),
		result("a", "A"),
		assistant("b", "src/b.ts"),
		result("b", "B"),
	]);
	const seed = selectWorkerContext(snapshot, { mode: "splice", paths: ["src/a.ts"], refs: ["tool:b"] });
	match(JSON.stringify(seed.messages), /parent observation.*?B/);
	throws(() => selectWorkerContext(snapshot, { mode: "splice", refs: ["tool:foreign"] }), /unknown refs/);
	const large = captureWorkerContext(source, [user("mandatory ".repeat(5000))]);
	throws(() => selectWorkerContext(large, { mode: "splice", max_tokens: 256 }), /required user context/);
	throws(() => selectWorkerContext(large, { mode: "fork", max_tokens: 256 }), /fork exceeds/);
});

test("strict policies reject hidden history, misspellings, invalid bounds and isolated selectors", () => {
	for (const policy of [
		null,
		{ mode: "auto" },
		{ mode: "fork", messages: [] },
		{ mode: "isolated", refs: ["a"] },
		{ mode: "splice", max_tokens: 1.5 },
		{ mode: "splice", paths: [] },
	])
		throws(() => parseWorkerContextPolicy(policy));
	deepStrictEqual(parseWorkerContextPolicy({ mode: "splice", paths: [" a ", "a"] }), { mode: "splice", paths: ["a"] });
});

test("wire validation and stored evidence bind both source metadata and exact transferred messages", async () => {
	const env = await isolateClioEnv("clio-coder-context-seed-");
	try {
		const seed = selectWorkerContext(captureWorkerContext(source, history()), { mode: "fork" });
		deepStrictEqual(parseWorkerContextSeed(JSON.parse(JSON.stringify(seed))), seed);
		const stored = persistWorkerContextSeed(seed);
		deepStrictEqual(parseWorkerContextSeed(JSON.parse(readFileSync(stored, "utf8"))), seed);
		const tampered = structuredClone(seed);
		tampered.provenance.source.sessionId = "other";
		throws(() => parseWorkerContextSeed(tampered), /digest-mismatched/);
		const second = selectWorkerContext(captureWorkerContext({ ...source, leafTurnId: "other" }, history()), {
			mode: "fork",
		});
		notEqual(second.provenance.contentHash, seed.provenance.contentHash);
	} finally {
		env.restore();
	}
});

test("admission reads the operator turn once, captures the seed once and preserves it while parent and arguments change", () => {
	let captures = 0;
	const parent = history();
	const admission = createDispatchAdmissionController({
		dispatch: {} as never,
		getAgentSpecs: () => [],
		captureWorkerContext: () => {
			captures++;
			return captureWorkerContext(source, parent);
		},
	});
	const args = admission.prepareAdmissionArguments({
		agent: "scout",
		mode: "sequential",
		tasks: ["one", { task: "two", context: { mode: "isolated" } }],
		context: { mode: "fork" },
	});
	equal(args[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
	// One read of the operator turn and one capture of the inheriting seed, as the production dispatch test counts.
	equal(captures, 2);
	const snapshot = admission.state.trustedExecutionSnapshots.get(args);
	ok(snapshot?.kind === "dispatch");
	const before = JSON.stringify(snapshot.requests);
	parent.push(user("LATER"));
	args.context = { mode: "isolated" };
	equal(admission.prepareArguments(args), args);
	equal(JSON.stringify(snapshot.requests), before);
	ok(snapshot.requests[0]?.contextSeed);
	equal(snapshot.requests[1]?.contextSeed, undefined);
});

type ToolCallBlock = Extract<(AgentMessage & { role: "assistant" })["content"][number], { type: "toolCall" }>;
function call(id: string, calls: ReadonlyArray<[string, string, ToolCallBlock["arguments"]]>): AgentMessage {
	const message = assistant(id);
	if (message.role === "assistant")
		message.content = calls.map(([callId, name, args]) => ({ type: "toolCall", id: callId, name, arguments: args }));
	return message;
}
function refusal(id: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "gateway",
		content: [{ type: "text", text }],
		isError: true,
		timestamp: 3,
	};
}
const gatewayFetch = { op: "call", capability: "web_fetch", args: { url: "https://example.test/spec" } };
const refuseArchive = () => {
	throw new Error("must not archive");
};

test("worker fold leaves the first request untrimmed and keeps exhaustion an error", () => {
	const decisions: ContextFoldPayload[] = [];
	const onDecision = (decision: ContextFoldPayload) => void decisions.push(decision);
	const input = { systemPrompt: "worker", tools: [], contextWindow: 5000, outputReserve: () => 500 };
	// Parent usage never anchors the child's first request.
	const inherited = assistant();
	if (inherited.role === "assistant") inherited.usage.input = 1_000_000;
	const small = [user("task"), inherited];
	deepStrictEqual(createWorkerContextGuard(refuseArchive)({ ...input, messages: small }), small);
	const evictable = [
		user("task"),
		assistant("large"),
		result("large", "data ".repeat(4000)),
		assistant("small"),
		result("small", "small"),
		assistant("last"),
		result("last", "last"),
	];
	const raw = JSON.stringify(evictable);
	throws(
		() => createWorkerContextGuard(refuseArchive, { onDecision })({ ...input, messages: evictable }),
		/initial request/,
	);
	equal(JSON.stringify(evictable), raw);
	deepStrictEqual(decisions.at(-1)?.stages, [
		{ stage: "working_set", outcome: "none", reason: "protected_recent" },
		{ stage: "stop", outcome: "failed", reason: "error" },
	]);
	equal(decisions.at(-1)?.checkpoint, "submit");
	const disabled = createWorkerContextGuard(refuseArchive, { onDecision });
	disabled({ ...input, messages: [user("task")] });
	throws(() => disabled({ ...input, autoEvict: false, messages: evictable }), /automatic eviction disabled/);
	deepStrictEqual(decisions.at(-1)?.stages[0], { stage: "working_set", outcome: "none", reason: "disabled" });
	equal(disabled.records.length, 0);
});

test("an old thinking block leaves without a marker while refusals and opaque tools stay protected", () => {
	const decisions: ContextFoldPayload[] = [];
	const guard = createWorkerContextGuard(refuseArchive, { onDecision: (decision) => void decisions.push(decision) });
	const input = { systemPrompt: "worker", tools: [], contextWindow: 5000, outputReserve: () => 500 };
	guard({ ...input, messages: [user("task")] });
	const thinking = assistant();
	if (thinking.role === "assistant")
		thinking.content = [
			{ type: "thinking", thinking: "deliberation ".repeat(923) },
			{ type: "text", text: "RETAINED_ANSWER" },
		];
	const messages = [
		user("task"),
		call("gw", [["gw", "gateway", gatewayFetch]]),
		refusal("gw", "GATEWAY_REFUSAL ".repeat(200)),
		call("probe", [["probe", "mcp_probe", { target: "svc" }]]),
		{ ...(result("probe", "OPAQUE_PROBE ".repeat(230)) as AgentMessage & { role: "toolResult" }), toolName: "mcp_probe" },
		thinking,
		user("continue"),
		assistant("next"),
		result("next", "next"),
		assistant("last"),
		result("last", "last"),
	];
	const raw = JSON.stringify(messages);
	const projected = guard({ ...input, messages });
	const text = JSON.stringify(projected);
	ok(!text.includes("deliberation") && text.includes("RETAINED_ANSWER"));
	ok(text.includes("GATEWAY_REFUSAL") && text.includes("OPAQUE_PROBE") && !text.includes("[evicted"));
	equal(JSON.stringify(messages), raw);
	equal(guard.records.length, 1);
	deepStrictEqual(
		guard.records[0]?.evicted.map(({ alias, reason, marker }) => ({ alias, reason, marker })),
		[{ alias: undefined, reason: "thinking_turn_closed", marker: "" }],
	);
	deepStrictEqual(decisions.at(-1)?.stages, [
		{ stage: "working_set", outcome: "committed", reason: "evicted", recordId: "eviction-1" },
	]);
	// The same history renders the same request and commits nothing new.
	deepStrictEqual(guard({ ...input, messages }), projected);
	equal(guard.records.length, 1);
});

test("the bypass rows: a step short of output room and a rejected later send each commit one record", () => {
	const archived: string[] = [];
	const decisions: ContextFoldPayload[] = [];
	const guard = createWorkerContextGuard((alias) => void archived.push(alias), {
		onDecision: (decision) => void decisions.push(decision),
	});
	// Under the trigger and the window, but the reserve does not fit: the protected step's read leaves, the refusal stays.
	// The closing answer means the model has seen the read, so it leaves as step_overflow with the advice.
	const tight = { systemPrompt: "worker", tools: [], contextWindow: 10_000, outputReserve: () => 4000 };
	guard({ ...tight, messages: [user("task")] });
	const step = [
		user("task"),
		call("batch", [
			["big", "read", { path: "src/big.ts" }],
			["gw", "gateway", gatewayFetch],
		]),
		result("big", "data ".repeat(5000)),
		refusal("gw", "GATEWAY_REFUSAL ".repeat(250)),
		assistant(),
	];
	const text = JSON.stringify(guard({ ...tight, messages: step }));
	match(text, /\[evicted ref=r1 reason=step_overflow tool=read path=src\/big\.ts /);
	match(text, /Read only the part you need/);
	ok(text.includes("GATEWAY_REFUSAL"));
	deepStrictEqual(archived, ["r1"]);
	// The journal tells this commit from an aged one.
	deepStrictEqual(decisions.at(-1)?.stages.at(-1), {
		stage: "working_set",
		outcome: "committed",
		reason: "step_overflow",
		recordId: "eviction-1",
	});

	// An unreported window admits every send; only the server's rejection acts, once, to 0.7 of the failed request.
	const unknown = { systemPrompt: "worker", tools: [], contextWindow: 0, outputReserve: () => 4000 };
	const later = createWorkerContextGuard((alias) => void archived.push(alias));
	later({ ...unknown, messages: [user("task")] });
	equal(later.recover({ ...unknown, messages: [user("task")] }), null, "the first request is never trimmed");
	const messages = [
		user("task"),
		assistant("old"),
		result("old", "alpha ".repeat(2000)),
		assistant("mid"),
		result("mid", "beta ".repeat(2000)),
		assistant("last"),
		result("last", "gamma ".repeat(400)),
	];
	deepStrictEqual(later({ ...unknown, messages }), messages);
	const recovered = later.recover({ ...unknown, messages });
	ok(recovered);
	const record = later.records[0];
	equal(record?.checkpoint, "overflow");
	ok(record && record.tokensAfter <= record.tokensBefore * 0.7, JSON.stringify(record));
	deepStrictEqual(archived, ["r1", "r1"]);
	deepStrictEqual(later({ ...unknown, messages }), recovered);
	const stuck = createWorkerContextGuard(refuseArchive);
	stuck({ ...unknown, messages: [user("task")] });
	const refused = [user("task"), call("gw", [["gw", "gateway", gatewayFetch]]), refusal("gw", "x".repeat(8000))];
	stuck({ ...unknown, messages: refused });
	equal(stuck.recover({ ...unknown, messages: refused }), null, "no retry unless the target is reached");
	equal(stuck.records.length, 0);
});

function pump(n: number, lines: number): AgentMessage[] {
	return [
		assistant(`p${n}`, `pumps/pump-${n}.c`),
		result(`p${n}`, `PUMP-${n} ${"line of pump output\n".repeat(lines)}`),
	];
}

test("drv-cf1h: short of headroom under the trigger, older reads leave before the read the model has not seen (A2a)", () => {
	const decisions: ContextFoldPayload[] = [];
	const archived: string[] = [];
	const guard = createWorkerContextGuard((alias) => void archived.push(alias), {
		onDecision: (decision) => void decisions.push(decision),
	});
	// 26,030 tokens under a 26,214 trigger (0.8 of 32,768); the 8,192 reserve leaves room for 24,576.
	const input = { systemPrompt: "w".repeat(81_088), tools: [], contextWindow: 32_768, outputReserve: () => 8192 };
	guard({ ...input, messages: [user("task")] });
	// pump-1..3 sit before the last two steps, pump-4 was seen by the last answer, pump-5 just landed.
	const messages = [user("task"), ...[1, 2, 3, 4].flatMap((n) => pump(n, 200)), ...pump(5, 300)];
	const projected = guard({ ...input, messages });
	equal(decisions.at(-1)?.tokensBefore, 26_030);
	ok((decisions.at(-1)?.tokensAfter ?? Number.POSITIVE_INFINITY) + 8192 <= 32_768, JSON.stringify(decisions.at(-1)));
	deepStrictEqual(
		guard.records[0]?.evicted.map(({ ref, reason }) => [ref.entry, reason]),
		[
			["2", "age_horizon"],
			["4", "age_horizon"],
		],
	);
	equal(decisions.at(-1)?.stages.at(-1)?.reason, "evicted");
	deepStrictEqual(archived, ["r1", "r2"]);
	const text = JSON.stringify(projected);
	ok(text.includes("PUMP-3") && text.includes("PUMP-4") && text.includes("PUMP-5"), "pump-3..5 keep their bodies");
	ok(
		!/path=pumps\/pump-5\.c|Read only the part you need|step_overflow/.test(text),
		"no re-read prompt for the fresh read",
	);
	// The next round keeps the fresh read the model has now seen, with no advice anywhere.
	const next = JSON.stringify(guard({ ...input, messages: [...messages, assistant()] }));
	ok(next.includes("PUMP-5") && !/Read only the part you need/.test(next));
});

test("only unseen reads can make room: the largest leaves first as unseen_overflow, after every seen read (A2b)", () => {
	const decisions: ContextFoldPayload[] = [];
	const guard = createWorkerContextGuard(() => {}, { onDecision: (decision) => void decisions.push(decision) });
	const tight = { systemPrompt: "worker", tools: [], contextWindow: 10_000, outputReserve: () => 4000 };
	guard({ ...tight, messages: [user("task")] });
	const batch = call("batch", [
		["small", "read", { path: "src/small.ts" }],
		["large", "read", { path: "src/large.ts" }],
		["mid", "read", { path: "src/mid.ts" }],
	]);
	const unseen = [
		batch,
		result("small", "SMALL ".repeat(1000)),
		result("large", "LARGE ".repeat(3000)),
		result("mid", "MID ".repeat(2000)),
	];
	const text = JSON.stringify(guard({ ...tight, messages: [user("task"), ...unseen] }));
	deepStrictEqual(
		guard.records[0]?.evicted.map(({ ref, reason }) => [ref.entry, reason]),
		[["3", "unseen_overflow"]],
	);
	match(text, /\[evicted ref=r1 reason=unseen_overflow tool=read path=src\/large\.ts /);
	ok(!/Read only the part you need/.test(text), "the model never saw the body; it needs the recall pointer only");
	ok(text.includes("SMALL") && text.includes("MID "));
	// The run journal names the unseen commit, and the worker's forwarder carries it to the parent.
	const decision = decisions.at(-1);
	deepStrictEqual(decision?.stages, [
		{ stage: "working_set", outcome: "committed", reason: "unseen_overflow", recordId: "eviction-1" },
	]);
	const run = { sessionId: null, runId: "unseen-run", agent: { role: "worker" as const, id: "unseen-run" } };
	const frames: WorkerTelemetryFrame[] = [];
	// A queue of one under output backpressure drops the second process fact and reports it, never the decision.
	const forwarder = createTelemetryForwarder(
		run,
		{ host: "worker", pid: 1, birthToken: "unseen-birth", monoEpochWallMs: 0 },
		(frame) => void frames.push(frame),
		1,
	);
	telemetryHub().emit("process.started", {}, run);
	telemetryHub().emit("process.started", {}, run);
	telemetryHub().emit("context.fold", decision as ContextFoldPayload, run);
	forwarder.close();
	deepStrictEqual(
		frames.map((frame) => frame.record.k),
		["process.started", "context.fold", "journal.gap"],
	);
	deepStrictEqual(
		(readWorkerTelemetryFrame(frames[1], run)?.data as ContextFoldPayload | undefined)?.stages.at(-1)?.reason,
		"unseen_overflow",
	);

	// A seen protected read leaves first on the headroom path and on the server's rejection alike.
	const seen = [
		user("task"),
		call("old", [["old", "read", { path: "src/old.ts" }]]),
		result("old", "OLD ".repeat(3000)),
	];
	const orderedDecisions: ContextFoldPayload[] = [];
	const ordered = createWorkerContextGuard(() => {}, {
		onDecision: (decision) => void orderedDecisions.push(decision),
	});
	ordered({ ...tight, messages: [user("task")] });
	const fitted = JSON.stringify(ordered({ ...tight, messages: [...seen, ...unseen] }));
	deepStrictEqual(
		ordered.records[0]?.evicted.map(({ ref, reason }) => [ref.entry, reason]),
		[
			["2", "step_overflow"],
			["5", "unseen_overflow"],
		],
	);
	ok(fitted.includes("SMALL") && fitted.includes("MID "));
	// A commit that also took an unseen read is journaled as unseen_overflow.
	equal(orderedDecisions.at(-1)?.stages.at(-1)?.reason, "unseen_overflow");
	const unknown = { ...tight, contextWindow: 0 };
	const rejected = createWorkerContextGuard(() => {});
	rejected({ ...unknown, messages: [user("task")] });
	rejected({ ...unknown, messages: [...seen, ...unseen] });
	ok(rejected.recover({ ...unknown, messages: [...seen, ...unseen] }));
	deepStrictEqual(
		rejected.records[0]?.evicted.map(({ ref, reason }) => [ref.entry, reason]),
		[
			["2", "step_overflow"],
			["5", "unseen_overflow"],
		],
	);
});

test("drv-cf1h: a request the guard fitted after an eviction reaches the provider without an admission refusal (A2c)", {
	timeout: 20_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-guard-admission-");
	const requests: Array<Record<string, unknown>> = [];
	// The third answer reports the provider's own count, well above Clio's: that usage anchors the next request.
	const script = [
		{ read: "a.txt", promptTokens: 1000 },
		{ read: "b.txt", promptTokens: 6000 },
		{ read: "c.txt", promptTokens: 21_000 },
	];
	const server = createServer(async (req, res) => {
		const body = JSON.parse(await readRequestBody(req)) as { messages?: Array<{ role?: string }> };
		requests.push(body);
		const step = script[(body.messages ?? []).filter((message) => message.role === "tool").length];
		const frame = (data: unknown) => `data: ${JSON.stringify({ model: "dynamo/qwen3.8-27b", ...(data as object) })}\n\n`;
		const usage = { prompt_tokens: step?.promptTokens ?? 21_000, completion_tokens: 20 };
		res.setHeader("content-type", "text/event-stream");
		res.end(
			(step
				? frame({
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: `call-${step.read}`,
											type: "function",
											function: { name: "read", arguments: JSON.stringify({ path: step.read }) },
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage,
					})
				: frame({ choices: [{ index: 0, delta: { content: "Complete." }, finish_reason: "stop" }], usage })) +
				"data: [DONE]\n\n",
		);
	});
	let worker: WorkerRunHandle | undefined;
	const previousCwd = process.cwd();
	try {
		// Worker tools resolve paths against the process, as a spawned worker's would against its cwd.
		process.chdir(env.dir);
		for (const name of ["a.txt", "b.txt", "c.txt"])
			writeFileSync(join(env.dir, name), `${name} ${"pump output line of forty characters.\n".repeat(400)}`);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const events: unknown[] = [];
		worker = startWorkerRun(
			{
				agentId: "guard-admission-fixture",
				systemPrompt: "Read the files, then reply Complete.",
				task: "Read a.txt, b.txt and c.txt.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "dynamo/qwen3.8-27b",
				apiKey: "fixture",
				modelCapabilities: { contextWindow: 32_768, maxTokens: 32_768, tools: true },
				allowedTools: ["read"],
				budget: { mode: "advisory", toolCalls: 40, synthesis: true, hardCap: 60 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
			},
			(event) => void events.push(event),
		);
		const outcome = await worker.promise;
		const text = JSON.stringify(events);
		ok(!text.includes(LOCAL_CONTEXT_OVERFLOW_PREFIX), "no admission refusal after the guard's eviction");
		equal(outcome.exitCode, 0);
		equal(requests.length, 4);
		const last = JSON.stringify(requests[3]);
		match(last, /\[evicted ref=r1 reason=age_horizon tool=read path=a\.txt /);
		ok(last.includes("c.txt pump output"), "the fresh read reached the provider");
		ok(Number(requests[3]?.max_tokens) >= 4096, `max_tokens ${requests[3]?.max_tokens}`);
		// A pinned request cut off by its window names the remaining context, read from the same pin (cf-q11).
		const truncated = { role: "assistant", content: [], stopReason: "length", timestamp: 1, usage: {} };
		const limits: string[] = [];
		await boundWorkerResponse(
			{ id: "pinned", api: "openai-completions", contextWindow: 32_768, maxTokens: 32_768 } as never,
			{ messages: [] },
			{ clioInputTokens: 20_000 } as never,
			{ locked: true, responseSeconds: 600, round: 1, onLimit: (_code, detail) => void limits.push(detail) },
			() => ({ async *[Symbol.asyncIterator]() {}, result: async () => truncated }) as never,
		).result();
		match(limits.join(), /output limit \(remaining context\)$/);
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
});

test("a first splice with no usage anchor is fitted at the transport's own count (Astra #4)", {
	timeout: 20_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-unanchored-splice-");
	// Within the guard's trigger and fit at chars/4, but over the window at Pi's chars/3.5.
	const seed = selectWorkerContext(captureWorkerContext(source, [user("evidence ".repeat(21_000))]), {
		mode: "splice",
		max_tokens: 60_000,
	});
	const packet = seed.messages[0];
	const body =
		packet?.role === "user" && Array.isArray(packet.content)
			? packet.content.map((b) => (b.type === "text" ? b.text : "")).join("")
			: "";
	const events: unknown[] = [];
	let worker: WorkerRunHandle | undefined;
	try {
		worker = startWorkerRun(
			{
				// The splice rides as the dispatch packet's prompt message, as `buildDynamicPromptMessages` sends it.
				dynamicPromptMessages: [{ id: "dispatch-worker-context", body, contentHash: "fixture" }],
				agentId: "unanchored-splice-fixture",
				systemPrompt: "Answer from the inherited evidence.",
				task: "Summarize the evidence.",
				target: { id: "fixture", runtime: "litellm", url: "http://127.0.0.1:9" },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				modelCapabilities: { contextWindow: 65_536, maxTokens: 32_768, tools: true },
				allowedTools: [],
				budget: { mode: "advisory", toolCalls: 4, synthesis: true, hardCap: 8 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
				contextSeed: seed,
			},
			(event) => void events.push(event),
		);
		const outcome = await worker.promise;
		const text = JSON.stringify(events);
		ok(!text.includes(LOCAL_CONTEXT_OVERFLOW_PREFIX), "the guard, not the transport, refuses the splice");
		match(text, /"outcomeCode":"worker_context_exhausted"/);
		notEqual(outcome.exitCode, 0);
	} finally {
		worker?.abort();
		await worker?.promise;
		env.restore();
	}
});

type FauxStep = {
	call: { name: string; arguments: Record<string, unknown> } | null;
	content?: string;
	promptTokens: number;
};

/** One worker run against a faux provider that answers each request by the count of tool results it carries (CLI-H3). */
async function runFauxWorker(
	dir: string,
	step: (done: number, requests: number) => FauxStep,
	options: {
		agentId: string;
		task: string;
		allowedTools: ToolName[];
		readOnly?: boolean;
		contextWindow?: number;
		role?: RunRole;
		runId?: string;
		mutationReport?: true;
		product?: "orientation";
		/** An operator steer sent while the request with this many tool results is answered. */
		steerAt?: number;
	},
): Promise<{ requests: string[]; events: unknown[]; exitCode: number }> {
	const requests: string[] = [];
	const server = createServer(async (req, res) => {
		const raw = await readRequestBody(req);
		requests.push(raw);
		const body = JSON.parse(raw) as { messages?: Array<{ role?: string }> };
		const done = (body.messages ?? []).filter((message) => message.role === "tool").length;
		if (options.steerAt === done) worker?.steer?.("Keep going.");
		const { call, content, promptTokens } = step(done, requests.length);
		const frame = (data: unknown) => `data: ${JSON.stringify({ model: "fixture", ...(data as object) })}\n\n`;
		const delta = call
			? {
					...(content !== undefined ? { content } : {}),
					tool_calls: [
						{
							index: 0,
							id: `call-${done}`,
							type: "function",
							function: { ...call, arguments: JSON.stringify(call.arguments) },
						},
					],
				}
			: { content: content ?? "Complete." };
		const usage = { prompt_tokens: promptTokens, completion_tokens: 20 };
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`${frame({ choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }], usage })}data: [DONE]\n\n`,
		);
	});
	let worker: WorkerRunHandle | undefined;
	const previousCwd = process.cwd();
	try {
		process.chdir(dir);
		for (const name of ["a.txt", "b.txt", "c.txt"])
			writeFileSync(join(dir, name), `${name} ${"pump output line of forty characters.\n".repeat(200)}`);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const events: unknown[] = [];
		worker = startWorkerRun(
			{
				agentId: options.agentId,
				systemPrompt: "Do the assignment.",
				task: options.task,
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				modelCapabilities: { contextWindow: options.contextWindow ?? 32_768, maxTokens: 4096, tools: true },
				allowedTools: options.allowedTools,
				...(options.readOnly === true ? { readOnly: true } : { writeRoots: [dir] }),
				budget: { mode: "advisory", toolCalls: 60, synthesis: true, hardCap: 80 },
				noSkills: true,
				cwd: dir,
				...(options.product !== undefined ? { product: options.product } : {}),
				...(options.role !== undefined ? { role: options.role } : {}),
				...(options.mutationReport === true
					? { helperResult: true as const, resultContract: { kind: "mutation-report" as const } }
					: {}),
				...(options.runId !== undefined
					? { telemetryContext: { sessionId: null, runId: options.runId, agent: workerAgent(options.runId) } }
					: {}),
			},
			(event) => void events.push(event),
		);
		const outcome = await worker.promise;
		return { requests, events, exitCode: outcome.exitCode };
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
	}
}

test("a worker re-recalling its evictions is told once to write or report, and exhaustion seals its narration and changes (CLI-H3)", {
	timeout: 30_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-thrash-");
	try {
		// One write, three reads, then recalls in rotation, as run 3oja1uegz9ti did. After the third read the provider counts
		// a near-full request, so the reads leave; past the fifth recall it counts one larger than the window, so the next
		// request cannot fit.
		const { requests, events, exitCode } = await runFauxWorker(
			env.dir,
			(done, sent) => {
				const call =
					done === 0
						? { name: "write", arguments: { path: "out.txt", content: "first half\n" } }
						: done <= 3
							? { name: "read", arguments: { path: `${"abc"[done - 1]}.txt` } }
							: sent < 40
								? { name: "context", arguments: { scope: "recall", ref: `r${(done % 3) + 1}` } }
								: null;
				return {
					call,
					...(call && done >= 4 ? { content: `Checking r1 again (${done}).` } : {}),
					promptTokens: done >= 10 ? 60_000 : done === 3 ? 27_500 : 1000,
				};
			},
			{
				agentId: "coder",
				task: "Finish out.txt from a.txt, b.txt and c.txt.",
				allowedTools: ["write", "read", "context"],
			},
		);
		notEqual(exitCode, 0);
		const nudged = requests.filter((request) => request.includes("Host note:"));
		ok(nudged.length > 0, "a request after the fifth recall carries the host turn");
		equal(nudged.at(-1)?.split("Host note:").length, 2, "the host turn is injected once");
		const exhausted = events.find(
			(event) => (event as { payload?: { outcomeCode?: string } }).payload?.outcomeCode === "worker_context_exhausted",
		) as { payload: { detail?: string } } | undefined;
		match(exhausted?.payload.detail ?? "", /changed before stopping: out\.txt/);
		const capture = createWorkerOutputCapture();
		for (const event of events) capture.observe(event);
		const sealed = capture.snapshot();
		equal(sealed?.state, "partial");
		match(sealed?.text ?? "", /^Checking r\d again \(\d+\)\.$/);
	} finally {
		env.restore();
	}
});

test("a worker past 80% of its window with no change is told once to report, unless it already wrote (CLI-H3)", {
	timeout: 30_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-headroom-");
	try {
		// The fold trigger sits above 80%, so an 82% request is admitted without a fold and reports no fold decision.
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.context.compaction.threshold = 0.95;
		mkdirSync(join(env.dir, "config"), { recursive: true });
		writeFileSync(join(env.dir, "config/settings.yaml"), JSON.stringify(settings));
		// The output reserve holds 8,192 tokens, so on a 65,536 window the answer to the first read counts 53,000 and the
		// request carrying that read passes 80% yet fits; later answers count 40,000.
		const reads = (first: number) => (done: number) => ({
			call: done < first + 3 ? { name: "read", arguments: { path: `${"abc"[done - first]}.txt` } } : null,
			promptTokens: done === first ? 53_000 : 40_000,
		});
		const reviewer = await runFauxWorker(env.dir, reads(0), {
			agentId: "reviewer",
			task: "Review a.txt, b.txt and c.txt.",
			allowedTools: ["read"],
			readOnly: true,
			contextWindow: 65_536,
		});
		const nudged = reviewer.requests.filter((request) => request.includes("Host note:"));
		ok(nudged.length > 0, "a request after the 80% one carries the host turn");
		equal(nudged.at(-1)?.split("Host note:").length, 2, "the host turn is injected once");
		match(nudged.at(-1) ?? "", /passed 80% of the model window without a workspace change/);
		match(nudged.at(-1) ?? "", /Stop gathering and return your report now/);
		ok(!(nudged.at(-1) ?? "").includes("Write the change now"), "a read-only worker is not told to write");

		const writer = await runFauxWorker(
			env.dir,
			(done) =>
				done === 0
					? { call: { name: "write", arguments: { path: "out.txt", content: "done\n" } }, promptTokens: 40_000 }
					: reads(1)(done),
			{
				agentId: "coder",
				task: "Write out.txt, then check a.txt, b.txt and c.txt.",
				allowedTools: ["write", "read"],
				contextWindow: 65_536,
			},
		);
		ok(writer.requests.length > 2, "the writer reached requests past 80%");
		ok(!writer.requests.some((request) => request.includes("Host note:")), "a worker that wrote gets no host turn");
	} finally {
		env.restore();
	}
});

test("a writer worker reading 40 times with no write is told once, naming the streak, and a later cause adds nothing (X3)", {
	timeout: 90_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-streak-");
	try {
		// Admit an 82% request without a fold, so the context cause holds after read 46 as in the CLI-H3 row above.
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.context.compaction.threshold = 0.95;
		// A write into this configured scratch root inside the worker's cwd is no edit, so it never resets the streak.
		settings.safety.scratchRoots = [join(env.dir, "scratch")];
		mkdirSync(join(env.dir, "scratch"), { recursive: true });
		mkdirSync(join(env.dir, "config"), { recursive: true });
		writeFileSync(join(env.dir, "config/settings.yaml"), JSON.stringify(settings));
		// Fifty reads of one new line each: no repeat for the loop guard, nothing already shown.
		const { requests } = await runFauxWorker(
			env.dir,
			(done) => ({
				call: done < 50 ? { name: "read", arguments: { path: "a.txt", offset: done + 1, limit: 1 } } : null,
				promptTokens: done < 45 ? 1000 : done === 45 ? 53_000 : 40_000,
			}),
			{
				agentId: "coder",
				task: "Fix a.txt.",
				allowedTools: ["write", "read", "context"],
				contextWindow: 65_536,
			},
		);
		const toolResults = (raw: string) =>
			((JSON.parse(raw) as { messages?: Array<{ role?: string }> }).messages ?? []).filter((m) => m.role === "tool")
				.length;
		const first = requests.find((request) => request.includes("[CLIO Coder] 25 read-only calls"));
		equal(first !== undefined ? toolResults(first) : -1, 25, "the first note rides the 25th read's result");
		match(first ?? "", /25 read-only calls in a row with no edit\. .*Then act on it: make the edit\./);
		ok(!(first ?? "").includes("ask the one question"), "a worker without ask_user is not told to ask");
		ok(!requests.some((request) => /\[CLIO Coder\] (40|60) read-only/.test(request)), "the second step is no tool note");
		const nudged = requests.filter((request) => request.includes("Host note:"));
		equal(nudged[0] !== undefined ? toolResults(nudged[0]) : -1, 40, "the host turn follows the 40th read");
		// The worker holds no tasks tool, so the note does not name a plan update.
		match(nudged[0] ?? "", /Host note: this run has made 40 read-only calls in a row without an edit\. Another read/);
		match(nudged[0] ?? "", /Write the change now/);
		equal(nudged.at(-1)?.split("Host note:").length, 2, "the context cause after read 46 sends no second host turn");
		ok(requests.length > 47, "the run reached the requests past 80%");

		const lines = (until: number) => (done: number) => ({
			call: done < until ? { name: "read", arguments: { path: "a.txt", offset: done + 1, limit: 1 } } : null,
			promptTokens: 1000,
		});
		// Read 40 rides a chain whose next step edits: the streak resets inside the call, so no host turn follows it.
		const chained = await runFauxWorker(
			env.dir,
			(done) =>
				done === 39
					? {
							call: {
								name: "gateway",
								arguments: {
									op: "chain",
									steps: [
										{ id: "r", capability: "read", args: { path: "a.txt", offset: 40, limit: 1 } },
										{
											id: "e",
											capability: "edit",
											args: { path: "a.txt", edits: [{ oldText: "a.txt pump", newText: "a.txt pumped" }] },
											after: ["r"],
										},
									],
								},
							},
							promptTokens: 1000,
						}
					: lines(44)(done),
			{ agentId: "coder", task: "Fix a.txt.", allowedTools: ["edit", "read", "gateway"] },
		);
		match(readFileSync(join(env.dir, "a.txt"), "utf8"), /^a\.txt pumped/, "the chained edit landed");
		ok(
			!chained.requests.some((request) => request.includes("Host note:")),
			"a streak reset by the chain sends no host turn",
		);

		// A write into the configured scratch root at call 21 leaves the streak running: the host turn follows read 40.
		const scratched = await runFauxWorker(
			env.dir,
			(done) =>
				done === 20
					? { call: { name: "write", arguments: { path: "scratch/notes.txt", content: "n\n" } }, promptTokens: 1000 }
					: lines(44)(done),
			{ agentId: "coder", task: "Fix a.txt.", allowedTools: ["write", "read"] },
		);
		match(readFileSync(join(env.dir, "scratch/notes.txt"), "utf8"), /^n/, "the scratch write landed");
		const scratchNudged = scratched.requests.find((request) => request.includes("Host note:"));
		equal(scratchNudged !== undefined ? toolResults(scratchNudged) : -1, 41, "a scratch-root write is no edit");

		// An operator steer starts the streak over, so 50 reads with a steer at 30 never reach the second step.
		const steered = await runFauxWorker(env.dir, lines(50), {
			agentId: "coder",
			task: "Fix a.txt.",
			allowedTools: ["write", "read"],
			steerAt: 30,
		});
		ok(steered.requests.length > 50, "the steered run read 50 times");
		ok(!steered.requests.some((request) => request.includes("Host note:")), "a steer resets the streak");

		// An orientation worker that is not read-only but holds no edit or write tool gets no writer streak.
		const orienting = await runFauxWorker(env.dir, lines(42), {
			agentId: "scout",
			task: "Map a.txt.",
			allowedTools: ["read", "code_nav"],
			product: "orientation",
		});
		ok(orienting.requests.length > 42, "the orientation run read 42 times");
		ok(
			!orienting.requests.some((request) => /\[CLIO Coder\] 25 read-only|Host note:/.test(request)),
			"no writer streak note for a worker that cannot write",
		);
	} finally {
		env.restore();
	}
});

test("every role with a result hands back at its context share, whatever tools it holds (M3)", {
	timeout: 30_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-handback-");
	const fired: Array<{ runId: string; ruleId: string; evidence?: string }> = [];
	const unsubscribe = telemetryHub().subscribe("middleware.fired", (payload, context) => {
		const runId = (context as { runId?: string } | undefined)?.runId ?? "";
		fired.push({ runId, ruleId: payload.ruleId, ...(payload.evidence ? { evidence: payload.evidence } : {}) });
	});
	try {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.context.compaction.threshold = 0.95;
		mkdirSync(join(env.dir, "config"), { recursive: true });
		writeFileSync(join(env.dir, "config/settings.yaml"), JSON.stringify(settings));
		// 65,536 less the 8,192 output reserve leaves 57,344 usable: 42,000 is past 0.70 of it, 50,000 past 0.85.
		const tools = (requests: string[]) =>
			requests.map((raw) => (JSON.parse(raw) as { tools?: unknown[] }).tools?.length ?? 0);
		const reads = (tokens: (done: number) => number) => (done: number) => ({
			call: done < 3 ? { name: "read", arguments: { path: `${"abc"[done]}.txt` } } : null,
			promptTokens: tokens(done),
		});
		// An explorer holding write (a delivery tool) still hands back at 0.70: the role decides, not the tool list.
		const explorer = await runFauxWorker(
			env.dir,
			reads(() => 42_000),
			{
				agentId: "scout",
				task: "Review a.txt, b.txt and c.txt.",
				allowedTools: ["read", "write"],
				contextWindow: 65_536,
				role: "explorer",
				runId: "run-handback-explorer",
			},
		);
		equal(explorer.exitCode, 0);
		const explorerTools = tools(explorer.requests);
		ok((explorerTools[0] ?? 0) > 0 && explorerTools.at(-1) === 0, JSON.stringify(explorerTools));
		ok(explorerTools.length < 5, "the explorer's next round after the 0.70 request is its handback");
		ok(
			(explorer.requests[explorerTools.indexOf(0)] ?? "").includes("Current execution phase: final synthesis"),
			"the text-only crossing round carries the locked-synthesis directive",
		);
		ok(
			!explorer.events.some(
				(event) => (event as { payload?: { outcomeCode?: string } }).payload?.outcomeCode === "worker_context_exhausted",
			),
		);
		deepStrictEqual(
			fired.filter((entry) => entry.runId === "run-handback-explorer" && entry.ruleId === "worker.handback"),
			[{ runId: "run-handback-explorer", ruleId: "worker.handback", evidence: "bound:context@worker" }],
		);
		// A builder at 0.70 is told once to write or report and keeps its tools; it hands back at 0.85.
		const builder = await runFauxWorker(
			env.dir,
			reads((done) => (done < 2 ? 42_000 : 50_000)),
			{
				agentId: "coder",
				task: "Check a.txt, b.txt and c.txt, then write out.txt.",
				allowedTools: ["read", "write"],
				contextWindow: 65_536,
				role: "builder",
				runId: "run-handback-builder",
			},
		);
		equal(builder.exitCode, 0);
		const builderTools = tools(builder.requests);
		ok(builderTools.slice(0, 3).every((count) => count > 0) && builderTools.at(-1) === 0, JSON.stringify(builderTools));
		const noted = builder.requests.filter((request) => request.includes("Host note:"));
		ok(noted.length > 0, "the builder is told at 0.70");
		match(noted[0] ?? "", /passed 70% of its usable context without a workspace change/);
		ok(fired.some((entry) => entry.runId === "run-handback-builder" && entry.evidence === "bound:context@worker"));
		// A builder that owes a mutation report, on a route that offers the helper only at the handoff: the crossing
		// round itself offers the helper, and the run submits through it.
		const report = {
			completion: { state: "done", limitations: [], unverified: [] },
			mutatedPaths: [],
			validations: [],
			summary: "Checked the three files.",
			commitMessage: null,
		};
		const structured = await runFauxWorker(
			env.dir,
			(done) =>
				done < 3
					? reads((read) => (read < 2 ? 42_000 : 50_000))(done)
					: { call: { name: "clio_submit_result", arguments: report }, promptTokens: 50_000 },
			{
				agentId: "coder",
				task: "Check a.txt, b.txt and c.txt, then report.",
				allowedTools: ["read", "write"],
				contextWindow: 65_536,
				role: "builder",
				mutationReport: true,
			},
		);
		const names = (raw: string) =>
			((JSON.parse(raw) as { tools?: Array<{ function?: { name?: string } }> }).tools ?? []).map(
				(tool) => tool.function?.name,
			);
		ok(!names(structured.requests[0] ?? "{}").includes("clio_submit_result"), "the work phase hides the helper");
		equal(structured.requests.length, 4, "three reads, then the crossing round submits");
		const crossing = JSON.parse(structured.requests[3] ?? "{}") as { tool_choice?: { function?: { name?: string } } };
		ok(names(structured.requests[3] ?? "{}").includes("clio_submit_result"), "the crossing round offers the helper");
		equal(crossing.tool_choice?.function?.name, "clio_submit_result");
		equal(structured.exitCode, 0);
		const accepted = structured.events.filter(
			(event) => (event as { type?: string }).type === "clio_coder_helper_result",
		) as Array<{ payload: { kind?: string; data?: unknown } }>;
		equal(accepted.length, 1);
		equal(accepted[0]?.payload.kind, "mutation-report");
	} finally {
		unsubscribe();
		env.restore();
	}
});

test("a worker stopped by its own lost stdout lane names cause=internal, not parent_cancel (FL-9)", {
	timeout: 20_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-internal-stop-");
	let requested!: () => void;
	const request = new Promise<void>((resolve) => {
		requested = resolve;
	});
	// The provider holds the request open, so only the abort ends the call.
	const server = createServer((_req, _res) => requested());
	let worker: WorkerRunHandle | undefined;
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const events: unknown[] = [];
		worker = startWorkerRun(
			{
				agentId: "internal-stop-fixture",
				systemPrompt: "Reply Complete.",
				task: "Reply Complete.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "[redacted:assignment]",
				modelCapabilities: { contextWindow: 32_768, maxTokens: 4096, tools: true },
				allowedTools: [],
				budget: { mode: "advisory", toolCalls: 4, synthesis: true, hardCap: 8 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
			},
			(event) => void events.push(event),
		);
		await request;
		worker.abort("internal");
		const outcome = await worker.promise;
		notEqual(outcome.exitCode, 0);
		const text = JSON.stringify(events);
		match(text, /cause=internal/u);
		ok(!text.includes("parent_cancel"), "the worker's own failure is not its parent's cancel");
	} finally {
		worker?.abort();
		await worker?.promise;
		server.closeAllConnections();
		await closeServer(server);
		env.restore();
	}
});

test("a worker citation grounds on a line its own bash grep -n printed (FL-12)", { timeout: 20_000 }, async () => {
	const env = await isolateClioEnv("clio-coder-worker-bash-grep-");
	writeFileSync(join(env.dir, "notes.txt"), "intro\nalpha marker\noutro\n");
	const findings = (line: number) => ({
		findings: [{ claim: "The marker is on this line.", path: "notes.txt", line }],
		needsSplit: false,
		proposedSubtasks: [],
	});
	const call = (name: string, args: unknown) => ({ name, arguments: JSON.stringify(args) });
	const rounds = [
		[call("bash", { command: "grep -n alpha notes.txt" })],
		[call("clio_submit_result", findings(2))],
		[call("clio_submit_result", { ...findings(2), findings: [{ claim: "No grounded evidence." }] })],
	];
	let requests = 0;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		const round = rounds[Math.min(requests, rounds.length - 1)] ?? [];
		requests += 1;
		const tool_calls = round.map((entry, index) => ({
			index,
			id: `call_${requests}_${index}`,
			type: "function",
			function: entry,
		}));
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	let worker: WorkerRunHandle | undefined;
	const events: unknown[] = [];
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "scout",
				systemPrompt: "Inspect and return a Scout report.",
				task: "Find the marker.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
				allowedTools: ["bash"],
				budget: { mode: "advisory", toolCalls: 18, synthesis: true, hardCap: 150 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
				helperResult: true,
				resultContract: { kind: "scout-report" },
			},
			(event) => void events.push(event),
		);
		const outcome = await worker.promise;
		equal(outcome.exitCode, 0, JSON.stringify(outcome).slice(0, 2000));
		// The cited line was printed by the worker's own shell search, so no citation repair round follows.
		equal(requests, 2, JSON.stringify(events).slice(-3000));
	} finally {
		process.chdir(previousCwd);
		worker?.abort();
		await worker?.promise;
		server.closeAllConnections();
		await closeServer(server);
		env.restore();
	}
});

test("a host-written repair exchange journals no call attempt of its own (C-28)", {
	timeout: 20_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-repair-telemetry-");
	// The first answer is prose the scout-report contract refuses, so the worker queues its host-written repair
	// exchange; the second answer conforms.
	const answers = [
		"The marker is somewhere in notes.txt.",
		JSON.stringify({ findings: [{ claim: "No grounded evidence." }], needsSplit: false, proposedSubtasks: [] }),
	];
	let requests = 0;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		const content = answers[Math.min(requests, answers.length - 1)] ?? "";
		requests += 1;
		res.setHeader("content-type", "text/event-stream");
		res.end(
			`data: ${JSON.stringify({ model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
		);
	});
	let worker: WorkerRunHandle | undefined;
	const events: unknown[] = [];
	const previousCwd = process.cwd();
	process.chdir(env.dir);
	try {
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "scout",
				systemPrompt: "Inspect and return a Scout report.",
				task: "Find the marker.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "fixture",
				thinkingLevel: "off",
				modelCapabilities: { contextWindow: 131072, maxTokens: 8192, tools: true },
				allowedTools: ["read"],
				budget: { mode: "advisory", toolCalls: 18, synthesis: true, hardCap: 150 },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
				resultContract: { kind: "scout-report" },
				telemetryContext: { sessionId: null, runId: "repairrun", agent: workerAgent("repairrun") },
			},
			(event) => void events.push(event),
		);
		const outcome = await worker.promise;
		equal(outcome.exitCode, 0, JSON.stringify(outcome).slice(0, 2000));
		equal(requests, 2, "one repair round followed the prose answer");
		const records = events.flatMap((event) => {
			const frame = event as Partial<WorkerTelemetryFrame>;
			return frame.type === "clio_coder_telemetry" && frame.record !== undefined
				? [frame.record as unknown as { k: string; data: Record<string, unknown> }]
				: [];
		});
		const settled = records.filter((record) => record.k === "call.settled");
		deepStrictEqual(
			settled.map((record) => [record.data.attempt, record.data.disposition]),
			settled.map((record) => [0, record.data.disposition === "never_sent" ? "sent" : record.data.disposition]),
			"each sent request is its call's first attempt, with no phantom attempt for the repair exchange",
		);
		equal(settled.length, 2);
		// The worker reports its own repair count: 0 as it starts, then the one round it started (C-28).
		const reported = events.filter(
			(event) => (event as { type?: unknown }).type === "clio_coder_result_contract_repair",
		) as Array<{ payload: { started: number } }>;
		deepStrictEqual(
			reported.map((event) => event.payload.started),
			[0, 1],
		);
	} finally {
		process.chdir(previousCwd);
		worker?.abort();
		await worker?.promise;
		server.closeAllConnections();
		await closeServer(server);
		env.restore();
	}
});

test("drv-cf3a D-B: a result-contract repair round stays anchored on the provider's last count", () => {
	const guard = createWorkerContextGuard(refuseArchive);
	const input = { systemPrompt: "worker", tools: [], contextWindow: 32_768, outputReserve: () => 4096 };
	const task = user(`task ${"x".repeat(4000)}`);
	guard({ ...input, messages: [task] });
	// The provider counted the request well above chars/4, as qwen did in b2 request 10.
	const answer = assistant();
	if (answer.role === "assistant") answer.usage.input = 20_000;
	guard({ ...input, messages: [task, answer] });
	const answered = guard.inputTokens;
	equal(answered, 20_000);
	const repair = resultContractRepairMessages(
		{ contract: { kind: "scout-report" }, reason: "required plan artifact is missing", attempt: 1, anchors: [] },
		{ provider: "openai", api: "openai-completions", model: "fixture" },
	).map((message) => message as unknown as AgentMessage);
	guard({ ...input, messages: [task, answer, ...repair] });
	// Clio wrote the repair call; its zero usage is no provider count and must not displace the answer's.
	ok(guard.inputTokens > answered, `repair round counted at ${guard.inputTokens}, answer at ${answered}`);
});

test("an uncached worker route short of headroom ages the older read of a re-read path and never runs S0 (A2a, D1)", () => {
	const decisions: ContextFoldPayload[] = [];
	const guard = createWorkerContextGuard(() => {}, {
		route: { modelTier: "small", promptCaching: false },
		onDecision: (decision) => void decisions.push(decision),
	});
	const tight = { systemPrompt: "worker", tools: [], contextWindow: 10_000, outputReserve: () => 4000 };
	guard({ ...tight, messages: [user("task")] });
	// The newer read of src/a.ts supersedes the older one, which sits before the protected last two steps.
	const messages = [
		user("task"),
		assistant("old", "src/a.ts"),
		result("old", "AOLD ".repeat(4000)),
		assistant("other", "src/b.ts"),
		result("other", "B"),
		assistant("new", "src/a.ts"),
		result("new", "ANEW ".repeat(1000)),
		assistant(),
	];
	const text = JSON.stringify(guard({ ...tight, messages }));
	const decision = decisions.at(-1);
	equal(decision?.route.promptCaching, false);
	ok((decision?.tokensBefore ?? 0) < 8000, "under the trigger: only the headroom check acts");
	deepStrictEqual(
		guard.records[0]?.evicted.map(({ ref, reason }) => [ref.entry, reason]),
		[["2", "age_horizon"]],
	);
	ok(guard.records.every((record) => record.evicted.every((item) => (item.reason as string) !== "superseded")));
	ok(decisions.every((fold) => fold.stages.every((stage) => stage.stage !== "superseded")));
	match(text, /\[evicted ref=r1 reason=age_horizon tool=read path=src\/a\.ts /);
	ok(text.includes("ANEW ".repeat(1000)) && !text.includes("AOLD ".repeat(100)), "the newer read keeps its body");
});

test("capture follows the active branch and preserves existing eviction projection", () => {
	const entry = (
		turnId: string,
		parentTurnId: string | null,
		role: MessageEntry["role"],
		payload: unknown,
	): MessageEntry => ({ kind: "message", turnId, parentTurnId, role, payload, timestamp: "2026-09-09T00:00:00Z" });
	const entries: SessionEntry[] = [
		entry("u", null, "user", { text: "SHARED_CONSTRAINT" }),
		entry("a", "u", "assistant", {
			content: [{ type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } }],
		}),
		entry("r", "a", "tool_result", {
			toolCallId: "read",
			toolName: "read",
			result: { content: [{ type: "text", text: "RAW_EVICTED_BODY" }] },
		}),
		{
			kind: "contextEviction",
			turnId: "eviction",
			parentTurnId: "r",
			timestamp: "2026-09-09T00:00:00Z",
			policyId: "age-horizon",
			trigger: "pressure",
			tokensBefore: 1000,
			tokensAfter: 50,
			pressureBefore: 0.9,
			snapshotIdBefore: null,
			evicted: [
				{ ref: { entry: "r" }, reason: "age_horizon", tokensFreed: 50, marker: "[evicted ref=r reason=age_horizon]" },
			],
		},
		entry("active", "r", "user", { text: "ACTIVE_BRANCH" }),
		entry("sibling", "u", "user", { text: "SIBLING_SECRET" }),
	];
	const visible = buildModelReplayAgentMessagesFromTurns(entries, { activeLeafTurnId: "active" });
	const fork = selectWorkerContext(captureWorkerContext({ ...source, leafTurnId: "active" }, visible), { mode: "fork" });
	const text = JSON.stringify(fork.messages);
	match(text, /ACTIVE_BRANCH/);
	match(text, /evicted ref=r/);
	ok(!text.includes("RAW_EVICTED_BODY") && !text.includes("SIBLING_SECRET"));
	parseWorkerContextSeed(fork);
});

test("splice preserves failures and refuses to discard required images", () => {
	const snapshot = captureWorkerContext(source, [
		user("task"),
		assistant("error", "outside.ts"),
		result("error", "UNRESOLVED_ERROR", true),
	]);
	match(JSON.stringify(selectWorkerContext(snapshot, { mode: "splice", paths: ["src"] }).messages), /UNRESOLVED_ERROR/);
	const withImage = captureWorkerContext(source, [
		{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "abcd" }], timestamp: 1 },
	]);
	throws(() => selectWorkerContext(withImage, { mode: "splice" }), /required user images/);
	parseWorkerContextSeed(selectWorkerContext(withImage, { mode: "fork" }));
});

test("receipt integrity binds inherited context and reports it as context provenance, not validation", () => {
	const provenance = selectWorkerContext(captureWorkerContext(source, history()), { mode: "fork" }).provenance;
	const envelope = { ...fixtureEnvelope(), workerContext: provenance };
	const receipt = finishRunResult({ ...fixtureReceiptDraft(envelope), workerContext: provenance }, envelope, {
		terminal: { terminalReason: "completed" },
		processExitCode: envelope.exitCode,
		frameType: null,
		usage: undefined,
	}).result;

	equal(settledRunTrust(receipt).contextProvenance.state, "recorded");
	equal(
		settledRunTrust({ ...receipt, workerContext: { ...provenance, contentHash: "bad" } }).contextProvenance.state,
		"invalid",
	);
});

test("worker recall keeps its own aliases above every parent alias and recalls the exact archive", async () => {
	const env = await isolateClioEnv("clio-coder-worker-recall-");
	try {
		const at = "2026-09-09T00:00:00Z";
		const message = (turnId: string, parentTurnId: string | null, role: MessageEntry["role"], payload: unknown) =>
			({ kind: "message", turnId, parentTurnId, role, payload, timestamp: at }) as MessageEntry;
		const read = (turnId: string, parentTurnId: string, id: string) =>
			message(turnId, parentTurnId, "assistant", {
				content: [{ type: "toolCall", id, name: "read", arguments: { path: "a.ts" } }],
			});
		const body = (turnId: string, parentTurnId: string, id: string, text: string) =>
			message(turnId, parentTurnId, "tool_result", {
				toolCallId: id,
				toolName: "read",
				result: { content: [{ type: "text", text }] },
			});
		const eviction = (
			turnId: string,
			parentTurnId: string,
			alias: string,
			entry: string,
			text: string,
		): SessionEntry => ({
			kind: "contextEviction",
			turnId,
			parentTurnId,
			timestamp: at,
			policyId: "age-horizon",
			trigger: "pressure",
			tokensBefore: 1000,
			tokensAfter: 50,
			pressureBefore: 0.9,
			snapshotIdBefore: null,
			evicted: [
				{
					alias,
					ref: { entry },
					reason: "age_horizon",
					tokensFreed: 50,
					marker: renderMarker({ alias, ref: { entry }, reason: "age_horizon", toolName: "read", text }),
				},
			],
		});
		// The parent's largest alias, r2, lives only on a sibling branch; the active path renders r1.
		const entries: SessionEntry[] = [
			message("u", null, "user", { text: "task" }),
			read("a", "u", "read"),
			body("res", "a", "read", "PARENT_BODY"),
			eviction("e1", "res", "r1", "res", "PARENT_BODY"),
			read("sa", "u", "sibling-read"),
			body("sres", "sa", "sibling-read", "SIBLING_BODY"),
			eviction("e2", "sres", "r2", "sres", "SIBLING_BODY"),
			message("active", "res", "user", { text: "ACTIVE" }),
		];
		const visible = buildModelReplayAgentMessagesFromTurns(entries, { activeLeafTurnId: "active" });
		const fork = selectWorkerContext(captureWorkerContext({ ...source, leafTurnId: "active" }, visible, entries), {
			mode: "fork",
		});
		const lineage = seedRecallLineage(fork);
		deepStrictEqual(lineage, { aliasFloor: 2, inheritedMarkers: [{ alias: "r1", ref: "res" }] });
		// A seed from before the provenance fields still validates; its floor is the largest marker alias it carries.
		const { recallAliasFloor: _floor, inheritedMarkers: _markers, contentHash: _hash, ...identity } = fork.provenance;
		const legacy = {
			provenance: { ...identity, contentHash: contextHash({ ...identity, messages: fork.messages }) },
			messages: fork.messages,
		};
		deepStrictEqual(seedRecallLineage(legacy), { aliasFloor: 1, inheritedMarkers: [{ alias: "r1" }] });

		const store = createWorkerObservationStore("run-1", lineage);
		const files: string[] = [];
		const guard = createWorkerContextGuard((alias, observation) => void files.push(store.archive(alias, observation)), {
			aliasFloor: lineage.aliasFloor,
			archivePath: store.archivePath,
		});
		const input = { systemPrompt: "worker", tools: [], contextWindow: 5000, outputReserve: () => 500 };
		const seeded = [...seededWorkerMessages(fork), user("task")];
		guard({ ...input, messages: seeded });
		const messages = [
			...seeded,
			assistant("large"),
			result("large", `EXACT_WORKER_OBSERVATION ${"data ".repeat(3500)}`),
			assistant("small"),
			result("small", "small"),
			assistant("last"),
			result("last", "last"),
		];
		const raw = JSON.stringify(messages);
		const projected = JSON.stringify(guard({ ...input, messages }));
		match(
			projected,
			/\[evicted ref=r3 reason=age_horizon tool=read path=src\/a\.ts .*recall=context\(scope=\\"recall\\", ref=\\"r3\\"\)/,
		);
		ok(projected.includes(`offload=${files[0]} recall=`), "a worker without the context tool can read the archive");
		equal(JSON.stringify(messages), raw);
		const tool = createContextTool({ workerRecall: store.recall });
		match(JSON.stringify(await tool.run({ scope: "recall", ref: "r3" }, {})), /EXACT_WORKER_OBSERVATION/);
		match(JSON.stringify(await tool.run({ scope: "recall" }, {})), /r3/);
		match(
			JSON.stringify(await tool.run({ scope: "recall", ref: "r1" }, {})),
			/not_in_stream: r1 names parent history \(parent entry res\)/,
		);
		match(JSON.stringify(store.recall({ ref: "r2" })), /not_in_stream: r2/);
		match(
			JSON.stringify(createWorkerObservationStore("run-2", seedRecallLineage(legacy)).recall({ ref: "r1" })),
			/not_in_stream/,
		);
		ok("error" in createWorkerObservationStore("run-3").recall({ ref: "r3" }));
		ok("error" in store.recall({ ref: "../../parent/session" }));
		writeFileSync(files[0] as string, "{}");
		match(JSON.stringify(store.recall({ ref: "r3" })), /digest mismatch/);
	} finally {
		env.restore();
	}
});

test("a worker's context(scope=workspace) probes its own cwd instead of requiring a parent session (bt-45 G)", async () => {
	const env = await isolateClioEnv("clio-coder-worker-workspace-");
	try {
		const worker = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: env.dir }));
		const verdict = await worker.invoke({ tool: "context", args: { scope: "workspace" } });
		ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
		equal(JSON.parse(verdict.result.output).cwd, process.cwd());
		match(
			JSON.stringify(await createContextTool({}).run({ scope: "workspace" }, {})),
			/scope=\\"skills\\" still answers/,
		);
	} finally {
		env.restore();
	}
});

test("worker snapshots exclude parent system prompts and declarations without charging interruption counts", () => {
	const conversation = history();
	const snapshot = captureWorkerContext(source, [
		{ role: "system", content: "parent-only policy", timestamp: 0 },
		...conversation.slice(0, 1),
		{
			role: "system",
			content: "parent update",
			toolsAdded: [{ name: "parent-only", description: "private", parameters: { type: "object" } }],
			timestamp: 1,
		},
		...conversation.slice(1),
	]);
	deepStrictEqual(snapshot, captureWorkerContext(source, conversation));
	const seed = selectWorkerContext(snapshot, { mode: "fork" });
	equal(
		seededWorkerMessages(seed).some((message) => message.role === "system"),
		false,
	);
});

test("a worker the wall clock reaches hands back a report and reports worker_run_timeout (fleet M8)", {
	timeout: 30_000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-worker-wall-");
	const startedAt = Date.now();
	const handbackAt = startedAt + 1_200;
	let writes = 0;
	const server = createServer(async (req, res) => {
		await readRequestBody(req);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const frame = (data: unknown) => `data: ${JSON.stringify({ model: "fixture", ...(data as object) })}\n\n`;
		const usage = { prompt_tokens: 1000, completion_tokens: 20 };
		// A task that cannot finish: the model keeps porting modules until the run hands back.
		const port = Date.now() < handbackAt;
		if (port) writes += 1;
		res.setHeader("content-type", "text/event-stream");
		res.end(
			(port
				? frame({
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: `call-write-${writes}`,
											type: "function",
											function: {
												name: "write",
												arguments: JSON.stringify({ path: `src/m${writes}.ts`, content: `export const m${writes} = 1;\n` }),
											},
										},
									],
								},
								finish_reason: "tool_calls",
							},
						],
						usage,
					})
				: frame({
						choices: [
							{ index: 0, delta: { content: "PARTIAL REPORT: ported the modules written so far." }, finish_reason: "stop" },
						],
						usage,
					})) + "data: [DONE]\n\n",
		);
	});
	const events: unknown[] = [];
	let worker: WorkerRunHandle | undefined;
	const previousCwd = process.cwd();
	try {
		process.chdir(env.dir);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		worker = startWorkerRun(
			{
				agentId: "coder",
				systemPrompt: "Port every module.",
				task: "Port every module in src/ to the new API.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${port}` },
				runtime: litellm,
				wireModelId: "fixture",
				apiKey: "[redacted:assignment]",
				modelCapabilities: { contextWindow: 65_536, maxTokens: 4096, tools: true },
				allowedTools: ["write" as ToolName],
				budget: { mode: "advisory", toolCalls: 200, synthesis: true, hardCap: 400 },
				noSkills: true,
				cwd: env.dir,
				limits: {
					version: 1,
					context: { workShare: 0.85, noteShare: 0.6 },
					time: { wallMs: 2_000, deadlineAt: startedAt + 2_000, handbackAt, responseMs: 30_000 },
					tools: { ceiling: 400 },
					retries: { max: 0 },
					refusals: 3,
					depth: 1,
				},
			},
			(event) => void events.push(event),
		);
		await worker.promise;
		const text = JSON.stringify(events);
		match(text, /"outcomeCode":"worker_run_timeout"/);
		match(text, /PARTIAL REPORT: ported the modules written so far\./);
		ok(writes > 0, "the run did work before the wall clock moved it to handback");
		equal(readFileSync(join(env.dir, "src", "m1.ts"), "utf8"), "export const m1 = 1;\n");
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		process.chdir(previousCwd);
		env.restore();
	}
});
