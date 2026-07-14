import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryTelemetryStep } from "../../src/domains/memory/task-memory-telemetry.js";
import {
	createMemoryInterventionRegistration,
	MEMORY_INTERVENTION_REGISTRATION_ID,
} from "../../src/domains/middleware/memory-intervention.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";

function toolInput(
	hook: "before_tool" | "after_tool",
	call: number,
	args: Readonly<Record<string, unknown>>,
	resultKind: "ok" | "error" = "ok",
	errorMessage?: string,
): MiddlewareHookInput {
	return {
		hook,
		toolCallId: `call-${call}`,
		toolName: "bash",
		toolArgs: args,
		...(hook === "after_tool"
			? { metadata: { resultKind, ...(errorMessage === undefined ? {} : { errorMessage }) } }
			: {}),
	};
}

function execute(
	registration: ReturnType<typeof createMemoryInterventionRegistration>,
	call: number,
	args: Readonly<Record<string, unknown>>,
	resultKind: "ok" | "error" = "ok",
	errorMessage?: string,
): void {
	registration.evaluate(toolInput("before_tool", call, args));
	registration.evaluate(toolInput("after_tool", call, args, resultKind, errorMessage));
}

const SILENT_MODEL_RESPONSE = "<operations>[]</operations>\n<no_intervention/>";

describe("contracts/memory intervention rules tier", () => {
	it("writes one idempotent procedural record and emits one cited advisory for a repeated failure", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank });
		const args = { command: "npm run test:file -- failing.test.ts" };

		execute(registration, 1, args, "error", "fixture was missing");
		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), []);
		execute(registration, 2, args, "error", "fixture was missing");
		const effects = registration.evaluate({ hook: "turn_end" });
		const snapshot = bank.snapshot();

		strictEqual(registration.id, MEMORY_INTERVENTION_REGISTRATION_ID);
		strictEqual(snapshot.procedural.length, 1);
		match(snapshot.procedural[0]?.content ?? "", /failed 2 times/u);
		strictEqual(snapshot.procedural[0]?.injectionCount, 1);
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect?.kind === "inject_reminder");
		strictEqual(effect.severity, "advisory");
		strictEqual(registration.lastDecision(), "injected");
		ok(effect.message.startsWith(`Memory: [${snapshot.procedural[0]?.id}]`));
		match(effect.message, /already tried .* at step 1 and it failed with fixture was missing/u);
		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), [], "the same reminder is not emitted twice");
	});

	it("keeps healthy trajectories silent and writes nothing", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank });
		execute(registration, 1, { command: "npm test" });
		execute(registration, 2, { command: "npm run lint" });

		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), []);
		strictEqual(registration.lastDecision(), "silent");
		deepStrictEqual(bank.snapshot().procedural, []);
	});

	it("reactivates only knowledge once on the first turn after compaction", () => {
		const bank = new TaskMemoryBank();
		bank.updateStatus("private progress");
		const knowledge = bank.saveKnowledge("The requested branch is feat/fleet-dispatch.");
		bank.saveProcedural("An earlier command failed.");
		const registration = createMemoryInterventionRegistration({ bank, maxTokens: 80 });

		deepStrictEqual(registration.evaluate({ hook: "on_compaction" }), []);
		const effects = registration.evaluate({ hook: "turn_start" });
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect?.kind === "inject_reminder");
		strictEqual(effect.severity, "advisory");
		ok(effect.message.includes(knowledge.id));
		ok(!effect.message.includes("private progress"));
		ok(!effect.message.includes("An earlier command failed"));
		ok(Math.ceil(effect.message.length / 4) <= 80);
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 1);
		deepStrictEqual(registration.evaluate({ hook: "turn_start" }), []);
	});

	it("is bit-identical when disabled: no effects, bank writes, or model resolution", async () => {
		const bank = new TaskMemoryBank();
		let modelResolutions = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			enabled: false,
			getModelClient: () => {
				modelResolutions += 1;
				return null;
			},
		});
		execute(registration, 1, { command: "false" }, "error", "failed");
		execute(registration, 2, { command: "false" }, "error", "failed");
		for (const hook of ["turn_end", "on_compaction", "turn_start"] as const) {
			deepStrictEqual(registration.evaluate({ hook }), []);
		}
		registration.signalLoop();
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "disabled" }), []);
		strictEqual(modelResolutions, 0);
		deepStrictEqual(bank.snapshot(), { version: 1, status: null, knowledge: [], procedural: [] });
	});

	it("caps reminders and forgets failures that fall out of the trajectory window", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank, windowSteps: 2, maxTokens: 28 });
		const repeated = { command: `failing ${"x".repeat(400)}` };
		execute(registration, 1, repeated, "error", `long ${"y".repeat(400)}`);
		execute(registration, 2, repeated, "error", `long ${"y".repeat(400)}`);
		const effect = registration.evaluate({ hook: "turn_end" })[0];
		ok(effect?.kind === "inject_reminder");
		ok(Math.ceil(effect.message.length / 4) <= 28);
		ok(effect.message.includes(bank.snapshot().procedural[0]?.id ?? "missing id"));

		const boundedBank = new TaskMemoryBank();
		const bounded = createMemoryInterventionRegistration({ bank: boundedBank, windowSteps: 2 });
		execute(bounded, 1, { command: "old failure" }, "error", "failed");
		execute(bounded, 2, { command: "old failure" }, "error", "failed");
		execute(bounded, 3, { command: "healthy one" });
		execute(bounded, 4, { command: "healthy two" });
		deepStrictEqual(bounded.evaluate({ hook: "turn_end" }), []);
	});

	it("stays rules-only without constructing a model client when the background role is unset", async () => {
		const bank = new TaskMemoryBank();
		let routeResolutions = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => {
				routeResolutions += 1;
				return null;
			},
		});

		const result = await registration.runPromptedStep({ deterministicTrigger: true, task: "test task" });

		strictEqual(routeResolutions, 1);
		deepStrictEqual(result, {
			decision: "silent",
			bankOperations: 0,
			reminder: null,
			inputTokens: 0,
			outputTokens: 0,
			effects: [],
		});
		strictEqual(registration.lastDecision(), "silent");
	});

	it("preserves an injected rules outcome when the optional background route is unset", async () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank, getModelClient: () => null });
		const args = { command: "same failing command" };
		execute(registration, 1, args, "error", "failed");
		execute(registration, 2, args, "error", "failed");
		const effects = registration.evaluate({ hook: "turn_end", turnId: "rules-turn" });

		strictEqual(effects[0]?.kind, "inject_reminder");
		deepStrictEqual(
			await registration.evaluateAsync({ hook: "turn_end", turnId: "rules-turn" }, { priorEffects: effects }),
			[],
		);
		strictEqual(registration.lastDecision(), "injected");
	});

	it("fires the interval floor only after N completed tools and resets the cadence", async () => {
		const bank = new TaskMemoryBank();
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			everyNTools: 2,
			getModelClient: () => ({
				async complete() {
					calls += 1;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});

		execute(registration, 1, { command: "first" });
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-1" }), []);
		execute(registration, 2, { command: "second" });
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-2" }), []);
		strictEqual(calls, 1);
		execute(registration, 3, { command: "third" });
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-3" }), []);
		strictEqual(calls, 1, "cadence restarts after the memory step");
	});

	it("fires on two consecutive tool errors but resets the streak after success", async () => {
		const bank = new TaskMemoryBank();
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			everyNTools: 100,
			getModelClient: () => ({
				async complete() {
					calls += 1;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});

		execute(registration, 1, { command: "bad-a" }, "error", "a");
		execute(registration, 2, { command: "good" });
		execute(registration, 3, { command: "bad-b" }, "error", "b");
		await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-1" });
		strictEqual(calls, 0);
		execute(registration, 4, { command: "bad-c" }, "error", "c");
		await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-2" });
		strictEqual(calls, 1);
	});

	it("consumes a loop verdict as a deterministic trigger and permits one uncited advisory", async () => {
		const bank = new TaskMemoryBank();
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => ({
				async complete() {
					calls += 1;
					return {
						text: "<operations>[]</operations>\n<context_for_action>Do not repeat the looped call.</context_for_action>",
					};
				},
			}),
		});

		registration.signalLoop();
		const effects = await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-loop" });
		strictEqual(calls, 1);
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect?.kind === "inject_reminder");
		strictEqual(effect.severity, "advisory");
		strictEqual(effect.message, "Memory: Do not repeat the looped call.");
	});

	it("coalesces simultaneous triggers and runs at most once for one turn boundary", async () => {
		const bank = new TaskMemoryBank();
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			everyNTools: 2,
			getModelClient: () => ({
				async complete() {
					calls += 1;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});
		execute(registration, 1, { command: "bad-a" }, "error", "a");
		execute(registration, 2, { command: "bad-b" }, "error", "b");
		registration.signalLoop();

		await registration.evaluateAsync({ hook: "turn_end", turnId: "same-boundary" });
		await registration.evaluateAsync({ hook: "turn_end", turnId: "same-boundary" });
		strictEqual(calls, 1);
	});

	it("keeps post-compaction reactivation deterministic and free in the LLM tier", async () => {
		const bank = new TaskMemoryBank();
		bank.saveKnowledge("Keep the operator's required branch.");
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => ({
				async complete() {
					calls += 1;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});

		registration.evaluate({ hook: "on_compaction" });
		const effects = registration.evaluate({ hook: "turn_start", text: "resume task" });
		strictEqual(effects.length, 1);
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "post-compact" }), []);
		strictEqual(calls, 0);
	});

	it("reads next-turn trigger settings from the live settings layer", async () => {
		const bank = new TaskMemoryBank();
		let calls = 0;
		let live = { enabled: true, everyNTools: 4, windowSteps: 8, maxTokens: 400, timeoutMs: 20_000 };
		const registration = createMemoryInterventionRegistration({
			bank,
			getSettings: () => live,
			getModelClient: () => ({
				async complete() {
					calls += 1;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});
		execute(registration, 1, { command: "one" });
		live = { ...live, everyNTools: 2 };
		execute(registration, 2, { command: "two" });
		await registration.evaluateAsync({ hook: "turn_end", turnId: "live-cadence" });
		strictEqual(calls, 1);

		live = { ...live, enabled: false };
		registration.signalLoop();
		await registration.evaluateAsync({ hook: "turn_end", turnId: "live-disabled" });
		strictEqual(calls, 1);
	});

	it("preserves injected outcome across no-tool continuation and updates on healthy tool", async () => {
		const bank = new TaskMemoryBank();
		const telemetryRows: TaskMemoryTelemetryStep[] = [];
		let modelCalls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			getSettings: () => ({ enabled: true, everyNTools: 10, windowSteps: 8, maxTokens: 400, timeoutMs: 20_000 }),
			getModelClient: () => ({
				async complete() {
					modelCalls += 1;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
			telemetry: {
				record(step) {
					telemetryRows.push(step);
				},
			},
		});

		// 1. Execute same failing tool call twice.
		const args = { command: "same failing command" };
		execute(registration, 1, args, "error", "failed");
		execute(registration, 2, args, "error", "failed");

		// 2. Synchronous turn_end: should emit one cited inject_reminder.
		const syncEffects = registration.evaluate({ hook: "turn_end" });
		strictEqual(syncEffects.length, 1);
		ok(syncEffects[0]?.kind === "inject_reminder");
		strictEqual(registration.lastDecision(), "injected", "after synchronous injection");

		// Verify telemetry row for repeated_failure with rules tier.
		strictEqual(telemetryRows.length, 1);
		const row1 = telemetryRows[0];
		ok(row1);
		deepStrictEqual(row1.triggerReasons, ["repeated_failure"]);
		strictEqual(row1.tier, "rules");
		strictEqual(row1.decision, "injected");
		strictEqual(row1.citedEntries, 1);
		strictEqual(row1.inputTokens, 0);
		strictEqual(row1.outputTokens, 0);

		// 3. Asynchronous turn_end with priorEffects: should preserve injected outcome.
		const asyncEffects = await registration.evaluateAsync(
			{ hook: "turn_end", turnId: "async-1" },
			{ priorEffects: syncEffects },
		);
		strictEqual(asyncEffects.length, 0, "no new effect from async with priorEffects");
		strictEqual(registration.lastDecision(), "injected", "after async with priorEffects");
		strictEqual(modelCalls, 1, "model was called for the first async");

		strictEqual(telemetryRows.length, 2, "prompted evaluation records its result");
		strictEqual(telemetryRows[1]?.tier, "llm");
		strictEqual(telemetryRows[1]?.decision, "silent");

		// 4. Simulate middleware continuation: another turn_end with no intervening tools.
		const telemetryBeforeContinuation = telemetryRows.length;
		const syncContinuationEffects = registration.evaluate({ hook: "turn_end" });
		strictEqual(syncContinuationEffects.length, 0, "no synchronous effect from continuation");
		const continuationEffects = await registration.evaluateAsync({ hook: "turn_end", turnId: "continuation" });
		strictEqual(continuationEffects.length, 0, "no new effect from continuation");
		strictEqual(registration.lastDecision(), "injected", "after continuation");
		strictEqual(modelCalls, 1, "no model call during continuation");
		strictEqual(telemetryRows.length, telemetryBeforeContinuation, "no telemetry row after continuation");

		// 5. Execute a healthy tool and synchronous turn_end: should allow silent outcome.
		execute(registration, 3, { command: "healthy tool" });
		const postHealthyEffects = registration.evaluate({ hook: "turn_end" });
		strictEqual(postHealthyEffects.length, 0, "no injection after healthy tool");
		strictEqual(registration.lastDecision(), "silent", "after healthy tool turn_end");

		// Verify that a new telemetry row was emitted for the healthy turn_end (silent).
		strictEqual(telemetryRows.length, 3, "new telemetry row after healthy turn");
		const row3 = telemetryRows[2];
		ok(row3);
		deepStrictEqual(row3.triggerReasons, ["turn_end"]);
		strictEqual(row3.tier, "rules");
		strictEqual(row3.decision, "silent");
	});
});
