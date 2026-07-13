import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
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

	it("is bit-identical when disabled: no effects and no bank writes", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank, enabled: false });
		execute(registration, 1, { command: "false" }, "error", "failed");
		execute(registration, 2, { command: "false" }, "error", "failed");
		for (const hook of ["turn_end", "on_compaction", "turn_start"] as const) {
			deepStrictEqual(registration.evaluate({ hook }), []);
		}
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
	});
});
