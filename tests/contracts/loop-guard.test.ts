import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels, type LoopBlockedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { MiddlewareContract } from "../../src/domains/middleware/index.js";
import { createMiddlewareContractFromSnapshot } from "../../src/domains/middleware/snapshot.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createLoopState, hashToolCall, observe } from "../../src/domains/safety/loop-detector.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import {
	createLoopGuardRegistration,
	INTERACTIVE_LOOP_BLOCK_BUDGET,
	LOOP_GUARD_REGISTRATION_ID,
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
		strictEqual(events.length, INTERACTIVE_LOOP_BLOCK_BUDGET, "one bus event per block");
		strictEqual(events[0]?.tool, ToolNames.Read);
		strictEqual(events[0]?.blocksThisTurn, 1);
		strictEqual(events[0]?.interrupted, false);
		strictEqual(events[1]?.blocksThisTurn, 2);
		strictEqual(events[1]?.interrupted, false);
		strictEqual(events[2]?.blocksThisTurn, 3);
		strictEqual(events[2]?.interrupted, true, "third block in a turn exhausts the budget");
		strictEqual(events[2]?.turnId, "t1");
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
