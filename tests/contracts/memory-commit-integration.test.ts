import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryModelResponse } from "../../src/domains/memory/task-memory-policy.js";
import { createMemoryInterventionRegistration } from "../../src/domains/middleware/memory-intervention.js";
import { createTurnMiddleware } from "../../src/interactive/turn-middleware.js";
import { createTurnState } from "../../src/interactive/turn-state.js";

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
	const usageCurrent: boolean[] = [];
	const memory = createMemoryInterventionRegistration({
		bank,
		getModelClient: () => ({ complete: () => pending }),
		captureStepUsage: () => (_usage, current) => usageCurrent.push(current),
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
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			reasoning: 0,
			totalTokens: 12,
			costUsd: 0,
			costProvenance: "known",
			durationMs: 1,
			backend: null,
		},
	});
	const result = await step;
	strictEqual(result.reminder, null);
	strictEqual(bank.snapshot().knowledge.length, 0);
	deepStrictEqual(usageCurrent, [true]);
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
