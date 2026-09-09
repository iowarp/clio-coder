import { deepStrictEqual, equal, match, notEqual, ok, throws } from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { parseWorkerContextPolicy } from "../../src/domains/context/worker/contract.js";
import { createWorkerContextGuard } from "../../src/domains/context/worker/pressure.js";
import { createWorkerObservationStore } from "../../src/domains/context/worker/recall.js";
import { selectWorkerContext } from "../../src/domains/context/worker/select.js";
import { captureWorkerContext, completeHistoryLength, contextHash } from "../../src/domains/context/worker/snapshot.js";
import { persistWorkerContextSeed } from "../../src/domains/context/worker/store.js";
import { verifyReceiptIntegrity, withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { adaptRunReceiptContextStatus } from "../../src/domains/evidence/trust-status.js";
import type { MessageEntry, SessionEntry } from "../../src/domains/session/entries.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createDispatchAdmissionController } from "../../src/tools/dispatch-admission.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import { parseWorkerContextSeed, seededWorkerMessages } from "../../src/worker/context-seed.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

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
	const env = await isolateClioEnv("clio-context-seed-");
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

test("admission captures once for a mixed batch and preserves the seed while parent and arguments change", () => {
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
	equal(captures, 1);
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

test("worker guard ignores inherited usage and refuses an oversized first fork without rewriting it", () => {
	const message = assistant();
	if (message.role === "assistant") message.usage.input = 1_000_000;
	const messages = [user("task"), message];
	const guard = createWorkerContextGuard(() => {
		throw new Error("must not archive");
	});
	deepStrictEqual(
		guard({ messages, systemPrompt: "worker", tools: [], contextWindow: 4000, outputReserve: 500 }),
		messages,
	);
	const fresh = createWorkerContextGuard(() => "archive");
	throws(
		() =>
			fresh({
				messages: [user("task".repeat(5000))],
				systemPrompt: "worker",
				tools: [],
				contextWindow: 1000,
				outputReserve: 200,
			}),
		/initial request/,
	);
});

test("worker pressure evicts by completed rounds, preserves raw results, and keeps stable recall markers", () => {
	const archived: AgentMessage[] = [];
	const guard = createWorkerContextGuard((_ref, message) => {
		archived.push(message);
		return "/evidence/result.json";
	});
	const input = { systemPrompt: "worker", tools: [], contextWindow: 5000, outputReserve: 500 };
	const initial = [user("task")];
	guard({ ...input, messages: initial });
	const messages = [
		...initial,
		assistant("large"),
		result("large", "evidence ".repeat(2500)),
		assistant("small"),
		result("small", "small"),
		assistant("last"),
		result("last", "last"),
	];
	const raw = JSON.stringify(messages);
	const projected = guard({ ...input, messages });
	equal(archived.length, 1);
	match(JSON.stringify(projected), /Exact historical result/);
	equal(JSON.stringify(messages), raw);
	deepStrictEqual(guard({ ...input, messages }), projected);
	equal(archived.length, 1);
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
	const receipt = withReceiptIntegrity({ ...fixtureReceiptDraft(envelope), workerContext: provenance }, envelope);
	deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
	equal(
		verifyReceiptIntegrity({ ...receipt, workerContext: { ...provenance, omittedMessages: 90 } }, envelope).ok,
		false,
	);
	const { workerContext: _context, ...withoutContext } = envelope;
	equal(verifyReceiptIntegrity(receipt, withoutContext).ok, false);
	equal(adaptRunReceiptContextStatus(receipt).state, "recorded");
	equal(
		adaptRunReceiptContextStatus({ ...receipt, workerContext: { ...provenance, contentHash: "bad" } }).state,
		"invalid",
	);
});

test("worker recall admits only this run's evictions, checks persisted digests, and uses the bounded context tool", async () => {
	const env = await isolateClioEnv("clio-worker-recall-");
	try {
		const store = createWorkerObservationStore();
		const other = createWorkerObservationStore();
		const observation = result("read", "EXACT_WORKER_OBSERVATION");
		const digest = contextHash(observation);
		const file = store.archive(digest, observation);
		const ref = `worker:${digest}`;
		ok("error" in other.recall({ ref }));
		ok("error" in store.recall({ ref: "../../parent/session" }));
		const tool = createContextTool({ workerRecall: store.recall });
		const recalled = await tool.run({ scope: "recall", ref }, {});
		match(JSON.stringify(recalled), /EXACT_WORKER_OBSERVATION/);
		match(JSON.stringify(await tool.run({ scope: "recall" }, {})), /worker:/);
		writeFileSync(file, "{}");
		ok("error" in store.recall({ ref }));
	} finally {
		env.restore();
	}
});

test("provider usage reconciliation stays stable after eviction and disabled eviction fails explicitly", () => {
	const guard = createWorkerContextGuard(() => "/observation.json");
	const input = { systemPrompt: "worker", tools: [], contextWindow: 10000, outputReserve: 500 };
	const initial = [user("task")];
	guard({ ...input, messages: initial });
	const middle = [
		...initial,
		assistant("large"),
		result("large", "data ".repeat(3500)),
		assistant("small"),
		result("small", "small"),
	];
	guard({ ...input, messages: middle });
	const last = assistant("last");
	if (last.role === "assistant") last.usage.input = 10000;
	const messages = [...middle, last, result("last", "last")];
	const projected = guard({ ...input, messages });
	match(JSON.stringify(projected), /Exact historical result/);
	deepStrictEqual(guard({ ...input, messages }), projected);
	const disabled = createWorkerContextGuard(() => {
		throw new Error("must not archive");
	});
	disabled({ ...input, messages: initial });
	throws(
		() => disabled({ ...input, autoEvict: false, messages: [user("too big ".repeat(10000))] }),
		/automatic eviction disabled/,
	);
});
