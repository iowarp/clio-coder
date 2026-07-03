import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels, type LoopBlockedPayload, type ToolBudgetExceededPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { configureGuardrails, GUARDRAIL_DEFAULTS, resolveGuardrail } from "../../src/core/guardrails.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareContract } from "../../src/domains/middleware/index.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	createLoopGuardRegistration,
	DEFAULT_ORCH_TURN_TOOL_CALL_BUDGET,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	LOOP_GUARD_REGISTRATION_ID,
	LOOP_SYNTHESIS_BACKSTOP_DENIALS,
	ORCH_TURN_TOOL_CALL_HARD_MARGIN,
	readOrchTurnToolCallBudget,
	readWorkerToolCallCap,
} from "../../src/engine/loop-guard.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

const LOOP_THRESHOLD = createLoopState().maxRepeats;

/** Safety stub backed by the real sliding-window loop detector. */
function testSafety(options: { blockTool?: string; askTool?: string } = {}): SafetyContract {
	let loopState = createLoopState();
	return {
		classify: () => ({ actionClass: "read", reasons: [] }),
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
			return { kind: "allow", classification: { actionClass: "read", reasons: [] } };
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
		ok(blocked.kind === "blocked" && blocked.reason.includes(`tool-call cap reached (${cap})`));
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
