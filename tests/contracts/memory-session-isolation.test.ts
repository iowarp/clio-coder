import assert from "node:assert/strict";
import test from "node:test";
import { BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import type { TaskMemoryEntry } from "../../src/domains/memory/task-bank.js";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryModelResponse } from "../../src/domains/memory/task-memory-policy.js";
import {
	runTaskMemoryPolicy,
	type TaskMemoryModelRequest,
	type TaskMemoryStepUsage,
} from "../../src/domains/memory/task-memory-policy.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import type { OutOfTurnUsageRow } from "../../src/domains/observability/out-of-turn-usage.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { bindTaskMemoryLifecycle, captureTaskMemoryUsage } from "../../src/entry/task-memory-lifecycle.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

// Ported reproductions of the original lazy bank-only session clearing.
// Model responses are fixtures; lifecycle tests below use isolated session storage.
test("a memory completion from session A must not populate session B", async () => {
	const bank = new TaskMemoryBank();
	let sessionId = "session-A";
	let bankSessionId = sessionId;
	let resolveCompletion!: (response: TaskMemoryModelResponse) => void;
	const completion = new Promise<TaskMemoryModelResponse>((resolve) => {
		resolveCompletion = resolve;
	});
	const reminders: Array<{ sessionId: string; message: string }> = [];
	const proposals: Array<{ sessionId: string; entries: ReadonlyArray<TaskMemoryEntry> }> = [];
	const registration = createMemoryInterventionRegistration({
		bank,
		getSettings() {
			if (sessionId !== bankSessionId) {
				bank.clear();
				bankSessionId = sessionId;
			}
			return { enabled: true, everyNTools: 2, windowSteps: 8, maxTokens: 2000, timeoutMs: 1000 };
		},
		getModelClient: () => ({ complete: () => completion }),
		onDeferredReminder: (message) => reminders.push({ sessionId, message }),
		onInjectedEntries: (entries) => proposals.push({ sessionId, entries }),
	});
	registration.evaluate({ hook: "turn_start", sessionId, text: "Investigate repository A." });
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end", sessionId, turnId: "A-turn" });
	assert.equal(registration.stepInFlight(), true);
	const originIdle = registration.whenIdle();
	sessionId = "session-B";
	registration.evaluate({ hook: "turn_start", sessionId, text: "An unrelated task in session B." });
	assert.equal(bank.snapshot().knowledge.length, 0);
	resolveCompletion({
		text:
			'<operations>[{"op":"save_knowledge","content":"Session A private task fact."}]</operations>\n<context_for_action>[tm-k-1] Retain the session A fact.</context_for_action>',
	});
	await originIdle;
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(bank.snapshot().knowledge, [], "late session A output entered session B memory");
	assert.deepEqual(reminders, [], "late session A reminder was delivered into session B");
	assert.deepEqual(proposals, [], "late session A memory was proposed under session B identity");
});

test("clearing the bank on a session change must also isolate tool trajectory", async () => {
	const bank = new TaskMemoryBank();
	let sessionId = "session-A";
	let bankSessionId = sessionId;
	let nextPrompt = "";
	const registration = createMemoryInterventionRegistration({
		bank,
		getSettings() {
			if (sessionId !== bankSessionId) {
				bank.clear();
				bankSessionId = sessionId;
			}
			return { enabled: true, everyNTools: 2, windowSteps: 8, maxTokens: 2000, timeoutMs: 1000 };
		},
		getModelClient: () => ({
			complete: async (request) => {
				nextPrompt = request.userPrompt;
				return { text: "<operations>[]</operations>\n<no_intervention/>" };
			},
		}),
	});
	registration.evaluate({ hook: "turn_start", sessionId, text: "Task A." });
	registration.evaluate({
		hook: "after_tool",
		sessionId,
		toolName: "read",
		toolCallId: "A-read",
		toolArgs: { path: "session-A-only-file.ts" },
		metadata: { resultKind: "ok" },
	});
	sessionId = "session-B";
	registration.evaluate({ hook: "turn_start", sessionId, text: "Task B." });
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end", sessionId, turnId: "B-turn" });
	await registration.whenIdle();
	assert.equal(
		nextPrompt.includes("session-A-only-file.ts"),
		false,
		"session A trajectory was sent with session B task",
	);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const response: TaskMemoryModelResponse = {
	text:
		'<operations>[{"op":"save_knowledge","content":"Origin fact"}]</operations><context_for_action>[tm-k-1] Use origin fact</context_for_action>',
	usage: {
		targetId: "fixture",
		attributedModelId: "fixture",
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 10,
		costUsd: 0.01,
		costProvenance: "known",
		durationMs: 25,
		backend: null,
	},
};

for (const transition of ["new", "resume", "roundtrip", "fork", "branch"] as const) {
	test(`real session ${transition} invalidates before mutation and preserves originating spend`, async () => {
		const env = await isolateClioEnv("clio-memory-lifecycle-");
		const bus = createSafeEventBus();
		const { contract: session } = createSessionBundle({ bus, getContract: () => undefined });
		const bank = new TaskMemoryBank();
		const pending = [deferred<TaskMemoryModelResponse>(), deferred<TaskMemoryModelResponse>()] as const;
		const requests: TaskMemoryModelRequest[] = [];
		const rows: OutOfTurnUsageRow[] = [];
		const live: number[] = [];
		const proposals: Array<{ sessionId: string | undefined; entries: ReadonlyArray<TaskMemoryEntry> }> = [];
		const reminders: string[] = [];
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => ({
				complete: (request) => {
					requests.push(request);
					return required(pending[requests.length - 1]).promise;
				},
			}),
			captureStepUsage: () =>
				captureTaskMemoryUsage({
					stateDir: env.dir,
					sessionId: required(session.current()).id,
					repoIdentity: required(session.current()).cwdHash,
					appendRow: (_dir, row) => rows.push(row),
					observability: {
						recordTokens: (_provider, _model, tokens) => {
							live.push(tokens);
						},
					},
				}),
			onInjectedEntries: (entries) => proposals.push({ sessionId: session.current()?.id, entries }),
			onDeferredReminder: (message) => reminders.push(message),
		});
		const dispose = bindTaskMemoryLifecycle(bus, registration);
		try {
			const alternate = session.create({ cwd: env.dir }).id;
			const origin = session.create({ cwd: env.dir });
			const root = session.append({ parentId: null, kind: "user", payload: "root" }).id;
			session.append({ parentId: root, kind: "assistant", payload: "tip" });
			registration.evaluate({ hook: "turn_start", sessionId: origin.id, text: "Origin task" });
			registration.signalLoop();
			await registration.evaluateAsync({ hook: "turn_end", sessionId: origin.id, turnId: "same-boundary" });
			const oldIdle = registration.whenIdle();
			assert.equal(registration.stepInFlight(), true);
			if (transition === "new") session.create({ cwd: env.dir });
			if (transition === "resume" || transition === "roundtrip") session.resume(alternate);
			if (transition === "roundtrip") session.resume(origin.id);
			if (transition === "fork") session.fork(root);
			if (transition === "branch") session.switchTurn(root);
			assert.equal(required(requests[0]).signal.aborted, true);
			assert.equal(registration.stepInFlight(), false);
			const successor = required(session.current()).id;
			registration.evaluate({ hook: "turn_start", sessionId: successor, text: "Successor task" });
			registration.signalLoop();
			await registration.evaluateAsync({ hook: "turn_end", sessionId: successor, turnId: "same-boundary" });
			await oldIdle;
			assert.equal(registration.stepInFlight(), true, "old finally must not free the new generation's slot");
			pending[0].resolve(response); // Deliberately ignores abort.
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(bank.snapshot().knowledge.length, 0);
			assert.deepEqual(reminders, []);
			assert.equal(proposals.length, 0);
			assert.deepEqual(registration.recentActivity(), []);
			assert.equal(rows.length, 1);
			assert.equal(required(rows[0]).sessionId, origin.id);
			assert.equal(required(rows[0]).repoIdentity, origin.cwdHash);
			assert.equal(required(rows[0]).usage.totalTokens, 10);
			assert.deepEqual(live, [], "old spend must not inflate successor live totals, even after A->B->A");
			assert.equal(registration.stepInFlight(), true);
			pending[1].resolve(response);
			await registration.whenIdle();
			assert.equal(bank.snapshot().knowledge.length, 1);
			assert.equal(reminders.length, 1);
			assert.equal(required(proposals[0]).sessionId, successor);
			assert.equal(required(rows[1]).sessionId, successor);
			assert.deepEqual(live, [10]);
		} finally {
			dispose();
			await session.close();
			env.restore();
		}
	});
}

test("tree reads, same-session resume, forward turns and compaction preserve memory authority", async () => {
	const env = await isolateClioEnv("clio-memory-continuity-");
	const bus = createSafeEventBus();
	const { contract: session } = createSessionBundle({ bus, getContract: () => undefined });
	const bank = new TaskMemoryBank();
	const completion = deferred<TaskMemoryModelResponse>();
	let request: TaskMemoryModelRequest | undefined;
	const registration = createMemoryInterventionRegistration({
		bank,
		getModelClient: () => ({
			complete: (input) => {
				request = input;
				return completion.promise;
			},
		}),
	});
	const dispose = bindTaskMemoryLifecycle(bus, registration);
	try {
		const id = session.create({ cwd: env.dir }).id;
		registration.evaluate({ hook: "turn_start", sessionId: id, text: "Task" });
		registration.signalLoop();
		await registration.evaluateAsync({ hook: "turn_end", sessionId: id, turnId: "first" });
		const root = session.append({ parentId: null, kind: "user", payload: "next" }).id;
		session.append({ parentId: root, kind: "assistant", payload: "answer" });
		session.tree();
		session.resume(id);
		session.switchBranch(id);
		bank.saveKnowledge("Known before compaction");
		registration.evaluate({ hook: "on_compaction", sessionId: id, metadata: { stage: "llm_summary" } });
		const effects = registration.evaluate({ hook: "turn_start", sessionId: id, text: "Next task" });
		assert.ok(effects.some((effect) => effect.kind === "inject_reminder"));
		assert.equal(required(request).signal.aborted, false);
		assert.equal(registration.stepInFlight(), true);
		completion.resolve(response);
		await registration.whenIdle();
		assert.equal(bank.snapshot().knowledge.length, 2);
	} finally {
		dispose();
		await session.close();
		env.restore();
	}
});

test("reset clears pending tools, cadence, failures, triggers, activity and compaction reactivation", async () => {
	const bank = new TaskMemoryBank();
	const prompts: string[] = [];
	const registration = createMemoryInterventionRegistration({
		bank,
		everyNTools: 2,
		getModelClient: () => ({
			complete: async (request) => {
				prompts.push(request.userPrompt);
				return { text: "<operations>[]</operations><no_intervention/>" };
			},
		}),
	});
	const tool = (hook: "before_tool" | "after_tool", path: string, error = false) =>
		registration.evaluate({
			hook,
			toolName: "read",
			toolCallId: "reused",
			toolArgs: { path },
			metadata: { resultKind: error ? "error" : "ok" },
		});
	registration.evaluate({ hook: "turn_start", sessionId: "A", text: "Private A task" });
	tool("after_tool", "A-file", true);
	assert.equal(tool("after_tool", "A-file", true).length, 1);
	tool("before_tool", "A-pending");
	registration.signalLoop();
	registration.evaluate({ hook: "on_compaction" });
	assert.ok(registration.recentActivity().length > 0);
	registration.reset();
	assert.deepEqual(registration.recentActivity(), []);
	assert.equal(registration.lastDecision(), null);
	assert.deepEqual(registration.evaluate({ hook: "turn_start", sessionId: "B", text: "New B task" }), []);
	assert.deepEqual(tool("after_tool", "B-file", true), []);
	await registration.evaluateAsync({ hook: "turn_end", turnId: "one" });
	assert.equal(prompts.length, 0, "old cadence and triggers were discarded");
	tool("after_tool", "B-next");
	await registration.evaluateAsync({ hook: "turn_end", turnId: "two" });
	await registration.whenIdle();
	assert.equal(prompts.length, 1);
	assert.ok(
		!required(prompts[0]).includes("A-file") &&
			!required(prompts[0]).includes("A-pending") &&
			!required(prompts[0]).includes("Private A"),
	);
	assert.ok(required(prompts[0]).includes("B-file"));
});

test("shutdown releases the detached policy without awaiting an abort-ignoring model", async () => {
	const bank = new TaskMemoryBank();
	const bus = createSafeEventBus();
	const completion = deferred<TaskMemoryModelResponse>();
	const usages: TaskMemoryStepUsage[] = [];
	const registration = createMemoryInterventionRegistration({
		bank,
		getModelClient: () => ({ complete: () => completion.promise }),
		onStepUsage: (usage) => usages.push(usage),
	});
	const dispose = bindTaskMemoryLifecycle(bus, registration);
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end" });
	const idle = registration.whenIdle();
	bus.emit(BusChannels.SessionEnd, { exitCode: 0 });
	await idle;
	assert.equal(registration.stepInFlight(), false);
	completion.resolve(response);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(bank.snapshot().knowledge.length, 0);
	assert.equal(usages.length, 1);
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end" });
	assert.equal(registration.stepInFlight(), false);
	dispose();
});

test("generation authority blocks bank writes even without cancellation", async () => {
	const bank = new TaskMemoryBank();
	const completion = deferred<TaskMemoryModelResponse>();
	let current = true;
	const result = runTaskMemoryPolicy(
		bank,
		{ complete: () => completion.promise },
		{ task: "A", trajectory: [], deterministicTrigger: true, maxTokens: 2000, isCurrent: () => current },
	);
	current = false;
	completion.resolve(response);
	const settled = await result;
	assert.equal(settled.reason, "scope_changed");
	assert.equal(settled.bankOperations, 0);
	assert.equal(settled.usage?.totalTokens, 10);
	assert.equal(bank.snapshot().knowledge.length, 0);
});

test("provider usage arriving after the policy deadline is recorded exactly once", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const bank = new TaskMemoryBank();
	const completion = deferred<TaskMemoryModelResponse>();
	const usages: TaskMemoryStepUsage[] = [];
	const result = runTaskMemoryPolicy(
		bank,
		{ complete: () => completion.promise },
		{
			task: "A",
			trajectory: [],
			deterministicTrigger: true,
			maxTokens: 2000,
			timeoutMs: 10,
			onStepUsage: (usage) => usages.push(usage),
		},
	);
	t.mock.timers.tick(10);
	assert.equal((await result).reason, "deadline");
	completion.resolve(response);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(usages, [response.usage]);
	assert.equal(bank.snapshot().knowledge.length, 0);
});

test("timeout backoff resets, while settings toggles, busy endpoints and reminder dedup retain same-scope behavior", async () => {
	const bank = new TaskMemoryBank();
	let enabled = true;
	let busy = false;
	let timeout = true;
	let calls = 0;
	const registration = createMemoryInterventionRegistration({
		bank,
		getSettings: () => ({ enabled, everyNTools: 2, windowSteps: 8, maxTokens: 2000, timeoutMs: 1000 }),
		backgroundEndpointBusy: () => busy,
		getModelClient: () => ({
			complete: async () => {
				calls += 1;
				if (timeout) {
					const error = new Error("deadline");
					error.name = "TimeoutError";
					throw error;
				}
				return response;
			},
		}),
	});
	const run = () => registration.runPromptedStep({ deterministicTrigger: true });
	assert.equal((await run()).decision, "timeout");
	assert.equal((await run()).decision, "timeout");
	assert.equal((await run()).reason, "llm_timeout_backoff");
	assert.equal(calls, 2);
	registration.reset();
	timeout = false;
	busy = true;
	assert.equal((await run()).reason, "endpoint_busy");
	assert.equal(calls, 2);
	busy = false;
	enabled = false;
	assert.equal((await run()).reason, "no_client");
	enabled = true;
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end", turnId: "one" });
	await registration.whenIdle();
	assert.equal(calls, 3);
	assert.equal(registration.lastDecision(), "injected");
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end", turnId: "two" });
	await registration.whenIdle();
	assert.equal(required(registration.recentActivity()[0]).reason, "duplicate_reminder");
	registration.reset();
	registration.signalLoop();
	await registration.evaluateAsync({ hook: "turn_end", turnId: "two" });
	await registration.whenIdle();
	assert.equal(registration.lastDecision(), "injected");
});

function required<T>(value: T | null | undefined): T {
	assert.ok(value !== undefined && value !== null);
	return value;
}
