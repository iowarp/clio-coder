import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { BusChannels, type LoopBlockedPayload } from "../../src/core/bus-events.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createLoopState, observe } from "../../src/domains/safety/loop-detector.js";
import { CONFIRMED_SCOPE, READONLY_SCOPE, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { createInteractiveLoopGuard, INTERACTIVE_LOOP_BLOCK_BUDGET } from "../../src/engine/interactive-loop-guard.js";
import { createWorkerLoopGuard, createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createRegistry, type ToolSpec } from "../../src/tools/registry.js";

const LOOP_THRESHOLD = createLoopState().maxRepeats;

/** Safety stub backed by the real sliding-window loop detector. */
function testSafety(): SafetyContract {
	let loopState = createLoopState();
	return {
		classify: () => ({ actionClass: "read", reasons: [] }),
		evaluate: () => ({ kind: "allow", classification: { actionClass: "read", reasons: [] } }),
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

describe("interactive loop guard", () => {
	it("blocks the identical call at the detector threshold and recovers with house-style feedback", async () => {
		const safety = testSafety();
		const registry = createRegistry({ safety, loopGuard: createInteractiveLoopGuard({ safety }) });
		registry.register(mockReadSpec());
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
		const registry = createRegistry({ safety, loopGuard: createInteractiveLoopGuard({ safety }) });
		registry.register(mockReadSpec());
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
			events.push(payload as LoopBlockedPayload);
		});
		const registry = createRegistry({ safety, loopGuard: createInteractiveLoopGuard({ safety, bus }) });
		registry.register(mockReadSpec());
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
			events.push(payload as LoopBlockedPayload);
		});
		const registry = createRegistry({ safety, loopGuard: createInteractiveLoopGuard({ safety, bus }) });
		registry.register(mockReadSpec());
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

	it("leaves a guard-less registry unaffected, matching the worker wiring", async () => {
		// Worker registries (createWorkerToolRegistry) never set RegistryDeps.loopGuard;
		// their guard runs in worker-runtime.ts via pi-agent-core's beforeToolCall on
		// worker-local state. A registry without the dep must execute verbatim repeats
		// even when the safety contract's detector would flag them.
		const registry = createRegistry({ safety: testSafety() });
		registry.register(mockReadSpec());
		const call = { tool: ToolNames.Read, args: { path: "README.md" } };
		for (let i = 0; i < LOOP_THRESHOLD * 2; i++) {
			const verdict = await registry.invoke(call, { turnId: "t1" });
			strictEqual(verdict.kind, "ok", `guard-less registry call ${i} must execute`);
		}
	});

	it("keeps worker guard state isolated from the interactive guard", () => {
		const workerSafety = createWorkerSafety();
		const workerGuard = createWorkerLoopGuard({ safety: workerSafety });
		const interactiveGuard = createInteractiveLoopGuard({ safety: testSafety() });
		// Saturate the interactive guard with one fingerprint.
		for (let i = 0; i < LOOP_THRESHOLD; i++) interactiveGuard.check("read", { path: "README.md" });
		// The worker guard, observing the same fingerprint on its own state,
		// still allows the first calls below its threshold.
		for (let i = 1; i < LOOP_THRESHOLD; i++) {
			strictEqual(workerGuard.check("read", { path: "README.md" }).block, false, `worker call ${i} unaffected`);
		}
		strictEqual(
			workerGuard.check("read", { path: "README.md" }).block,
			true,
			"worker guard still enforces its own threshold",
		);
	});
});
