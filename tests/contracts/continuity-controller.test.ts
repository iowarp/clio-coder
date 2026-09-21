import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { ToolNames } from "../../src/core/tool-names.js";
import type { ContinuityPersistencePorts } from "../../src/domains/session/continuity/contract.js";
import { resolveContinuityProjection } from "../../src/domains/session/continuity/projection.js";
import { isSessionEntry, type SessionEntry } from "../../src/domains/session/entries.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { EngineModel } from "../../src/engine/types.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { ContinuityController, type ContinuityReductionHooks } from "../../src/interactive/continuity-controller.js";
import { resolveAgentTools } from "../../src/tools/agent-tools.js";
import { registerAllTools } from "../../src/tools/bootstrap.js";
import { createRegistry } from "../../src/tools/registry.js";

function fixture() {
	let clock = 1_000_000;
	let serial = 0;
	let leaf = "operator";
	let current = true;
	let fits = true;
	let admit = true;
	let flushFails = false;
	const entries: SessionEntry[] = [
		{
			kind: "message",
			turnId: leaf,
			parentTurnId: null,
			timestamp: new Date(clock).toISOString(),
			role: "user",
			payload: { text: "Complete the work." },
		},
	];
	const log: string[] = [];
	let reduction: (hooks: ContinuityReductionHooks) => Promise<void> = async () => {};
	const ports: ContinuityPersistencePorts = {
		append: (entry) => {
			ok(isSessionEntry(entry), `invalid ${entry.kind}`);
			entries.push(entry);
			log.push(entry.kind === "handoffTransaction" ? entry.event.phase : entry.kind);
		},
		readExact: () => ({ status: "unresolved" }),
		flushAppends: () => {
			log.push("flush");
			if (flushFails) throw new Error("fsync failed");
		},
		checkpoint: async () => {
			log.push("checkpoint");
			if (flushFails) throw new Error("checkpoint failed");
		},
		isStateRemoved: () => false,
		isOriginCurrent: () => current,
	};
	const controller = new ContinuityController({
		captureOrigin: () => ({
			sessionId: "session",
			leafTurnId: leaf,
			initiatingTurnId: "operator",
			sourceRevision: "fixture",
			ports,
		}),
		entries: () => entries,
		leaf: () => leaf,
		admitNote: () => admit,
		fits: () => fits,
		inputTokens: () => 300,
		reduce: async (hooks) => reduction(hooks),
		installReplay: () => {
			log.push("replay");
		},
		onCommit: () => log.push("notify"),
		notice: (text) => log.push(text),
		now: () => ++clock,
		id: () => `id-${++serial}`,
	});
	const append = (role: "assistant" | "tool_result", payload: unknown) => {
		const id = `message-${++serial}`;
		entries.push({
			kind: "message",
			turnId: id,
			parentTurnId: leaf,
			timestamp: new Date(++clock).toISOString(),
			role,
			payload,
		});
		leaf = id;
		return id;
	};
	const receipt = (toolCallId = "call") =>
		append("tool_result", {
			toolCallId,
			toolName: "self_compact",
			isError: false,
			result: { content: [{ type: "text", text: "prepared" }] },
		});
	const fold = () => resolveContinuityProjection({ entries, sessionId: "session", nowMs: clock }).current;
	return {
		controller,
		entries,
		log,
		append,
		receipt,
		fold,
		setReduction: (value: typeof reduction) => {
			reduction = value;
		},
		setCurrent: (value: boolean) => {
			current = value;
		},
		setFits: (value: boolean) => {
			fits = value;
		},
		setAdmit: (value: boolean) => {
			admit = value;
		},
		failFlush: () => {
			flushFails = true;
		},
	};
}

test("three real transaction cycles preserve exact notes, ordering, and original operator identity", async () => {
	const f = fixture();
	for (let cycle = 0; cycle < 3; cycle++) {
		const note = `  Cycle ${cycle}: keep λ and whitespace.\n`;
		await f.controller.request(note, `call-${cycle}`);
		strictEqual(f.fold()?.accepted?.note, note);
		strictEqual(f.controller.admission().block, true);
		f.receipt(`call-${cycle}`);
		strictEqual(await f.controller.settle(), true);
		const admission = f.controller.admission();
		ok(!admission.block && admission.correlationId);
		const response = f.append("assistant", {
			text: "Work complete.",
			stopReason: "stop",
			continuityDeliveryId: admission.correlationId,
		});
		await f.controller.response(response, admission.correlationId);
		strictEqual(f.fold()?.phase, "acknowledged");
		strictEqual(f.fold()?.validated, true);
		strictEqual(f.fold()?.identity?.initiatingTurnId, "operator");
	}
	deepStrictEqual(f.log.slice(0, 10), [
		"prepared",
		"flush",
		"flush",
		"reducing",
		"flush",
		"replay",
		"continuityCommit",
		"checkpoint",
		"notify",
		"replay",
	]);
	strictEqual(f.entries.filter((entry) => entry.kind === "message" && entry.role === "user").length, 1);
});

test("summary carries the reserved commit before the checkpoint barrier", async () => {
	const f = fixture();
	f.setReduction(async (hooks) => {
		hooks.beforeSummaryCall();
		const continuity = hooks.checkpointForSummary("summary", 300, 100);
		f.entries.push({
			kind: "compactionSummary",
			turnId: "summary",
			parentTurnId: "operator",
			timestamp: new Date(1_000_010).toISOString(),
			summary: "Prior work",
			tokensBefore: 300,
			tokensAfter: 100,
			firstKeptTurnId: "operator",
			messagesSummarized: 1,
			isSplitTurn: false,
			continuity,
		});
	});
	await f.controller.request("Keep the patch.", "call");
	f.receipt();
	await f.controller.settle();
	strictEqual(f.fold()?.commit?.outcome, "summarized");
	strictEqual(f.fold()?.validated, true);
});

test("no note or floor rejection writes anything", async () => {
	const f = fixture();
	await rejects(f.controller.request(" ", "call"), /Invalid/);
	f.setAdmit(false);
	await rejects(f.controller.request("Retain", "call"), /replay budget/);
	deepStrictEqual(f.log, []);
});

test("unsettled or mismatching receipt never starts reduction", async () => {
	const f = fixture();
	await f.controller.request("Retain", "call");
	f.receipt("another-call");
	await rejects(f.controller.settle(), /receipt/);
	strictEqual(f.log.includes("reducing"), false);
	strictEqual(f.fold()?.phase, "paused");
});

test("a barrier failure cannot grant delivery or commit notification", async () => {
	const f = fixture();
	await f.controller.request("Retain", "call");
	f.receipt();
	f.failFlush();
	await rejects(f.controller.settle(), /durability/);
	strictEqual(f.log.includes("notify"), false);
	strictEqual(f.log.includes("delivered"), false);
});

test("third summary invocation in a spent attempt is refused; operator recovery spends the next attempt", async () => {
	const f = fixture();
	f.setReduction(async (hooks) => {
		hooks.beforeSummaryCall();
		hooks.beforeSummaryCall();
		hooks.beforeSummaryCall();
	});
	await f.controller.request("Retain", "call");
	f.receipt();
	await rejects(f.controller.settle(), /invocation limit/);
	strictEqual(f.fold()?.attemptsSpent, 1);
	const identity = f.fold()?.identity;
	ok(identity);
	f.setReduction(async () => {});
	await f.controller.recover(identity.handoffId, "reduce");
	strictEqual(f.fold()?.attemptsSpent, 2);
	strictEqual(f.fold()?.phase, "delivered");
	deepStrictEqual(f.fold()?.identity, identity);
});

test("a final response after additional tool rounds acknowledges only its correlated delivery", async () => {
	const f = fixture();
	await f.controller.request("Retain", "call");
	f.receipt();
	await f.controller.settle();
	const admission = f.controller.admission();
	ok(!admission.block && admission.correlationId);
	const intermediate = f.append("assistant", {
		text: "Checking",
		stopReason: "toolUse",
		continuityDeliveryId: admission.correlationId,
	});
	await f.controller.response(intermediate, admission.correlationId);
	strictEqual(f.fold()?.phase, "delivered");
	f.append("tool_result", { toolCallId: "read", isError: false });
	const terminal = f.append("assistant", {
		text: "Verified.",
		stopReason: "stop",
		continuityDeliveryId: admission.correlationId,
	});
	await f.controller.response(terminal, "wrong");
	strictEqual(f.fold()?.phase, "delivered");
	await f.controller.response(terminal, admission.correlationId);
	strictEqual(f.fold()?.phase, "acknowledged");
});

test("cancelled and changed-origin leases cannot invoke the provider", async () => {
	for (const cancel of [true, false]) {
		const f = fixture();
		await f.controller.request("Retain", "call");
		f.receipt();
		await f.controller.settle();
		if (cancel) f.controller.cancel();
		else f.setCurrent(false);
		const admission = f.controller.admission();
		ok(admission.block);
		match(admission.reason, /cancelled|ownership/);
		await f.controller.pause();
		strictEqual(f.log.includes("acknowledged"), false);
	}
});

test("registered native tool completes three engine-driven handoffs through awaited receipts and correlated responses", async () => {
	const f = fixture();
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }) });
	const registration = registerAllTools(registry, {
		mcpCapabilities: false,
		requestSelfCompact: (note, id, signal) => f.controller.request(note, id, signal),
	});
	const model: EngineModel = {
		id: "fixture",
		name: "fixture",
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		contextWindow: 32768,
		maxTokens: 2048,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	let invocation = 0;
	const handle = createEngineAgent({
		initialState: {
			model,
			thinkingLevel: "off",
			tools: resolveAgentTools({ registry, allowedTools: [ToolNames.SelfCompact] }),
		},
		beforeStreamRequest: () => f.controller.admission(),
		prepareNextTurnWithContext: async (_completed, signal) => {
			await f.controller.settle(signal);
			return undefined;
		},
		transcriptStreamFn() {
			const checkpoint = invocation++ % 2 === 0;
			const message: AssistantMessage = {
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				timestamp: Date.now(),
				stopReason: checkpoint ? "toolUse" : "stop",
				content: checkpoint
					? [
							{
								type: "toolCall",
								id: `native-${invocation}`,
								name: "self_compact",
								arguments: { note_to_self: `Keep exact native cycle ${invocation}.` },
							},
						]
					: [{ type: "text", text: "Completed the slice." }],
				usage: {
					input: 100,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 110,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			};
			const stream = createAssistantMessageEventStream();
			stream.push({ type: "done", reason: checkpoint ? "toolUse" : "stop", message });
			return stream;
		},
	});
	handle.agent.subscribe(async (event) => {
		if (event.type === "tool_execution_end") {
			strictEqual(event.isError, false);
			await Promise.resolve();
			f.receipt(event.toolCallId);
		}
		if (event.type === "message_end" && event.message.role === "assistant") {
			const correlationId = handle.requestCorrelationId(event.message);
			const id = f.append("assistant", {
				text: event.message.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join(""),
				content: event.message.content,
				stopReason: event.message.stopReason,
				...(correlationId ? { continuityDeliveryId: correlationId } : {}),
			});
			await f.controller.response(id, correlationId);
		}
	});
	try {
		for (let cycle = 0; cycle < 3; cycle++) {
			await handle.agent.prompt(`Continue slice ${cycle}`);
			strictEqual(f.fold()?.phase, "acknowledged");
			strictEqual(f.fold()?.validated, true);
		}
		strictEqual(invocation, 6);
	} finally {
		await registration.close();
	}
});
