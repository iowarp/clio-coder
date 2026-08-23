import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { TaskMemoryBank } from "../../src/domains/memory/task-bank.js";
import type { TaskMemoryTelemetryStep } from "../../src/domains/memory/task-memory-telemetry.js";
import {
	createMemoryInterventionRegistration,
	MEMORY_INTERVENTION_REGISTRATION_ID,
} from "../../src/domains/middleware/memory-intervention.js";
import type { MiddlewareEffect, MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import { TOOL_RESULT_DIGEST_MAX_BYTES, type ToolResultDigest } from "../../src/tools/result-disposition.js";

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
): ReadonlyArray<MiddlewareEffect> {
	registration.evaluate(toolInput("before_tool", call, args));
	return registration.evaluate(toolInput("after_tool", call, args, resultKind, errorMessage));
}

function executeWithDigest(
	registration: ReturnType<typeof createMemoryInterventionRegistration>,
	call: number,
	args: Readonly<Record<string, unknown>>,
	digest: ToolResultDigest,
	errorMessage: string,
): ReadonlyArray<MiddlewareEffect> {
	registration.evaluate(toolInput("before_tool", call, args));
	return registration.evaluate({
		...toolInput("after_tool", call, args, "error", errorMessage),
		toolResultDigest: digest,
	});
}

function promptedTrajectory(userPrompt: string): ReadonlyArray<Record<string, unknown>> {
	const marker = "Recent completed tool trajectory:";
	const at = userPrompt.indexOf(marker);
	if (at === -1) throw new Error("memory prompt omitted its trajectory");
	return JSON.parse(userPrompt.slice(at + marker.length).trim()) as ReadonlyArray<Record<string, unknown>>;
}

const SILENT_MODEL_RESPONSE = "<operations>[]</operations>\n<no_intervention/>";

describe("contracts/memory intervention rules tier", () => {
	it("writes one idempotent procedural record and annotates the repeated failure mid-turn", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank });
		const args = { command: "npm run test:file -- failing.test.ts" };

		deepStrictEqual(execute(registration, 1, args, "error", "fixture was missing"), [], "one failure is not news");
		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), []);
		const effects = execute(registration, 2, args, "error", "fixture was missing");
		const snapshot = bank.snapshot();

		strictEqual(registration.id, MEMORY_INTERVENTION_REGISTRATION_ID);
		strictEqual(snapshot.procedural.length, 1);
		match(snapshot.procedural[0]?.content ?? "", /failed 2 times/u);
		strictEqual(snapshot.procedural[0]?.injectionCount, 1);
		strictEqual(effects.length, 1);
		const effect = effects[0];
		// The advisory rides the failing tool result so the model reads it on its
		// next round, rather than waiting for a turn boundary that may be far off.
		ok(effect?.kind === "annotate_tool_result");
		strictEqual(effect.severity, "warn");
		strictEqual(registration.lastDecision(), "injected");
		ok(effect.message.startsWith(`Memory: [${snapshot.procedural[0]?.id}]`));
		match(effect.message, /already tried .* at step 1 and it failed with fixture was missing/u);
		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), [], "turn end does not repeat the annotation");
		deepStrictEqual(
			execute(registration, 3, args, "error", "fixture was missing"),
			[],
			"the same failure is annotated once per turn",
		);
	});

	it("spends the advisory's budget on the diagnosis rather than the runtime's own frame", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank });
		const args = { command: "node broken.js" };
		// A Node stack opens with three lines of loader bookkeeping before it says
		// anything about what went wrong, and closes with an absolute path that
		// repeats the command. Head-truncating that buries the diagnosis.
		const stack = [
			"node:internal/modules/cjs/loader:1423",
			"  throw err;",
			"  ^",
			"Error: Cannot find module './definitely-not-here.js'",
			"Require stack:",
			"- /a/very/long/absolute/path/that/eats/the/whole/budget/broken.js",
		].join("\n");

		execute(registration, 1, args, "error", stack);
		const effects = execute(registration, 2, args, "error", stack);
		const effect = effects[0];

		ok(effect?.kind === "annotate_tool_result");
		match(effect.message, /failed with Error: Cannot find module '\.\/definitely-not-here\.js'/u);
		ok(!effect.message.includes("cjs/loader:1423"), "the runtime's own frame is not the diagnosis");
		ok(!effect.message.includes("Require stack"), "one line is enough");
	});

	it("falls back to the first line when no line names a problem", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank });
		const args = { command: "tsc -p ." };
		const message = "TS2345: Argument of type A is not assignable to B\n  at line 12";

		execute(registration, 1, args, "error", message);
		const effect = execute(registration, 2, args, "error", message)[0];

		ok(effect?.kind === "annotate_tool_result");
		match(effect.message, /failed with TS2345: Argument of type A is not assignable to B/u);
		ok(!effect.message.includes("at line 12"));
	});

	it("keeps operation identity separate and sanitizes canonical digests before memory", async () => {
		const bank = new TaskMemoryBank();
		const prompts: string[] = [];
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => ({
				async complete(request) {
					prompts.push(request.userPrompt);
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});
		const args = { command: "npm run test:file -- stable.test.ts" };
		const secret = "api_key=abcdefghijklmnop";
		const provenance = {
			producer: "code",
			source: "canonical-result-disposition",
			algorithm: "redacted-context-digest-v1",
			contextMode: "summary",
		} as const;

		executeWithDigest(
			registration,
			1,
			args,
			{ text: `first failure ${secret} ${"x".repeat(400)}`, provenance },
			`raw first failure ${secret}`,
		);
		executeWithDigest(
			registration,
			2,
			args,
			{ text: `second failure ${secret}`, provenance },
			`raw second failure ${secret}`,
		);
		await registration.runPromptedStep({ deterministicTrigger: false, task: "inspect stable failure identity" });

		const bankText = JSON.stringify(bank.snapshot());
		strictEqual(bank.snapshot().procedural.length, 1, "one operation fingerprint updates one failure record");
		strictEqual(bankText.includes(secret), false);
		strictEqual(prompts.length, 1);
		strictEqual(prompts[0]?.includes(secret), false);
		const trajectory = promptedTrajectory(prompts[0] ?? "");
		strictEqual(trajectory.length, 2);
		strictEqual(trajectory[0]?.operationFingerprint, trajectory[1]?.operationFingerprint);
		strictEqual("fingerprint" in (trajectory[0] ?? {}), false);
		strictEqual(trajectory[0]?.resultDigest === trajectory[1]?.resultDigest, false);
		for (const step of trajectory) {
			ok(Buffer.byteLength(String(step.resultDigest), "utf8") <= TOOL_RESULT_DIGEST_MAX_BYTES);
			const digestProvenance = step.resultDigestProvenance as Record<string, unknown>;
			strictEqual(digestProvenance.source, "canonical-result-disposition");
			strictEqual(digestProvenance.contextMode, "summary");
			strictEqual(digestProvenance.redactions, 1);
		}
	});

	it("records a safe legacy provenance when canonical summaries are unavailable", async () => {
		const bank = new TaskMemoryBank();
		const prompts: string[] = [];
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => ({
				async complete(request) {
					prompts.push(request.userPrompt);
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});
		const secret = "api_key=abcdefghijklmnop";
		execute(registration, 1, { command: "legacy failing command" }, "error", `failed with ${secret}`);
		await registration.runPromptedStep({ deterministicTrigger: false, task: "inspect legacy fallback" });

		strictEqual(JSON.stringify(bank.snapshot()).includes(secret), false);
		strictEqual(prompts[0]?.includes(secret), false);
		const trajectory = promptedTrajectory(prompts[0] ?? "");
		const provenance = trajectory[0]?.resultDigestProvenance as Record<string, unknown>;
		strictEqual(provenance.source, "legacy-fallback");
		strictEqual(provenance.algorithm, "redacted-legacy-digest-v1");
		strictEqual(provenance.redactions, 1);
	});

	it("annotates a repeated failure again in a later turn", () => {
		const bank = new TaskMemoryBank();
		const registration = createMemoryInterventionRegistration({ bank });
		const args = { command: "make build" };

		execute(registration, 1, args, "error", "linker error");
		ok(execute(registration, 2, args, "error", "linker error")[0]?.kind === "annotate_tool_result");
		registration.evaluate({ hook: "turn_start", text: "try again" });
		ok(
			execute(registration, 3, args, "error", "linker error")[0]?.kind === "annotate_tool_result",
			"a new turn re-earns the advisory",
		);
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

	it("reactivates status and knowledge, but not procedural, once on the first turn after compaction", () => {
		const bank = new TaskMemoryBank();
		bank.updateStatus("private progress");
		const knowledge = bank.saveKnowledge("The requested branch is feat/fleet-dispatch.");
		bank.saveProcedural("An earlier command failed.");
		const registration = createMemoryInterventionRegistration({ bank, maxTokens: 200 });

		deepStrictEqual(registration.evaluate({ hook: "on_compaction" }), []);
		const effects = registration.evaluate({ hook: "turn_start" });
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect?.kind === "inject_reminder");
		strictEqual(effect.severity, "advisory");
		ok(effect.message.includes(knowledge.id));
		ok(effect.message.includes("private progress"), effect.message);
		ok(!effect.message.includes("An earlier command failed"));
		ok(Math.ceil(effect.message.length / 4) <= 200);
		strictEqual(bank.snapshot().knowledge[0]?.injectionCount, 1);
		deepStrictEqual(registration.evaluate({ hook: "turn_start" }), []);
	});

	/**
	 * Measured across ten live LLM steps on the background route: the model wrote
	 * update_status in every step and save_knowledge in two. Restoring knowledge
	 * alone therefore restored nothing in the common case and logged bank_empty.
	 */
	it("reactivates after compaction when the model wrote only status", () => {
		const bank = new TaskMemoryBank();
		bank.updateStatus("Mapping the routing call chain; the build is still failing.");
		const registration = createMemoryInterventionRegistration({ bank, maxTokens: 200 });

		deepStrictEqual(registration.evaluate({ hook: "on_compaction" }), []);
		const effects = registration.evaluate({ hook: "turn_start" });
		strictEqual(effects.length, 1);
		const effect = effects[0];
		ok(effect?.kind === "inject_reminder");
		ok(effect.message.includes("Mapping the routing call chain"), effect.message);
	});

	it("stays silent after compaction when the bank holds nothing at all", () => {
		const bank = new TaskMemoryBank();
		bank.saveProcedural("An earlier command failed.");
		const registration = createMemoryInterventionRegistration({ bank, maxTokens: 200 });

		deepStrictEqual(registration.evaluate({ hook: "on_compaction" }), []);
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
		const effect = execute(registration, 2, repeated, "error", `long ${"y".repeat(400)}`)[0];
		ok(effect?.kind === "annotate_tool_result");
		ok(Math.ceil(effect.message.length / 4) <= 28);
		ok(effect.message.includes(bank.snapshot().procedural[0]?.id ?? "missing id"));

		const boundedBank = new TaskMemoryBank();
		const bounded = createMemoryInterventionRegistration({ bank: boundedBank, windowSteps: 2 });
		execute(bounded, 1, { command: "old failure" }, "error", "failed");
		bounded.evaluate({ hook: "turn_start", text: "next" });
		execute(bounded, 2, { command: "healthy one" });
		execute(bounded, 3, { command: "healthy two" });
		deepStrictEqual(
			execute(bounded, 4, { command: "old failure" }, "error", "failed"),
			[],
			"a failure aged out of the window is not a repeat",
		);
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
			reason: "no_client",
			bankOperations: 0,
			droppedOperations: 0,
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
		strictEqual(execute(registration, 2, args, "error", "failed")[0]?.kind, "annotate_tool_result");

		registration.evaluate({ hook: "turn_end", turnId: "rules-turn" });
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "rules-turn" }), []);
		await registration.whenIdle();
		strictEqual(registration.lastDecision(), "injected", "a route that never ran does not report silence");
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

	it("consumes a loop verdict as a deterministic trigger and defers one uncited advisory", async () => {
		const bank = new TaskMemoryBank();
		const deferred: string[] = [];
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			onDeferredReminder: (message) => deferred.push(message),
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
		// The turn boundary is never held open for the background model.
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-loop" }), []);
		await registration.whenIdle();

		strictEqual(calls, 1);
		deepStrictEqual(deferred, ["Memory: Do not repeat the looped call."]);
		strictEqual(registration.lastDecision(), "injected");
		strictEqual(registration.stepInFlight(), false);
	});

	it("never holds a turn boundary open for a slow background model", async () => {
		const bank = new TaskMemoryBank();
		let release = (): void => undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const registration = createMemoryInterventionRegistration({
			bank,
			getModelClient: () => ({
				async complete() {
					await blocked;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});

		registration.signalLoop();
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "slow" }), []);
		strictEqual(registration.stepInFlight(), true, "the step outlives the boundary that started it");

		// A second boundary arriving while the first is still running is dropped
		// rather than queued behind it.
		registration.signalLoop();
		deepStrictEqual(await registration.evaluateAsync({ hook: "turn_end", turnId: "slow-2" }), []);

		release();
		await registration.whenIdle();
		strictEqual(registration.stepInFlight(), false);
		const activity = registration.recentActivity();
		strictEqual(activity.length, 2, "the drop is recorded even though it ran no second step");
		// Newest first: the slow step outlives the boundary it starved.
		strictEqual(activity[0]?.decision, "silent", "the step that held the slot");
		strictEqual(activity[1]?.decision, "dropped", "the boundary that arrived mid-step");
		deepStrictEqual(activity[1]?.triggerReasons, ["loop_signal"]);
		ok((activity[1]?.latencyMs ?? Number.POSITIVE_INFINITY) < 5, "a drop costs nothing");
	});

	it("records a dropped boundary without discarding its triggers or the visible outcome", async () => {
		const bank = new TaskMemoryBank();
		const rows: TaskMemoryTelemetryStep[] = [];
		let release = (): void => undefined;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		const registration = createMemoryInterventionRegistration({
			bank,
			everyNTools: 2,
			telemetry: {
				record(step) {
					rows.push(step);
				},
			},
			getModelClient: () => ({
				async complete() {
					calls += 1;
					if (calls === 1) await blocked;
					return { text: SILENT_MODEL_RESPONSE };
				},
			}),
		});

		execute(registration, 1, { command: "one" });
		execute(registration, 2, { command: "two" });
		await registration.evaluateAsync({ hook: "turn_end", turnId: "boundary-1" });
		strictEqual(registration.stepInFlight(), true);

		// A boundary arriving mid-step is dropped, but its triggers stay pending so
		// the next free boundary still runs for them.
		execute(registration, 3, { command: "three" });
		execute(registration, 4, { command: "four" });
		await registration.evaluateAsync({ hook: "turn_end", turnId: "boundary-2" });
		strictEqual(calls, 1, "the dropped boundary started no second call");
		const dropped = rows.filter((row) => row.decision === "dropped");
		strictEqual(dropped.length, 1);
		deepStrictEqual(dropped[0]?.triggerReasons, ["interval"]);
		strictEqual(dropped[0]?.tier, "llm", "the tier of the step that held the slot");
		strictEqual(dropped[0]?.inputTokens, 0);
		strictEqual(dropped[0]?.outputTokens, 0);

		release();
		await registration.whenIdle();
		await registration.evaluateAsync({ hook: "turn_end", turnId: "boundary-3" });
		await registration.whenIdle();
		strictEqual(calls, 2, "the dropped boundary's triggers survived to the next free boundary");
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

	it("does not treat working-set recall as context loss that needs memory reactivation", () => {
		const bank = new TaskMemoryBank();
		bank.saveKnowledge("Keep the operator's required branch.");
		const registration = createMemoryInterventionRegistration({ bank });

		registration.evaluate({
			hook: "on_compaction",
			metadata: { stage: "working_set_recall", trigger: "tool" },
		});

		deepStrictEqual(registration.evaluate({ hook: "turn_start", text: "resume task" }), []);
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

		// 1. Execute same failing tool call twice; the repeat is annotated mid-turn.
		const args = { command: "same failing command" };
		execute(registration, 1, args, "error", "failed");
		const midTurn = execute(registration, 2, args, "error", "failed");
		strictEqual(midTurn.length, 1);
		ok(midTurn[0]?.kind === "annotate_tool_result");
		strictEqual(registration.lastDecision(), "injected", "after the mid-turn annotation");

		// 2. Synchronous turn_end has nothing left to say about that failure.
		deepStrictEqual(registration.evaluate({ hook: "turn_end" }), []);

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

		// 3. The detached step runs but must not overwrite the visible outcome.
		const asyncEffects = await registration.evaluateAsync({ hook: "turn_end", turnId: "async-1" });
		strictEqual(asyncEffects.length, 0, "the boundary is never held open");
		await registration.whenIdle();
		strictEqual(registration.lastDecision(), "injected", "after the detached step settles");
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
		await registration.whenIdle();
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

	it("declines a background step when nothing in the process can consume its reminder", async () => {
		// A headless run submits no further turn, and the step is detached from the
		// boundary that triggered it, so the process exits before a route measured
		// in tens of seconds answers. Starting one spends a model call to discard
		// the result.
		const records: Array<{ decision: string; reason: string; tier: string }> = [];
		let clientResolutions = 0;
		const registration = createMemoryInterventionRegistration({
			bank: new TaskMemoryBank(),
			everyNTools: 2,
			deliversDeferredReminders: false,
			telemetry: { record: (record) => records.push(record as unknown as (typeof records)[number]) },
			getModelClient: () => {
				clientResolutions += 1;
				return {
					async complete() {
						return { text: "<operations>[]</operations>\n<no_intervention/>" };
					},
				};
			},
		});
		for (let call = 1; call <= 2; call += 1) {
			registration.evaluate({ hook: "before_tool", toolCallId: `${call}`, toolName: "bash", toolArgs: { call } });
			registration.evaluate({
				hook: "after_tool",
				toolCallId: `${call}`,
				toolName: "bash",
				toolArgs: { call },
				metadata: { resultKind: "ok" },
			});
		}
		registration.evaluate({ hook: "turn_end", turnId: "turn-1" });
		await registration.evaluateAsync({ hook: "turn_end", turnId: "turn-1" });
		await registration.whenIdle();

		strictEqual(clientResolutions, 0, "no model call is worth making for a result nobody reads");
		strictEqual(registration.stepInFlight(), false);
		const declined = records.filter((record) => record.reason === "no_consumer");
		strictEqual(declined.length, 1, "the skip is recorded, so an operator is not left guessing again");
		strictEqual(declined[0]?.decision, "silent");
		strictEqual(declined[0]?.tier, "rules");
	});
});
