import { ok, rejects, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels, type LoopBlockedPayload, type ToolBudgetExceededPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import {
	configureGuardrails,
	GUARDRAIL_DEFAULTS,
	isWorkerSynthesisReserveBlockReason,
	isWorkerToolCallCapExceededReason,
	isWorkerToolCallCapSynthesisReason,
	mentionsWorkerToolCallCap,
	resolveGuardrail,
	workerSynthesisReserveBlockReason,
	workerSynthesisReserveDirective,
	workerToolCallCapSynthesisReason,
} from "../../src/core/guardrails.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareContract } from "../../src/domains/middleware/index.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createLoopState, hashToolCall, type LoopVerdict, observe } from "../../src/domains/safety/loop-detector.js";
import type { SafetyPolicyDecision } from "../../src/domains/safety/policy-engine.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	createLoopGuardRegistration,
	DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	isLoopGuardSynthesisBackstopReason,
	LOOP_GUARD_REGISTRATION_ID,
	LOOP_SYNTHESIS_BACKSTOP_DENIALS,
	lockedSynthesisFallbackText,
	ORCH_TURN_TOOL_CALL_HARD_MARGIN,
	readOrchTurnToolCallBudget,
	readWorkerToolCallCap,
	sanitizeLockedSynthesisMessage,
} from "../../src/engine/loop-guard.js";
import type { AgentMessage } from "../../src/engine/types.js";
import { invokeRegisteredTool, type ToolFinishEvent } from "../../src/tools/agent-tools.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

const LOOP_THRESHOLD = createLoopState().maxRepeats;

/** Safety stub backed by the real sliding-window loop detector. */
function testSafety(
	options: { blockTool?: string; askTool?: string; actionClass?: "read" | "execute" } = {},
): SafetyContract {
	let loopState = createLoopState();
	const actionClass = options.actionClass ?? "read";
	return {
		classify: () => ({ actionClass, reasons: [] }),
		evaluate: (call) => {
			if (options.blockTool !== undefined && call.tool === options.blockTool) {
				return {
					kind: "block",
					classification: { actionClass: "read", reasons: [] },
					rejection: { short: `${call.tool} blocked by policy`, detail: "test block", hints: [] },
				};
			}
			if (options.askTool !== undefined && call.tool === options.askTool) {
				return {
					kind: "ask",
					classification: { actionClass: "write", reasons: [] },
					rejection: { short: `${call.tool} needs confirmation`, detail: "test ask", hints: [] },
				};
			}
			return { kind: "allow", classification: { actionClass, reasons: [] } };
		},
		observeLoop(key, now) {
			const [next, verdict] = observe(loopState, key, now ?? Date.now());
			loopState = next;
			return verdict;
		},
		scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
		isSubset: () => true,
		audit: { recordCount: () => 0 },
	};
}

function mockReadSpec(name: ToolName = ToolNames.Read): ToolSpec {
	return {
		name,
		description: "test tool",
		parameters: Type.Object({}),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: "contents" }),
	};
}

function guardedRegistry(input: {
	safety: SafetyContract;
	middleware: MiddlewareContract;
}): ReturnType<typeof createRegistry> {
	const registry = createRegistry({ safety: input.safety, middleware: input.middleware });
	registry.register(mockReadSpec());
	return registry;
}

describe("loop detector retention", () => {
	it("retains recent attempts by count so slow identical calls still trip", () => {
		let state = createLoopState();
		let verdict: LoopVerdict;
		[state, verdict] = observe(state, "read:a", 0);
		[state, verdict] = observe(state, "read:a", 40_000);
		strictEqual(verdict.looping, false);

		[state, verdict] = observe(state, "read:a", 80_000);
		strictEqual(verdict.looping, true);
		strictEqual(verdict.count, 3);
	});

	it("does not count identical attempts separated by four other old attempts", () => {
		let state = createLoopState();
		let verdict: LoopVerdict;
		[state, verdict] = observe(state, "read:a", 0);
		for (let i = 1; i <= 4; i += 1) {
			[state, verdict] = observe(state, `read:other-${i}`, i * 40_000);
		}
		[state, verdict] = observe(state, "read:a", 200_000);
		for (let i = 5; i <= 8; i += 1) {
			[state, verdict] = observe(state, `read:other-${i}`, i * 40_000);
		}
		[state, verdict] = observe(state, "read:a", 400_000);

		strictEqual(verdict.looping, false);
		ok(verdict.count < LOOP_THRESHOLD, `separated attempts must not form a streak, got count ${verdict.count}`);
	});

	it("honors a custom keepLastAttempts value from createLoopState", () => {
		const oldAttempts = [
			{ key: "read:a", at: 0 },
			{ key: "read:a", at: 40_000 },
		];

		const [, verdict] = observe({ ...createLoopState({ keepLastAttempts: 2 }), recent: oldAttempts }, "read:a", 80_000);
		strictEqual(verdict.looping, false);
		strictEqual(verdict.count, 2);

		const [, defaultVerdict] = observe({ ...createLoopState(), recent: oldAttempts }, "read:a", 80_000);
		strictEqual(defaultVerdict.looping, true);
		strictEqual(defaultVerdict.count, 3);
	});
});

describe("unified loop guard registration", () => {
	it("pins the tuned defaults that bound a runaway local-model turn", () => {
		// Identical-call loops on weak local models must trip fast: three verbatim
		// repeats to block, two blocks to interrupt. Raising these regresses the
		// runaway-turn hardening that motivated them.
		strictEqual(LOOP_THRESHOLD, 3, "identical-call detector trips on the third repeat");
		strictEqual(INTERACTIVE_LOOP_BLOCK_BUDGET, 2, "two loop blocks per turn before interrupt");
	});

	it("blocks the identical call at the detector threshold and recovers with house-style feedback", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			strictEqual(verdict.kind, "ok", `call ${i} below threshold must execute`);
		}
		const blocked = await registry.invoke(call, { turnId: "t1" });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason.includes("loop detected"), "reason names the loop");
		ok(blocked.kind === "blocked" && blocked.reason.includes(ToolNames.Read), "reason names the tool");
		ok(blocked.kind === "blocked" && blocked.reason.includes("Change strategy"), "reason asks for a strategy change");
	});

	it("does not block calls whose arguments differ", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < LOOP_THRESHOLD * 2; i++) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `file-${i}.md` } }, { turnId: "t1" });
			strictEqual(verdict.kind, "ok", `distinct call ${i} must execute`);
		}
	});

	it("blocks slow identical calls within one turn but not identical calls across turns", async () => {
		let now = 0;
		const slowSafety = testSafety();
		const slowBundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety: slowSafety, now: () => now })],
		});
		const slowRegistry = guardedRegistry({ safety: slowSafety, middleware: slowBundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };

		for (const [index, at] of ([0, 40_000] as const).entries()) {
			now = at;
			const verdict = await slowRegistry.invoke(call, { turnId: "t1" });
			strictEqual(verdict.kind, "ok", `slow same-turn call ${index + 1} below threshold must execute`);
		}
		now = 80_000;
		const blocked = await slowRegistry.invoke(call, { turnId: "t1" });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason.includes("loop detected"), "third slow call is blocked");
		ok(
			blocked.kind === "blocked" && !blocked.reason.includes("within 30s"),
			"reason no longer claims a fixed wall-clock window",
		);

		now = 0;
		const turnSafety = testSafety();
		const turnBundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety: turnSafety, now: () => now })],
		});
		const turnRegistry = guardedRegistry({ safety: turnSafety, middleware: turnBundle.contract });
		for (const [index, turnId] of ["t1", "t2", "t3"].entries()) {
			now = index * 40_000;
			const verdict = await turnRegistry.invoke(call, { turnId });
			strictEqual(verdict.kind, "ok", `same call in ${turnId} starts a fresh turn-scoped streak`);
		}
	});

	it("blocks the size-escalation cycle once results stagnate", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		// Same call shape with only the limit changing; the mock tool returns the
		// same "contents" every time, so the size escalation buys nothing. The
		// verbatim detector never sees a repeat (args differ each call), but the
		// stagnation detector must block the third attempt.
		const first = await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md", limit: 100 } }, { turnId: "t1" });
		strictEqual(first.kind, "ok");
		const second = await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md", limit: 200 } }, { turnId: "t1" });
		strictEqual(second.kind, "ok");
		const third = await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md", limit: 500 } }, { turnId: "t1" });
		strictEqual(third.kind, "blocked");
		ok(third.kind === "blocked" && third.reason.includes("byte-identical results"), third.kind);
		ok(third.kind === "blocked" && third.reason.includes(ToolNames.Read));
	});

	it("identical results do not count as stagnation when a non-size argument changes", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		// Honest exploration: the pattern changes each call even though the mock
		// output is identical (e.g. repeated "No matches found"). A changed query
		// is new information about a different question; never block it.
		for (let i = 0; i < LOOP_THRESHOLD * 2; i++) {
			const verdict = await registry.invoke(
				{ tool: ToolNames.Read, args: { path: `probe-${i}.md`, limit: 100 } },
				{ turnId: "t1" },
			);
			strictEqual(verdict.kind, "ok", `distinct-query call ${i} must execute`);
		}
	});

	it("annotates substantial identical results across distinct substantive arguments without blocking", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = createRegistry({ safety, middleware: bundle.contract });
		const repeated = `wiki page listing ${"x".repeat(80)}`;
		registry.register({
			name: ToolNames.CodeNav,
			description: "argument-ignoring test tool",
			parameters: Type.Object({ query: Type.String() }),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: repeated }),
		});

		for (const query of ["quickstart", "architecture"]) {
			const result = await registry.invoke({ tool: ToolNames.CodeNav, args: { query } }, { turnId: "t1" });
			ok(result.kind === "ok" && result.result.kind === "ok");
			if (result.kind === "ok" && result.result.kind === "ok") strictEqual(result.result.output, repeated);
		}
		const warned = await registry.invoke({ tool: ToolNames.CodeNav, args: { query: "fleet" } }, { turnId: "t1" });
		ok(warned.kind === "ok" && warned.result.kind === "ok", "the diagnostic never blocks");
		if (warned.kind === "ok" && warned.result.kind === "ok") {
			ok(warned.result.output.startsWith(repeated));
			ok(warned.result.output.includes("3 distinct code_nav arguments"));
			ok(warned.result.output.includes("may be ignoring an argument"));
		}
		const fourth = await registry.invoke({ tool: ToolNames.CodeNav, args: { query: "engine" } }, { turnId: "t1" });
		ok(fourth.kind === "ok" && fourth.result.kind === "ok");
		if (fourth.kind === "ok" && fourth.result.kind === "ok") strictEqual(fourth.result.output, repeated);
	});

	it("resets the diagnostic streak when a read result changes and ignores non-read results", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = createRegistry({ safety, middleware: bundle.contract });
		const repeated = `stable result ${"x".repeat(80)}`;
		registry.register({
			name: ToolNames.CodeNav,
			description: "changing result test tool",
			parameters: Type.Object({ query: Type.String() }),
			baseActionClass: "read",
			run: async (args) => ({ kind: "ok", output: args.query === "reset" ? `different ${"y".repeat(80)}` : repeated }),
		});
		for (const query of ["one", "two", "reset", "three", "four"]) {
			const result = await registry.invoke({ tool: ToolNames.CodeNav, args: { query } }, { turnId: "reset" });
			ok(result.kind === "ok" && result.result.kind === "ok");
			if (result.kind === "ok" && result.result.kind === "ok") {
				strictEqual(result.result.output.includes("may be ignoring an argument"), false);
			}
		}

		const executeSafety = testSafety({ actionClass: "execute" });
		const executeBundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety: executeSafety })],
		});
		const executeRegistry = createRegistry({ safety: executeSafety, middleware: executeBundle.contract });
		executeRegistry.register({
			name: ToolNames.Bash,
			description: "repeated execute receipt",
			parameters: Type.Object({ command: Type.String() }),
			baseActionClass: "execute",
			run: async () => ({ kind: "ok", output: repeated }),
		});
		for (const command of ["build one", "build two", "build three", "build four"]) {
			const result = await executeRegistry.invoke({ tool: ToolNames.Bash, args: { command } }, { turnId: "execute" });
			ok(result.kind === "ok" && result.result.kind === "ok");
			if (result.kind === "ok" && result.result.kind === "ok") strictEqual(result.result.output, repeated);
		}
	});

	it("does not annotate short generic results or zero-item cap stubs across distinct arguments", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = createRegistry({ safety, middleware: bundle.contract });
		registry.register({
			name: ToolNames.CodeNav,
			description: "generic empty result",
			parameters: Type.Object({ query: Type.String() }),
			baseActionClass: "read",
			run: async () => ({ kind: "ok", output: "No matches found" }),
		});
		for (const query of ["one", "two", "three", "four"]) {
			const result = await registry.invoke({ tool: ToolNames.CodeNav, args: { query } }, { turnId: "short" });
			ok(result.kind === "ok" && result.result.kind === "ok");
			if (result.kind === "ok" && result.result.kind === "ok") strictEqual(result.result.output, "No matches found");
		}

		const capRegistry = createRegistry({ safety: testSafety(), middleware: bundle.contract });
		capRegistry.register({
			name: ToolNames.Context,
			description: "large cap stub",
			parameters: Type.Object({ query: Type.String() }),
			baseActionClass: "read",
			run: async () => ({
				kind: "ok",
				output: `result exceeded cap ${"x".repeat(80)}`,
				details: { observation: { truncated: true, shownCount: 0 } },
			}),
		});
		for (const query of ["one", "two", "three", "four"]) {
			const result = await capRegistry.invoke({ tool: ToolNames.Context, args: { query } }, { turnId: "stub" });
			ok(result.kind === "ok" && result.result.kind === "ok");
			if (result.kind === "ok" && result.result.kind === "ok") {
				strictEqual(result.result.output.includes("may be ignoring an argument"), false);
			}
		}
	});

	it("emits LoopBlocked on the bus per block and interrupts at the per-turn budget", async () => {
		const safety = testSafety();
		const bus = createSafeEventBus();
		const events: LoopBlockedPayload[] = [];
		bus.on(BusChannels.LoopBlocked, (payload) => {
			events.push(payload);
		});
		const bundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety, bus, turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET })],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		const totalCalls = LOOP_THRESHOLD - 1 + INTERACTIVE_LOOP_BLOCK_BUDGET;
		let lastReason = "";
		for (let i = 0; i < totalCalls; i++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			if (verdict.kind === "blocked") lastReason = verdict.reason;
		}
		// One bus event per block; the last block in the turn exhausts the budget
		// and interrupts. Asserted against the constant so the cadence stays
		// correct if the budget is retuned.
		strictEqual(events.length, INTERACTIVE_LOOP_BLOCK_BUDGET, "one bus event per block");
		events.forEach((event, index) => {
			strictEqual(event.tool, ToolNames.Read, `block ${index + 1} names the tool`);
			strictEqual(event.blocksThisTurn, index + 1, `block ${index + 1} counts up`);
			strictEqual(event.turnId, "t1", `block ${index + 1} carries the turn id`);
			strictEqual(
				event.interrupted,
				index + 1 === INTERACTIVE_LOOP_BLOCK_BUDGET,
				`block ${index + 1} interrupts only at the budget`,
			);
		});
		ok(lastReason.includes("stopped"), "final reason states the agent is being stopped");
	});

	it("counts the block budget per turn, not globally", async () => {
		const safety = testSafety();
		const bus = createSafeEventBus();
		const events: LoopBlockedPayload[] = [];
		bus.on(BusChannels.LoopBlocked, (payload) => {
			events.push(payload);
		});
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety, bus })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) await registry.invoke(call, { turnId: "t1" });
		await registry.invoke(call, { turnId: "t1" });
		await registry.invoke(call, { turnId: "t1" });
		// Detection is turn-scoped: a new turn starts a fresh repeat streak, so
		// t2 must reach the threshold itself before its first block lands.
		for (let i = 1; i < LOOP_THRESHOLD; i++) await registry.invoke(call, { turnId: "t2" });
		await registry.invoke(call, { turnId: "t2" });
		strictEqual(events.length, 3);
		strictEqual(events[1]?.blocksThisTurn, 2);
		strictEqual(events[2]?.turnId, "t2");
		strictEqual(events[2]?.blocksThisTurn, 1, "a new turn starts a fresh budget");
		strictEqual(events[2]?.interrupted, false);
	});

	it("leaves a registry without the registration unaffected", async () => {
		const registry = createRegistry({ safety: testSafety() });
		registry.register(mockReadSpec());
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 0; i < LOOP_THRESHOLD * 2; i++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			strictEqual(verdict.kind, "ok", `guard-less registry call ${i} must execute`);
		}
	});

	it("enforces the worker tool-call cap across distinct calls", async () => {
		const safety = testSafety();
		const cap = 4;
		const guard = createLoopGuardRegistration({ safety, toolCallCap: cap });
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < cap; i++) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `file-${i}.md` } });
			strictEqual(verdict.kind, "ok", `call ${i + 1} within cap must execute`);
		}
		const blocked = await registry.invoke({ tool: ToolNames.Read, args: { path: "one-too-many.md" } });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason.includes(`workerToolCallCap reached (${cap})`));
		strictEqual(guard.callCount(), cap + 1);
	});

	it("observes safety-blocked attempts so rejected-call repetition reaches the detector", async () => {
		const safety = testSafety({ blockTool: ToolNames.Read });
		const bus = createSafeEventBus();
		const events: LoopBlockedPayload[] = [];
		bus.on(BusChannels.LoopBlocked, (payload) => {
			events.push(payload);
		});
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety, bus })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 0; i < LOOP_THRESHOLD + 1; i++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			strictEqual(verdict.kind, "blocked", "safety keeps blocking; its verdict stands");
			ok(verdict.kind === "blocked" && verdict.reason.includes("blocked by policy"), "safety reason is preserved");
		}
		ok(events.length >= 1, "the detector saw the repeated rejected attempts and reported the loop");
		strictEqual(events[0]?.tool, ToolNames.Read);
	});

	it("registers on a snapshot-built worker middleware contract via registerHook", async () => {
		const safety = testSafety();
		const middleware = createMiddlewareContractFromSnapshot({ version: 1, rules: [] });
		middleware.registerHook(createLoopGuardRegistration({ safety }));
		const registry = guardedRegistry({ safety, middleware });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual((await registry.invoke(call, { turnId: "t1" })).kind, "ok");
		}
		const blocked = await registry.invoke(call, { turnId: "t1" });
		strictEqual(blocked.kind, "blocked");
		ok(blocked.kind === "blocked" && blocked.reason.includes("loop detected"));
	});

	it("observes parked-then-denied attempts and upgrades the denial reason once the loop trips", async () => {
		const safety = testSafety({ askTool: ToolNames.Write });
		const bus = createSafeEventBus();
		const events: LoopBlockedPayload[] = [];
		bus.on(BusChannels.LoopBlocked, (payload) => {
			events.push(payload);
		});
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety, bus })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		registry.register(mockReadSpec(ToolNames.Write));
		const call = { tool: ToolNames.Write, args: { path: "/outside/denied.txt" } };
		const denialReason = "permission denied: headless runs cannot confirm";
		// Each cycle parks the identical call, then the harness denies it,
		// matching the headless clio-run pattern that previously looped forever.
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			const pending = registry.invoke(call, { turnId: "t1" });
			registry.cancelParkedCalls(denialReason);
			const verdict = await pending;
			strictEqual(verdict.kind, "blocked");
			ok(verdict.kind === "blocked" && verdict.reason === denialReason, `denial ${i} keeps the original reason`);
		}
		const pending = registry.invoke(call, { turnId: "t1" });
		registry.cancelParkedCalls(denialReason);
		const tripped = await pending;
		strictEqual(tripped.kind, "blocked");
		ok(
			tripped.kind === "blocked" && tripped.reason.includes("loop detected"),
			"the detector's reason replaces the generic denial at the threshold",
		);
		strictEqual(events.length, 1, "the loop block is visible on the bus");
		strictEqual(events[0]?.tool, ToolNames.Write);
	});

	it("keeps fingerprints stable across argument key order", () => {
		strictEqual(
			hashToolCall("read", { path: "README.md", limit: 5 }),
			hashToolCall("read", { limit: 5, path: "README.md" }),
		);
		ok(hashToolCall("read", { path: "a" }) !== hashToolCall("read", { path: "b" }));
		strictEqual(createLoopGuardRegistration({ safety: testSafety() }).id, LOOP_GUARD_REGISTRATION_ID);
	});
});

describe("block-reason evidence anchor", () => {
	it("tells the model the looped call already succeeded and where its result is", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		// The two calls below the detector threshold succeed and are recorded via
		// the after_tool touchpoint; the third trips the loop.
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual((await registry.invoke(call, { turnId: "t1" })).kind, "ok");
		}
		const blocked = await registry.invoke(call, { turnId: "t1" });
		ok(
			blocked.kind === "blocked" && blocked.reason.includes("already succeeded 2 times"),
			"names the number of prior successes",
		);
		ok(
			blocked.kind === "blocked" && blocked.reason.includes("already in the conversation above"),
			"points the model at the result it already has",
		);
		ok(blocked.kind === "blocked" && blocked.reason.includes("Change strategy"), "still asks for a strategy change");
	});

	it("does not anchor on cap stubs that showed the model nothing", async () => {
		// A budget-stubbed observation returns kind "ok" but the model saw none of
		// the payload. Telling it "this exact call already succeeded; re-read that
		// result" about an empty stub is exactly the wrong directive.
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = createRegistry({ safety, middleware: bundle.contract });
		registry.register({
			name: ToolNames.Context,
			description: "returns a JSON cap stub",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({
				kind: "ok",
				output: '{"error":"result exceeded 2.9KB"}',
				details: {
					observation: {
						tool: "context",
						unit: "sections",
						shownCount: 0,
						totalCount: 288,
						shownBytes: 33,
						totalBytes: 7000,
						truncated: true,
						format: "json",
					},
				},
			}),
		});
		const call = { tool: ToolNames.Context, args: { scope: "docs", query: "docs overview" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual((await registry.invoke(call, { turnId: "t1" })).kind, "ok");
		}
		const blocked = await registry.invoke(call, { turnId: "t1" });
		ok(blocked.kind === "blocked" && blocked.reason.includes("loop detected"), "still reports the loop");
		ok(
			blocked.kind === "blocked" && !blocked.reason.includes("already succeeded"),
			"a truncated zero-shown stub is not evidence the model can re-read",
		);
	});

	it("omits the success anchor when the looped call never returned a successful result", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = createRegistry({ safety, middleware: bundle.contract });
		registry.register({
			name: ToolNames.Grep,
			description: "always errors",
			parameters: Type.Object({}),
			baseActionClass: "read",
			run: async () => ({ kind: "error", message: "boom" }),
		});
		const call = { tool: ToolNames.Grep, args: {} };
		for (let i = 1; i < LOOP_THRESHOLD; i++) await registry.invoke(call, { turnId: "t1" });
		const blocked = await registry.invoke(call, { turnId: "t1" });
		ok(blocked.kind === "blocked" && blocked.reason.includes("loop detected"), "still reports the loop");
		ok(
			blocked.kind === "blocked" && !blocked.reason.includes("already succeeded"),
			"a call that only ever errored gets no false success anchor",
		);
	});
});

describe("synthesis lockout at the block budget", () => {
	function lockoutRegistry(): {
		registry: ReturnType<typeof createRegistry>;
		events: LoopBlockedPayload[];
	} {
		const safety = testSafety();
		const bus = createSafeEventBus();
		const events: LoopBlockedPayload[] = [];
		bus.on(BusChannels.LoopBlocked, (payload) => {
			events.push(payload);
		});
		const bundle = createMiddlewareBundle({
			registrations: [
				createLoopGuardRegistration({
					safety,
					bus,
					turnBlockBudget: INTERACTIVE_LOOP_BLOCK_BUDGET,
					turnSynthesisLockout: true,
				}),
			],
		});
		return { registry: guardedRegistry({ safety, middleware: bundle.contract }), events };
	}

	async function driveToLockout(
		registry: ReturnType<typeof createRegistry>,
		call: { tool: ToolName; args: Record<string, unknown> },
	): Promise<void> {
		// LOOP_THRESHOLD-1 calls run; the next trips block #1; the one after is
		// block #2, which enters the lockout rather than stopping the turn.
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual((await registry.invoke(call, { turnId: "t1" })).kind, "ok");
		}
		const block1 = await registry.invoke(call, { turnId: "t1" });
		ok(block1.kind === "blocked" && block1.reason.includes("loop detected"), "block #1 names the loop");
		ok(block1.kind === "blocked" && !block1.reason.includes("disabled"), "block #1 is not yet a lockout");
		const block2 = await registry.invoke(call, { turnId: "t1" });
		ok(block2.kind === "blocked" && block2.reason.includes("tool calls are now disabled"), "block #2 locks tools");
		ok(block2.kind === "blocked" && block2.reason.includes("Answer the operator now"), "block #2 tells it to answer");
	}

	it("enters a synthesis lockout at the budget and never emits a stop while the model can still answer", async () => {
		const { registry, events } = lockoutRegistry();
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		await driveToLockout(registry, call);
		// The lockout is the ONLY interrupt-class event so far: a "lockout"
		// disposition with interrupted:false, so no surface cancels the turn.
		strictEqual(events.length, 2, "one block event, one lockout event");
		strictEqual(events[0]?.disposition, "block");
		strictEqual(events[0]?.interrupted, false);
		strictEqual(events[1]?.disposition, "lockout");
		strictEqual(events[1]?.interrupted, false);
		strictEqual(
			events.filter((evt) => evt.disposition === "stop").length,
			0,
			"no stop event fires: a model that stops calling tools now answers and the turn ends naturally",
		);
	});

	it("denies distinct calls while locked so the model must answer, not pivot tools", async () => {
		const { registry } = lockoutRegistry();
		await driveToLockout(registry, { tool: ToolNames.Read, args: { path: "README.md" } });
		// A genuinely different call is still denied: the turn is answering-only now.
		const distinct = await registry.invoke({ tool: ToolNames.Read, args: { path: "OTHER.md" } }, { turnId: "t1" });
		ok(distinct.kind === "blocked" && distinct.reason.includes("tool calls are now disabled"), "distinct call denied");
	});

	it("falls back to a hard stop after the bounded post-lockout backstop", async () => {
		const { registry, events } = lockoutRegistry();
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		await driveToLockout(registry, call);
		// The model ignores the directive and keeps calling tools. Exactly
		// LOOP_SYNTHESIS_BACKSTOP_DENIALS further denials are tolerated; the next
		// call trips the backstop stop.
		let stopReason = "";
		for (let i = 0; i < LOOP_SYNTHESIS_BACKSTOP_DENIALS; i++) {
			const denied = await registry.invoke(call, { turnId: "t1" });
			ok(denied.kind === "blocked" && denied.reason.includes("disabled"), `denial ${i + 1} keeps directing to answer`);
			strictEqual(
				events.filter((evt) => evt.disposition === "stop").length,
				0,
				"still no stop within the backstop window",
			);
		}
		const stopped = await registry.invoke(call, { turnId: "t1" });
		if (stopped.kind === "blocked") stopReason = stopped.reason;
		ok(stopReason.includes("being stopped"), "the backstop stop names the turn stop");
		const stop = events.find((evt) => evt.disposition === "stop");
		ok(stop !== undefined, "a stop event is published");
		strictEqual(stop?.interrupted, true, "the stop event interrupts the turn");
		strictEqual(stop?.tool, ToolNames.Read, "the stop names the looping tool");
		// The stop reuses the block that tripped the lockout (block #2, the
		// LOOP_THRESHOLD+1-th identical call) so the closing message names a real
		// repeat count rather than a placeholder.
		strictEqual(
			stop?.repeatCount,
			LOOP_THRESHOLD + 1,
			"the stop carries the looping repeat count for the closing message",
		);
	});

	it("locks each turn independently: a fresh turn is not born locked", async () => {
		const { registry } = lockoutRegistry();
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		await driveToLockout(registry, call);
		// A different turn starts clean and its below-threshold calls execute.
		strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: "b.md" } }, { turnId: "t2" })).kind, "ok");
	});
});

describe("worker synthesis lockout", () => {
	function workerRegistry(cap: number): ReturnType<typeof createRegistry> {
		// The worker shape: lifetime cap plus lockout, no bus. Measured on a live
		// coder worker before the lockout: one identical code_nav loop consumed
		// the entire cap (46 blocked calls) because per-call blocks never
		// escalated and the bus-only "stop" had no subscriber.
		const safety = testSafety();
		const bundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety, toolCallCap: cap, turnSynthesisLockout: true })],
		});
		return guardedRegistry({ safety, middleware: bundle.contract });
	}

	it("locks a looping worker to synthesis long before the lifetime cap", async () => {
		const cap = 50;
		const registry = workerRegistry(cap);
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual((await registry.invoke(call)).kind, "ok");
		}
		const block1 = await registry.invoke(call);
		ok(block1.kind === "blocked" && block1.reason.includes("loop detected"), "block #1 names the loop");
		const block2 = await registry.invoke(call);
		ok(block2.kind === "blocked" && block2.reason.includes("tool calls are now disabled"), "block #2 locks the run");
	});

	it("reaches the recognizable backstop reason after the bounded denials", async () => {
		const registry = workerRegistry(50);
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) await registry.invoke(call);
		await registry.invoke(call); // block #1
		await registry.invoke(call); // block #2: lockout
		for (let i = 0; i < LOOP_SYNTHESIS_BACKSTOP_DENIALS; i++) {
			const denied = await registry.invoke(call);
			ok(
				denied.kind === "blocked" && !isLoopGuardSynthesisBackstopReason(denied.reason),
				`denial ${i + 1} is not yet the backstop`,
			);
		}
		const stopped = await registry.invoke(call);
		ok(stopped.kind === "blocked", "the backstop denies the call");
		ok(
			stopped.kind === "blocked" && isLoopGuardSynthesisBackstopReason(stopped.reason),
			"the backstop reason is recognizable by the worker abort seam",
		);
	});

	it("fires onSynthesisLockout exactly once when the lockout engages", async () => {
		const safety = testSafety();
		let lockouts = 0;
		const bundle = createMiddlewareBundle({
			registrations: [
				createLoopGuardRegistration({
					safety,
					toolCallCap: 50,
					turnSynthesisLockout: true,
					onSynthesisLockout: () => {
						lockouts += 1;
					},
				}),
			],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) await registry.invoke(call);
		await registry.invoke(call); // block #1
		strictEqual(lockouts, 0, "no lockout before the budget");
		await registry.invoke(call); // block #2: lockout engages
		strictEqual(lockouts, 1, "lockout callback fired at the budget");
		await registry.invoke(call); // post-lockout denial
		strictEqual(lockouts, 1, "denials after the lockout do not re-fire the callback");
	});

	it("locks a cap-exhausted run to synthesis instead of aborting on the spot", async () => {
		const safety = testSafety();
		const cap = 3;
		let lockouts = 0;
		const bundle = createMiddlewareBundle({
			registrations: [
				createLoopGuardRegistration({
					safety,
					toolCallCap: cap,
					turnSynthesisLockout: true,
					onSynthesisLockout: () => {
						lockouts += 1;
					},
				}),
			],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < cap; i++) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `cap-${i}.md` } });
			strictEqual(verdict.kind, "ok", `call ${i + 1} within the cap must execute`);
		}
		strictEqual(lockouts, 0, "no lockout while the cap holds");
		// The crossing call is denied without running its body, enters the
		// lockout exactly once, and gets the synthesize-now directive.
		const crossed = await registry.invoke({ tool: ToolNames.Read, args: { path: "cap-crossing.md" } });
		strictEqual(crossed.kind, "blocked");
		ok(crossed.kind === "blocked" && isWorkerToolCallCapSynthesisReason(crossed.reason), crossed.kind);
		ok(crossed.kind === "blocked" && crossed.reason.includes(`workerToolCallCap reached (${cap})`));
		strictEqual(lockouts, 1, "the lockout engages at the crossing");
		// A second call crossing in the same parallel batch is denied with the
		// same directive and must not re-fire the synthesis transition.
		const parallel = await registry.invoke({ tool: ToolNames.Read, args: { path: "cap-parallel.md" } });
		ok(parallel.kind === "blocked" && isWorkerToolCallCapSynthesisReason(parallel.reason));
		strictEqual(lockouts, 1, "parallel crossings do not fire a second transition");
	});

	it("counts synthesis noncompliance by provider round instead of parallel sibling call", async () => {
		const safety = testSafety();
		const cap = 2;
		const bundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety, toolCallCap: cap, turnSynthesisLockout: true })],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < cap; i++) {
			strictEqual(
				(await registry.invoke({ tool: ToolNames.Read, args: { path: `round-one-${i}.md` } }, { correlationId: "round-1" }))
					.kind,
				"ok",
			);
		}
		const crossing = await registry.invoke(
			{ tool: ToolNames.Read, args: { path: "round-one-crossing.md" } },
			{ correlationId: "round-1" },
		);
		ok(crossing.kind === "blocked" && isWorkerToolCallCapSynthesisReason(crossing.reason));
		for (let sibling = 0; sibling < 12; sibling += 1) {
			const denied = await registry.invoke(
				{ tool: ToolNames.Read, args: { path: `round-one-sibling-${sibling}.md` } },
				{ correlationId: "round-1" },
			);
			ok(
				denied.kind === "blocked" && isWorkerToolCallCapSynthesisReason(denied.reason),
				"one wide batch must not consume the backstop",
			);
		}
		for (const round of [2, 3]) {
			const denied = await registry.invoke(
				{ tool: ToolNames.Read, args: { path: `round-${round}.md` } },
				{ correlationId: `round-${round}` },
			);
			ok(denied.kind === "blocked" && isWorkerToolCallCapSynthesisReason(denied.reason));
		}
		const stopped = await registry.invoke(
			{ tool: ToolNames.Read, args: { path: "round-four.md" } },
			{ correlationId: "round-4" },
		);
		ok(stopped.kind === "blocked" && isLoopGuardSynthesisBackstopReason(stopped.reason));
	});

	it("transitions a soft exploration budget to synthesis without using the hard-cap reason", async () => {
		const safety = testSafety();
		let lockouts = 0;
		const bundle = createMiddlewareBundle({
			registrations: [
				createLoopGuardRegistration({
					safety,
					toolCallCap: 50,
					toolCallSoftLimit: 2,
					turnSynthesisLockout: true,
					onSynthesisLockout: () => {
						lockouts += 1;
					},
				}),
			],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < 2; i += 1) {
			strictEqual(
				(await registry.invoke({ tool: ToolNames.Read, args: { path: `soft-${i}.md` } }, { correlationId: "round-1" }))
					.kind,
				"ok",
			);
		}
		const crossing = await registry.invoke(
			{ tool: ToolNames.Read, args: { path: "soft-crossing.md" } },
			{ correlationId: "round-1" },
		);
		ok(crossing.kind === "blocked" && crossing.reason.startsWith("worker exploration budget reached (2)"));
		strictEqual(lockouts, 1);
		strictEqual(crossing.kind === "blocked" && mentionsWorkerToolCallCap(crossing.reason), false);
		for (let sibling = 0; sibling < 10; sibling += 1) {
			const denied = await registry.invoke(
				{ tool: ToolNames.Read, args: { path: `soft-sibling-${sibling}.md` } },
				{ correlationId: "round-1" },
			);
			ok(denied.kind === "blocked" && denied.reason.startsWith("worker exploration budget reached (2)"));
		}
		strictEqual(lockouts, 1);
	});

	it("caps a noncompliant model with the bounded backstop after the cap lockout", async () => {
		const safety = testSafety();
		const cap = 2;
		const bundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety, toolCallCap: cap, turnSynthesisLockout: true })],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < cap; i++) {
			strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: `pre-${i}.md` } })).kind, "ok");
		}
		const lockout = await registry.invoke({ tool: ToolNames.Read, args: { path: "over.md" } });
		ok(lockout.kind === "blocked" && isWorkerToolCallCapSynthesisReason(lockout.reason));
		for (let i = 0; i < LOOP_SYNTHESIS_BACKSTOP_DENIALS; i++) {
			const denied = await registry.invoke({ tool: ToolNames.Read, args: { path: `post-${i}.md` } });
			ok(
				denied.kind === "blocked" && isWorkerToolCallCapSynthesisReason(denied.reason),
				`denial ${i + 1} keeps directing the model to answer`,
			);
		}
		const stopped = await registry.invoke({ tool: ToolNames.Read, args: { path: "still-calling.md" } });
		ok(stopped.kind === "blocked", "the backstop denies the call");
		ok(
			stopped.kind === "blocked" && isLoopGuardSynthesisBackstopReason(stopped.reason),
			"the backstop reason is recognizable by the worker abort seam",
		);
	});

	it("keeps the immediate cap abort when no synthesis lockout is wired", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety, toolCallCap: 1 })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md" } })).kind, "ok");
		const blocked = await registry.invoke({ tool: ToolNames.Read, args: { path: "b.md" } });
		ok(blocked.kind === "blocked" && isWorkerToolCallCapExceededReason(blocked.reason));
	});

	it("keeps the cap predicates mutually exclusive", () => {
		strictEqual(isWorkerToolCallCapSynthesisReason(workerToolCallCapSynthesisReason(50)), true);
		strictEqual(isWorkerToolCallCapExceededReason(workerToolCallCapSynthesisReason(50)), false);
		strictEqual(isWorkerToolCallCapSynthesisReason("workerToolCallCap reached (50); abort run"), false);
		strictEqual(isLoopGuardSynthesisBackstopReason(workerToolCallCapSynthesisReason(50)), false);
	});

	it("keeps the backstop predicate specific to the backstop reason", () => {
		strictEqual(
			isLoopGuardSynthesisBackstopReason(
				"loop guard: tool calls stayed disabled and code_nav was called again instead of answering, so the turn is being stopped. Summarize what you found for the operator.",
			),
			true,
		);
		strictEqual(isLoopGuardSynthesisBackstopReason("workerToolCallCap reached (50); abort run"), false);
		strictEqual(
			isLoopGuardSynthesisBackstopReason(
				"loop guard: this turn reached its tool-call limit after repeated identical calls, so tool calls are now disabled for the rest of this turn.",
			),
			false,
		);
	});
});

describe("synthesis reserve at the cap tail", () => {
	/**
	 * Safety stub that classifies "unknown" so each registered spec's
	 * baseActionClass drives metadata.actionClass: the reserve distinguishes
	 * reads from non-reads exactly the way production admission labels them.
	 */
	function unknownClassSafety(): SafetyContract {
		let loopState = createLoopState();
		return {
			classify: () => ({ actionClass: "unknown", reasons: [] }),
			evaluate: () => ({ kind: "allow", classification: { actionClass: "unknown", reasons: [] } }),
			observeLoop(key, now) {
				const [next, verdict] = observe(loopState, key, now ?? Date.now());
				loopState = next;
				return verdict;
			},
			scopes: { readonly: READONLY_SCOPE, workspace: WORKSPACE_SCOPE, confirmed: CONFIRMED_SCOPE },
			isSubset: () => true,
			audit: { recordCount: () => 0 },
		};
	}

	function mockWriteSpec(): ToolSpec {
		return {
			name: ToolNames.Write,
			description: "test write tool",
			parameters: Type.Object({}),
			baseActionClass: "write",
			run: async () => ({ kind: "ok", output: "written" }),
		};
	}

	function reserveRegistry(cap: number, reserve: number) {
		const safety = unknownClassSafety();
		const guard = createLoopGuardRegistration({
			safety,
			toolCallCap: cap,
			toolCallReserve: reserve,
			turnSynthesisLockout: true,
		});
		const bundle = createMiddlewareBundle({ registrations: [guard] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		registry.register(mockWriteSpec());
		return registry;
	}

	it("annotates exactly one result with the reserve directive when entering the window", async () => {
		const registry = reserveRegistry(8, 3);
		for (let i = 0; i < 5; i++) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `pre-${i}.md` } });
			ok(
				verdict.kind === "ok" && verdict.result.kind === "ok" && !verdict.result.output.includes("budget reserve"),
				`call ${i + 1} carries no directive`,
			);
		}
		const entering = await registry.invoke({ tool: ToolNames.Read, args: { path: "entering.md" } });
		ok(entering.kind === "ok", "the read that enters the window still executes");
		ok(
			entering.kind === "ok" &&
				entering.result.kind === "ok" &&
				entering.result.output.includes("budget reserve: only 2 of your 8 tool calls remain"),
			"the first in-window result carries the one-shot directive",
		);
		const next = await registry.invoke({ tool: ToolNames.Read, args: { path: "next.md" } });
		ok(
			next.kind === "ok" && next.result.kind === "ok" && !next.result.output.includes("budget reserve"),
			"the directive is one-shot",
		);
	});

	it("blocks non-read calls in the window with a steering reason that never carries the cap prefix", async () => {
		const registry = reserveRegistry(6, 3);
		for (let i = 0; i < 3; i++) {
			strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: `pre-${i}.md` } })).kind, "ok");
		}
		const blockedWrite = await registry.invoke({ tool: ToolNames.Write, args: { path: "late-edit.md" } });
		strictEqual(blockedWrite.kind, "blocked");
		if (blockedWrite.kind === "blocked") {
			ok(isWorkerSynthesisReserveBlockReason(blockedWrite.reason), blockedWrite.reason);
			ok(blockedWrite.reason.includes("reserved for verification reads and synthesis"));
			// Reserve steering must never read as cap exhaustion: A2's notice,
			// the worker abort seam, and receipt telemetry key on that prefix.
			strictEqual(mentionsWorkerToolCallCap(blockedWrite.reason), false);
			strictEqual(isWorkerToolCallCapSynthesisReason(blockedWrite.reason), false);
			strictEqual(isWorkerToolCallCapExceededReason(blockedWrite.reason), false);
		}
		// Verification reads keep flowing inside the window.
		const read = await registry.invoke({ tool: ToolNames.Read, args: { path: "verify-citation.md" } });
		strictEqual(read.kind, "ok");
	});

	it("keeps the hard cap and bounded backstop intact through the reserve window", async () => {
		const cap = 5;
		const registry = reserveRegistry(cap, 2);
		for (let i = 0; i < cap; i++) {
			strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: `r-${i}.md` } })).kind, "ok");
		}
		const capCrossing = await registry.invoke({ tool: ToolNames.Read, args: { path: "over.md" } });
		ok(
			capCrossing.kind === "blocked" && isWorkerToolCallCapSynthesisReason(capCrossing.reason),
			"crossing the cap still enters the unchanged cap lockout",
		);
		for (let i = 0; i < LOOP_SYNTHESIS_BACKSTOP_DENIALS; i++) {
			const denied = await registry.invoke({ tool: ToolNames.Read, args: { path: `post-${i}.md` } });
			ok(denied.kind === "blocked" && isWorkerToolCallCapSynthesisReason(denied.reason));
		}
		const stopped = await registry.invoke({ tool: ToolNames.Read, args: { path: "still-calling.md" } });
		ok(stopped.kind === "blocked" && isLoopGuardSynthesisBackstopReason(stopped.reason), "the backstop still lands");
	});

	it("still trips the identical-call detector on reads inside the window", async () => {
		const registry = reserveRegistry(20, 15);
		// Enter the window immediately (threshold 5), then loop one read.
		for (let i = 0; i < 5; i++) {
			strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: `warm-${i}.md` } })).kind, "ok");
		}
		const call = { tool: ToolNames.Read, args: { path: "same.md" } };
		let loopBlocked = false;
		for (let i = 0; i < LOOP_THRESHOLD + 1; i++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			if (verdict.kind === "blocked" && verdict.reason.includes("loop detected")) {
				loopBlocked = true;
				break;
			}
		}
		ok(loopBlocked, "reserve reads still reach the repetition detector");
	});

	it("does not activate when the cap is not larger than the reserve", async () => {
		const registry = reserveRegistry(3, 5);
		// A write executes normally: no reserve window exists on a tiny cap.
		strictEqual((await registry.invoke({ tool: ToolNames.Read, args: { path: "a.md" } })).kind, "ok");
		strictEqual((await registry.invoke({ tool: ToolNames.Write, args: { path: "b.md" } })).kind, "ok");
		const third = await registry.invoke({ tool: ToolNames.Read, args: { path: "c.md" } });
		ok(third.kind === "ok" && third.result.kind === "ok" && !third.result.output.includes("budget reserve"));
	});

	it("keeps the reserve predicate mutually exclusive with the cap vocabulary", () => {
		const reason = workerSynthesisReserveBlockReason("bash", 3, 50);
		strictEqual(isWorkerSynthesisReserveBlockReason(reason), true);
		strictEqual(mentionsWorkerToolCallCap(reason), false);
		strictEqual(isWorkerSynthesisReserveBlockReason(workerToolCallCapSynthesisReason(50)), false);
		ok(workerSynthesisReserveDirective(5, 50).startsWith("budget reserve: only 5 of your 50 tool calls remain"));
	});
});

describe("orchestrator per-turn tool-call budget", () => {
	function budgetedRegistry(input: { soft: number; hard: number }): {
		registry: ReturnType<typeof createRegistry>;
		events: ToolBudgetExceededPayload[];
	} {
		const safety = testSafety();
		const bus = createSafeEventBus();
		const events: ToolBudgetExceededPayload[] = [];
		bus.on(BusChannels.ToolBudgetExceeded, (payload) => {
			events.push(payload);
		});
		const bundle = createMiddlewareBundle({
			registrations: [
				createLoopGuardRegistration({ safety, bus, turnToolCallBudget: { soft: input.soft, hard: input.hard } }),
			],
		});
		return { registry: guardedRegistry({ safety, middleware: bundle.contract }), events };
	}

	it("nudges with a re-plan directive once it crosses the soft budget on DISTINCT calls", async () => {
		const { registry, events } = budgetedRegistry({ soft: 3, hard: 5 });
		// All-distinct arguments: the identical-call detector never fires here, so
		// this is exactly the gap-1 spray the volume budget exists to catch.
		for (let i = 1; i < 3; i++) {
			const ok = await registry.invoke({ tool: ToolNames.Read, args: { path: `file-${i}.md` } }, { turnId: "t1" });
			strictEqual(ok.kind, "ok", `distinct call ${i} below the soft budget must execute`);
		}
		const nudged = await registry.invoke({ tool: ToolNames.Read, args: { path: "file-3.md" } }, { turnId: "t1" });
		strictEqual(nudged.kind, "blocked", "the soft-budget call is blocked with a re-plan directive");
		ok(nudged.kind === "blocked" && nudged.reason.includes("tool-call budget"), "reason names the budget");
		ok(nudged.kind === "blocked" && nudged.reason.includes("Summarize"), "reason tells the model to summarize and wait");
		ok(
			nudged.kind === "blocked" && nudged.reason.includes("Every further tool call this turn will be blocked"),
			"the directive is honest that no further call this turn can run",
		);
		strictEqual(events.length, 1, "exactly one warn event at the first soft crossing");
		strictEqual(events[0]?.interrupted, false);
		strictEqual(events[0]?.callsThisTurn, 3);
		strictEqual(events[0]?.softBudget, 3);
		strictEqual(events[0]?.turnId, "t1");
	});

	it("feeds budget-blocked retries to the identical-call detector so the retry spiral interrupts early", async () => {
		// Regression for the v0.2.8 demo failure: a weak model that retries its
		// budget-blocked call verbatim must be stopped by the identical-call
		// detector within a few repeats, not spin all the way to the hard
		// ceiling. The budget check used to run first and starve the detector.
		const safety = testSafety();
		const bus = createSafeEventBus();
		const loopEvents: LoopBlockedPayload[] = [];
		bus.on(BusChannels.LoopBlocked, (payload) => {
			loopEvents.push(payload);
		});
		const bundle = createMiddlewareBundle({
			registrations: [createLoopGuardRegistration({ safety, bus, turnToolCallBudget: { soft: 3, hard: 40 } })],
		});
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 1; i <= 2; i++) {
			const okVerdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `f-${i}.md` } }, { turnId: "t1" });
			strictEqual(okVerdict.kind, "ok");
		}
		const call = { tool: ToolNames.Read, args: { path: "f-3.md" } };
		const crossed = await registry.invoke(call, { turnId: "t1" });
		strictEqual(crossed.kind, "blocked");
		ok(crossed.kind === "blocked" && crossed.reason.includes("tool-call budget"), "the crossing gets the budget reason");
		// Verbatim retries: the first is repeat two (below the detector
		// threshold, budget reason again); the next ones trip the detector and
		// exhaust its per-turn block budget, which interrupts the turn.
		const retryReasons: string[] = [];
		for (let retry = 1; retry <= 1 + INTERACTIVE_LOOP_BLOCK_BUDGET; retry++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			strictEqual(verdict.kind, "blocked");
			if (verdict.kind === "blocked") retryReasons.push(verdict.reason);
		}
		ok(retryReasons[0]?.includes("tool-call budget"), "repeat two still carries the budget reason");
		ok(retryReasons[1]?.includes("loop detected"), "the detector reason takes over at its threshold");
		strictEqual(loopEvents.length, INTERACTIVE_LOOP_BLOCK_BUDGET, "one LoopBlocked event per detector block");
		strictEqual(
			loopEvents[INTERACTIVE_LOOP_BLOCK_BUDGET - 1]?.interrupted,
			true,
			"the spiral interrupts at the detector's block budget, far below the hard ceiling",
		);
		ok(retryReasons[retryReasons.length - 1]?.includes("stopped"), "the final block states the agent is being stopped");
	});

	it("interrupts the turn at the hard ceiling like the block budget does", async () => {
		const { registry, events } = budgetedRegistry({ soft: 3, hard: 5 });
		let lastReason = "";
		for (let i = 1; i <= 5; i++) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `file-${i}.md` } }, { turnId: "t1" });
			if (verdict.kind === "blocked") lastReason = verdict.reason;
		}
		const interrupt = events.find((evt) => evt.interrupted);
		ok(interrupt !== undefined, "a hard-ceiling interrupt event is published");
		strictEqual(interrupt?.callsThisTurn, 5);
		strictEqual(interrupt?.hardCeiling, 5);
		ok(lastReason.includes("hard ceiling"), "the final block reason names the hard ceiling");
		ok(lastReason.includes("stopped"), "the final block reason states the turn is being stopped");
	});

	it("counts the budget per turn, not globally", async () => {
		const { registry, events } = budgetedRegistry({ soft: 3, hard: 5 });
		for (let i = 1; i <= 3; i++) {
			await registry.invoke({ tool: ToolNames.Read, args: { path: `a-${i}.md` } }, { turnId: "t1" });
		}
		strictEqual(events.length, 1, "t1 crossed the soft budget once");
		// A fresh turn restarts the per-turn counter, so the first two calls run.
		const first = await registry.invoke({ tool: ToolNames.Read, args: { path: "b-1.md" } }, { turnId: "t2" });
		strictEqual(first.kind, "ok", "a new turn starts a fresh budget");
		const second = await registry.invoke({ tool: ToolNames.Read, args: { path: "b-2.md" } }, { turnId: "t2" });
		strictEqual(second.kind, "ok");
		strictEqual(events.length, 1, "no new event until t2 also crosses the soft budget");
	});

	it("leaves a worker registration (no turn budget) unaffected by the orchestrator budget", async () => {
		const safety = testSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		for (let i = 0; i < DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET + ORCH_TURN_TOOL_CALL_HARD_MARGIN + 5; i++) {
			const verdict = await registry.invoke({ tool: ToolNames.Read, args: { path: `w-${i}.md` } }, { turnId: "t1" });
			strictEqual(verdict.kind, "ok", `distinct worker call ${i} must execute without a per-turn budget`);
		}
	});

	it("derives the budget from guardrail layers with a hard margin above the soft value", () => {
		strictEqual(readOrchTurnToolCallBudget({}).soft, DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET);
		strictEqual(
			readOrchTurnToolCallBudget({}).hard,
			DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET + ORCH_TURN_TOOL_CALL_HARD_MARGIN,
		);
		const override = readOrchTurnToolCallBudget({ CLIO_TURN_TOOL_CALL_BUDGET: "8" });
		strictEqual(override.soft, 8);
		strictEqual(override.hard, 8 + ORCH_TURN_TOOL_CALL_HARD_MARGIN);
		// Invalid values fall back to the default rather than throwing.
		strictEqual(
			readOrchTurnToolCallBudget({ CLIO_TURN_TOOL_CALL_BUDGET: "nope" }).soft,
			DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET,
		);
	});

	it("resolves guardrails settings-first with env as the emergency override", () => {
		// env > settings.yaml guardrails > built-in default, for every key.
		try {
			strictEqual(resolveGuardrail("turnToolCallBudget", {}), GUARDRAIL_DEFAULTS.turnToolCallBudget);
			configureGuardrails({ turnToolCallBudget: 30, workerToolCallCap: 20 });
			strictEqual(resolveGuardrail("turnToolCallBudget", {}), 30, "settings beat the built-in default");
			strictEqual(readOrchTurnToolCallBudget({}).soft, 30, "the loop guard reads the settings layer");
			strictEqual(readWorkerToolCallCap({}), 20);
			strictEqual(resolveGuardrail("turnToolCallBudget", { CLIO_TURN_TOOL_CALL_BUDGET: "7" }), 7, "env beats settings");
			strictEqual(
				resolveGuardrail("readMaxBytes", {}),
				GUARDRAIL_DEFAULTS.readMaxBytes,
				"unconfigured keys keep their defaults",
			);
		} finally {
			configureGuardrails(undefined);
		}
	});
});

describe("guard block receipt accounting", () => {
	/** Allow decisions carry the policy engine's net-pass fields, as in a real run. */
	function policyCarryingSafety(): SafetyContract {
		const base = testSafety();
		return {
			...base,
			evaluate: (call, posture) => {
				const decision = base.evaluate(call, posture);
				if (decision.kind !== "allow") return decision;
				const policy: SafetyPolicyDecision = {
					kind: "allow",
					classification: decision.classification,
					tool: call.tool,
					actionClass: "read",
					reasons: [],
					reasonCode: "allowed",
					cwd: ".",
					policySource: "none",
				};
				return { ...decision, policy };
			},
		};
	}

	it("re-shapes a loop-guard block into a blocked safety decision", async () => {
		const safety = policyCarryingSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual((await registry.invoke(call, { turnId: "t1" })).kind, "ok", `call ${i} below threshold executes`);
		}
		const blocked = await registry.invoke(call, { turnId: "t1" });
		strictEqual(blocked.kind, "blocked");
		if (blocked.kind !== "blocked") return;
		// The admission allow must not leak into the verdict: receipts count
		// safety.decisions from this decision, so a guard block that keeps the
		// allow shows a blocked tool attempt with zero blocked decisions.
		strictEqual(blocked.decision.kind, "block", "guard block re-shapes the decision as a block");
		ok(blocked.decision.kind === "block" && blocked.decision.rejection.detail.includes("loop detected"));
		strictEqual(blocked.decision.policy?.reasonCode, "guard_block", "final reason code names the guard axis");
	});

	it("worker finish events report a guard block as a blocked decision", async () => {
		const safety = policyCarryingSafety();
		const bundle = createMiddlewareBundle({ registrations: [createLoopGuardRegistration({ safety })] });
		const registry = guardedRegistry({ safety, middleware: bundle.contract });
		const finishes: ToolFinishEvent[] = [];
		const telemetry = { onFinish: (event: ToolFinishEvent) => void finishes.push(event) };
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			await invokeRegisteredTool(registry, ToolNames.Read, {}, { telemetry });
		}
		await rejects(invokeRegisteredTool(registry, ToolNames.Read, {}, { telemetry }), /loop detected/);
		strictEqual(finishes.length, LOOP_THRESHOLD);
		strictEqual(finishes[0]?.decision, "allowed", "executed calls keep their allow decision");
		const last = finishes.at(-1);
		strictEqual(last?.outcome, "blocked");
		strictEqual(last?.decision, "blocked", "receipts must count the guard block as a blocked decision");
		strictEqual(last?.reasonCode, "guard_block");
		strictEqual(last?.actionClass, "read");
	});
});

describe("locked-turn tool-call markup sanitizer", () => {
	function assistantMessage(text: string, overrides: Record<string, unknown> = {}): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason: "stop",
			timestamp: Date.now(),
			...overrides,
		} as unknown as AgentMessage;
	}

	function textOf(message: AgentMessage): string {
		const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
		return content
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("");
	}

	// Evidence shape 1 (battletest cycle7-absence r2): the locked round's whole
	// reply is one dead <tool_call> block. Nothing remains, so the fallback
	// stop message replaces it.
	it("replaces a markup-only reply with the fallback stop message", () => {
		const markup =
			"<tool_call>\n<function=grep>\n<parameter=pattern>\nhttp|network\n</parameter>\n<parameter=mode>\nfiles\n</parameter>\n</function>\n</tool_call>";
		const message = assistantMessage(markup);
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(textOf(message), lockedSynthesisFallbackText());
	});

	// Evidence shape 2 (battletest converge2-t03 honest-absence r1): prose
	// lead-in followed by a dead block. The prose survives; the markup goes.
	it("keeps surrounding prose when stripping a dead block", () => {
		const message = assistantMessage(
			"Let me try different search terms related to network request handling:\n\n<tool_call>\n<function=grep>\n<parameter=pattern>\nhttp_error\n</parameter>\n</function>\n</tool_call>",
		);
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(textOf(message), "Let me try different search terms related to network request handling:");
	});

	it("strips an unterminated trailing block cut off by a length stop", () => {
		const message = assistantMessage(
			"Based on what I found:\n<tool_call>\n<function=read>\n<parameter=path>\nsrc/index.ts",
			{ stopReason: "length" },
		);
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(textOf(message), "Based on what I found:");
	});

	it("strips bare function-call markup without the tool_call wrapper", () => {
		const message = assistantMessage("<function=grep>\n<parameter=pattern>\nfoo\n</parameter>\n</function>");
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(textOf(message), lockedSynthesisFallbackText());
	});

	it("strips a JSON-style tool_call body", () => {
		const message = assistantMessage('Answer below.\n<tool_call>\n{"name": "grep", "arguments": {"pattern": "x"}}');
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(textOf(message), "Answer below.");
	});

	it("leaves plain prose untouched, including a quoted <tool_call> mention", () => {
		const prose =
			"I could not finish because tool calls are disabled; writing <tool_call> blocks would not run. The repo has no network layer.";
		const message = assistantMessage(prose);
		strictEqual(sanitizeLockedSynthesisMessage(message), false);
		strictEqual(textOf(message), prose);
	});

	it("never touches messages that carry structured tool calls", () => {
		const message = assistantMessage("<tool_call>dead</tool_call>", {
			content: [
				{ type: "text", text: "<tool_call><function=grep></function></tool_call>" },
				{ type: "toolCall", id: "c1", name: "grep", arguments: {} },
			],
			stopReason: "toolUse",
		});
		strictEqual(sanitizeLockedSynthesisMessage(message), false);
	});

	it("never touches aborted or error messages", () => {
		const aborted = assistantMessage("<tool_call><function=grep></function></tool_call>", { stopReason: "aborted" });
		const errored = assistantMessage("<tool_call><function=grep></function></tool_call>", { stopReason: "error" });
		strictEqual(sanitizeLockedSynthesisMessage(aborted), false);
		strictEqual(sanitizeLockedSynthesisMessage(errored), false);
	});

	it("never touches non-assistant messages", () => {
		const user = {
			role: "user",
			content: [{ type: "text", text: "<tool_call>user pasted markup</tool_call>" }],
		} as unknown as AgentMessage;
		strictEqual(sanitizeLockedSynthesisMessage(user), false);
		strictEqual(sanitizeLockedSynthesisMessage(undefined), false);
	});

	it("keeps prose from a second text block when the first is only markup", () => {
		const message = assistantMessage("", {
			content: [
				{ type: "text", text: "<tool_call>\n<function=grep>\n</function>\n</tool_call>" },
				{ type: "text", text: "The feature does not exist in this repository." },
			],
		});
		strictEqual(sanitizeLockedSynthesisMessage(message), true);
		strictEqual(textOf(message), "The feature does not exist in this repository.");
	});
});
