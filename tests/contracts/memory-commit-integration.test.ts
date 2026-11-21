import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DomainContext } from "../../src/core/domain-loader.js";
import {
	createMemoryInterventionRegistration,
	type MemoryInterventionSettings,
} from "../../src/domains/memory/intervention.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryModelResponse } from "../../src/domains/memory/task-memory-policy.js";
import type { ProvidersContract } from "../../src/domains/providers/contract.js";
import type { SessionContract, SessionEntryInput } from "../../src/domains/session/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { createHostInserts, type HostInserts } from "../../src/session-control/host-inserts.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import { createTurnMiddleware, type TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const scope = { sessionId: "session", branchAnchorTurnId: "branch" };
const commit = { ...scope, kind: "continuity" as const, commitId: "commit", outcome: "summarized" as const };

test("only a successful commit arms restoration and only installation acknowledgement consumes it", () => {
	const bank = new TaskMemoryBank();
	const memory = createMemoryInterventionRegistration({ bank });
	memory.bindCommitScope(scope);
	bank.updateStatus("Old task is still failing.");
	const fact = bank.saveKnowledge("The test runner needs the scratch preloader.");
	memory.evaluate({ hook: "on_compaction", sessionId: scope.sessionId, metadata: { stage: "llm_summary" } });
	strictEqual(memory.prepareRestoration(null, 400), null);
	const oldGuard = memory.isContentCurrent();
	memory.notifyContextCommitted(commit);
	strictEqual(oldGuard(), false);
	const offer = memory.prepareRestoration({ kind: "handoff", text: "The task passed." }, 400);
	ok(offer);
	match(offer.message, /scratch preloader/);
	strictEqual(offer.message.includes("still failing"), false);
	strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 0);
	const replacement = memory.prepareRestoration(null, 400);
	ok(replacement);
	strictEqual(memory.acknowledgeRestoration(offer), false);
	strictEqual(memory.acknowledgeRestoration(replacement), true);
	strictEqual(bank.snapshot().knowledge.find((entry) => entry.id === fact.id)?.injectionCount, 1);
	memory.notifyContextCommitted(commit);
	strictEqual(memory.prepareRestoration(null, 400), null);
	memory.dispose();
});

test("a pre-commit background completion loses content authority while its same-session usage remains reportable", async () => {
	const bank = new TaskMemoryBank();
	let complete!: (response: TaskMemoryModelResponse) => void;
	const pending = new Promise<TaskMemoryModelResponse>((resolve) => {
		complete = resolve;
	});
	const memory = createMemoryInterventionRegistration({
		bank,
		getModelClient: () => ({ complete: () => pending }),
	});
	memory.bindCommitScope(scope);
	const step = memory.runPromptedStep({ deterministicTrigger: true });
	memory.notifyContextCommitted(commit);
	complete({
		text:
			'<operations>[{"op":"save_knowledge","content":"Stale pre-compaction inference."}]</operations><no_intervention/>',
		usage: {
			targetId: "fixture",
			attributedModelId: "fixture",
			input: { kind: "measured", value: 10, source: "provider" },
			output: { kind: "measured", value: 2, source: "provider" },
			cacheRead: { kind: "measured", value: 0, source: "provider" },
			cacheWrite1h: { kind: "unknown", reason: "provider-omitted" },
			cacheWrite: { kind: "measured", value: 0, source: "provider" },
			reasoning: { kind: "measured", value: 0, source: "provider" },
			totalTokens: { kind: "measured", value: 12, source: "provider" },
			pricing: { usd: { kind: "measured", value: 0, source: "provider" }, pricedBy: "provider" },
			durationMs: 1,
			backend: null,
		},
	});
	const result = await step;
	strictEqual(result.reminder, null);
	strictEqual(bank.snapshot().knowledge.length, 0);
	memory.dispose();
});

test("buffered memory is revalidated after composition while unrelated reminders survive", () => {
	let current = true;
	const middleware = createTurnMiddleware({
		state: createTurnState("off"),
		middlewareToolChoice: {} as never,
		emitNotice() {},
		emitFooterNotice() {},
	});
	middleware.injectDeferredReminder("Memory: old inference", "advisory", () => current);
	middleware.injectDeferredReminder("Keep the operator's requested test scope.");
	const projection = middleware.takePendingReminderProjection();
	match(projection(), /old inference/);
	current = false;
	strictEqual(projection().includes("old inference"), false);
	match(projection(), /requested test scope/);
	middleware.injectDeferredReminder("Memory: old inference", "advisory", () => false);
	strictEqual(middleware.flushPendingReminders(), "");
});

/** One process of the restoration protocol: its own memory, host-insert service and turn context over the session. */
function restorationProcess(session: SessionContract, bank: TaskMemoryBank, budget: { tokens: number }) {
	const memory = createMemoryInterventionRegistration({
		bank,
		getSettings: () => ({ maxTokens: budget.tokens }) as MemoryInterventionSettings,
	});
	const notes: string[] = [];
	memory.noteInheritedRestoration = (commitId) => notes.push(commitId);
	const state = createTurnState("off");
	state.lastTurnId = "a1";
	const runtime = {
		targetId: "target",
		runtimeId: "openai-compat",
		wireModelId: "model",
		runtimeResolution: {
			contextWindowDetails: {
				desiredContextWindow: 32_768,
				effectiveContextWindow: 32_768,
				contextWindowSource: "configured",
			},
			capabilityDecisions: { maxTokens: 1024 },
		},
		agent: createEngineAgent({
			initialState: {
				model: {
					id: "model",
					api: "openai-completions",
					baseUrl: "http://memory.invalid",
					maxTokens: 1024,
					contextWindow: 32_768,
				} as AgentRuntime["agent"]["state"]["model"],
				systemPrompt: "system",
				messages: [],
				tools: [],
			},
		}).agent,
	} as unknown as AgentRuntime;
	state.runtime = runtime;
	const render = () =>
		buildModelReplayAgentMessagesFromTurns(session.readEntries(), { activeLeafTurnId: state.lastTurnId ?? "" });
	runtime.agent.state.messages = render();
	const inserts = createHostInserts({ session, readSessionEntries: () => session.readEntries(), leaf: () => "a1" });
	const failure = { push: false };
	// The flush lands, then the process fails before the live push.
	const hostInserts: HostInserts = {
		...inserts,
		insert(target, source, elements, options) {
			if (!failure.push) return inserts.insert(target, source, elements, options);
			failure.push = false;
			inserts.record(source, elements, options);
			throw new Error("failed after the flush, before the push");
		},
	};
	const context = createTurnContext({
		state,
		getSettings: () => DEFAULT_SETTINGS,
		providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
		session,
		readSessionEntries: () => session.readEntries(),
		hostInserts,
		memoryCommitBridge: memory,
		middleware: { fireCompactionHook: () => {} } as unknown as TurnMiddleware,
		emitNotice: () => {},
	});
	const restorations = (messages: ReadonlyArray<AgentMessage>): string[] =>
		messages.flatMap((item) =>
			item.role === "user" && typeof item.content === "string" && item.content.startsWith("<system-reminder>")
				? [item.content]
				: [],
		);
	return {
		memory,
		notes,
		failure,
		context,
		runtime,
		install: () => context.installMemoryRestoration(runtime, "next"),
		live: () => restorations(runtime.agent.state.messages),
		rendered: () => restorations(render()),
		records: () => inserts.onPath().filter((item) => item.source === "memory-restoration"),
		dispose() {
			context.dispose();
			memory.dispose();
		},
	};
}

test("restoration after a failure between the flush and the push is delivered at most once, as recorded", async () => {
	type Process = ReturnType<typeof restorationProcess>;
	const cases: Array<{
		name: string;
		between: (p: Process, world: { budget: { tokens: number }; bank: TaskMemoryBank; sessionId: string }) => void;
		/** "once": one delivery of the retried offer; "none": nothing installed or credited; "inherited": a fresh process. */
		expect: "once" | "none" | "inherited";
	}> = [
		{ name: "a retry with nothing changed", between: () => {}, expect: "once" },
		{
			name: "the bank changed before the retry",
			between: (_p, world) => {
				world.bank.saveKnowledge("A third fact learned while the request failed.");
			},
			expect: "once",
		},
		{
			name: "the budget changed before the retry",
			between: (_p, world) => {
				world.budget.tokens = 60;
			},
			expect: "once",
		},
		{
			name: "a stale scope: a stopped turn voided the offer's generation",
			between: (p, world) => {
				p.memory.signalLoop();
				p.memory.evaluate({ hook: "turn_end", sessionId: world.sessionId, metadata: { stopReason: "aborted" } });
			},
			expect: "once",
		},
		{
			name: "navigation before acknowledgement",
			between: (p) => p.context.resetForSession("u1"),
			expect: "none",
		},
		{ name: "a fresh process finding the unacknowledged install", between: () => {}, expect: "inherited" },
	];
	const env = await isolateClioEnv("memory-restoration-retry-");
	try {
		for (const row of cases) {
			const bundle = () => createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
			let session = bundle();
			const id = session.create({ cwd: env.dir }).id;
			const at = new Date(0).toISOString();
			session.appendEntry({
				kind: "message",
				turnId: "u1",
				parentTurnId: null,
				timestamp: at,
				role: "user",
				payload: { text: "fix the runner" },
			} as SessionEntryInput);
			session.appendEntry({
				kind: "message",
				turnId: "a1",
				parentTurnId: "u1",
				timestamp: at,
				role: "assistant",
				payload: { content: [{ type: "text", text: "on it" }], stopReason: "stop" },
			} as SessionEntryInput);
			const bank = new TaskMemoryBank();
			bank.saveKnowledge(`The runner needs the scratch preloader. ${"It reads the fixture root first. ".repeat(8)}`);
			bank.saveKnowledge("Tests run from the repo root.");
			const world = { bank, budget: { tokens: 400 }, sessionId: id };
			let p = restorationProcess(session, bank, world.budget);
			p.context.notifyMemoryCommit("commit-1", "continuity", "summarized");
			p.failure.push = true;
			throws(() => p.install(), /before the push/, row.name);
			const first = p.records();
			strictEqual(first.length, 1, `${row.name}: the flushed install is on the path`);
			deepStrictEqual(p.live(), [], `${row.name}: the live history never received it`);
			row.between(p, world);
			if (row.expect === "inherited") {
				p.dispose();
				await session.close();
				session = bundle();
				session.resume(id);
				p = restorationProcess(session, new TaskMemoryBank(), world.budget);
			}
			const installed = p.install();
			strictEqual(installed, row.expect === "once", `${row.name}: install outcome`);
			deepStrictEqual(p.rendered(), p.live(), `${row.name}: the request is the recorded history`);
			const delivered = p.live();
			const credited = bank
				.snapshot()
				.knowledge.filter((entry) => entry.injectionCount > 0)
				.map((entry) => entry.id);
			if (row.expect === "none") {
				deepStrictEqual(delivered, [], `${row.name}: the voided install is undone on both sides`);
				deepStrictEqual(p.records(), [], row.name);
				deepStrictEqual(credited, [], `${row.name}: nothing is credited`);
				continue;
			}
			strictEqual(delivered.length, 1, `${row.name}: one restoration in the request`);
			const [record] = p.records();
			ok(record?.restoration, row.name);
			deepStrictEqual(delivered, [(record.elements[0] as { content: string }).content], `${row.name}: the recorded bytes`);
			for (const cited of record.restoration.citedEntryIds) ok(delivered[0]?.includes(`[${cited}]`), row.name);
			if (row.expect === "inherited") {
				strictEqual(record.id, first[0]?.id, `${row.name}: it stays as delivered text`);
				deepStrictEqual(credited, [], `${row.name}: nothing is acknowledged for it`);
				strictEqual(p.install(), false);
				deepStrictEqual(p.notes, ["commit-1"], `${row.name}: the journal notes it once`);
			} else {
				deepStrictEqual([...credited].sort(), [...record.restoration.citedEntryIds].sort(), `${row.name}: cited ids`);
				ok(
					bank.snapshot().knowledge.every((entry) => entry.injectionCount <= 1),
					`${row.name}: one delivery`,
				);
				strictEqual(p.install(), false, `${row.name}: a later submit does not restore again`);
				deepStrictEqual(p.live(), delivered, row.name);
			}
			if (row.name === "a retry with nothing changed") strictEqual(record.id, first[0]?.id, "the same install");
			if (row.name === "the budget changed before the retry")
				strictEqual(record.restoration.citedEntryIds.length, 1, "the smaller budget cites less");
			p.dispose();
			await session.close();
		}
	} finally {
		env.restore();
	}
});

test("the tool-batch guard runs the memory install in its settled stretch, so both read one history walk (SC-6)", async () => {
	const env = await isolateClioEnv("memory-restoration-walks-");
	try {
		const session = createSessionBundle({ bus: { emit() {} } } as unknown as DomainContext).contract;
		session.create({ cwd: env.dir });
		const at = new Date(0).toISOString();
		session.appendEntry({
			kind: "message",
			turnId: "u1",
			parentTurnId: null,
			timestamp: at,
			role: "user",
			payload: { text: "fix the runner" },
		} as SessionEntryInput);
		session.appendEntry({
			kind: "message",
			turnId: "a1",
			parentTurnId: "u1",
			timestamp: at,
			role: "assistant",
			payload: { content: [{ type: "text", text: "on it" }], stopReason: "stop" },
		} as SessionEntryInput);
		const bank = new TaskMemoryBank();
		bank.saveKnowledge("Tests run from the repo root.");
		const p = restorationProcess(session, bank, { tokens: 400 });
		p.context.notifyMemoryCommit("commit-1", "continuity", "summarized");
		const runtime = p.runtime;
		// The operator's message stands for the history: the fold's trace check reads it once per walk.
		const first = runtime.agent.state.messages[0] as { content?: unknown };
		const content = first.content;
		let walks = 0;
		Object.defineProperty(first, "content", {
			enumerable: true,
			get: () => {
				if (new Error().stack?.includes("matchesTrace")) walks += 1;
				return content;
			},
		});
		p.context.refreshLiveBudget();
		walks = 0;
		let installed = false;
		await p.context.postToolContinuationGuard(runtime, undefined, true, () => {
			installed = p.install();
		});
		strictEqual(installed, true, "the guard ran the install as its tail");
		strictEqual(p.live().length, 1, "one restoration in the request");
		// Base walked twice: the guard's publication, then the install's own after the await.
		strictEqual(walks, 1, "the guard and the install read one walk");
		p.dispose();
		await session.close();
	} finally {
		env.restore();
	}
});
