/**
 * w2-07 contracts: orphaned bus events now reach the operator, domain
 * subscriptions are released on stop(), and run.aborted provenance survives
 * into the status summary.
 */

import { match, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BusChannels, isRunAbortedPayload } from "../../src/core/bus-events.js";
import type { DomainContext, DomainContract } from "../../src/core/domain-loader.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { ContextDomainModule } from "../../src/domains/context/index.js";
import { createPromptsBundle } from "../../src/domains/prompts/extension.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { budgetAlertNotice, restartRequiredNotice, safetyBlockedNotice } from "../../src/interactive/bus-notices.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createContextActivityStore } from "../../src/interactive/context-activity.js";
import { createStatusController } from "../../src/interactive/status/controller.js";

function domainContext(): DomainContext {
	const bus = createSafeEventBus();
	const contracts = new Map<string, DomainContract>();
	return {
		bus,
		getContract<T extends DomainContract>(name: string): T | undefined {
			return contracts.get(name) as T | undefined;
		},
	};
}

describe("budget alert notice", () => {
	it("renders a warn notice at the ceiling and an error notice over it", () => {
		const at = budgetAlertNotice({ level: "at", currentUsd: 5, ceilingUsd: 5 });
		ok(at);
		strictEqual(at.level, "warn");
		match(at.text, /\$5\.00 of \$5\.00/);
		// Dispatch admission really denies at the ceiling; the notice must say
		// so instead of claiming dispatches are not blocked.
		match(at.text, /denied at admission/);

		const over = budgetAlertNotice({ level: "over", currentUsd: 6.5, ceilingUsd: 5 });
		ok(over);
		strictEqual(over.level, "error");
		match(over.text, /\$6\.50 of \$5\.00/);
		match(over.text, /sessionCeilingUsd/);
		match(over.text, /denied at admission/);
	});

	it("ignores malformed payloads", () => {
		strictEqual(budgetAlertNotice(null), null);
		strictEqual(budgetAlertNotice("over"), null);
		strictEqual(budgetAlertNotice({ level: "under", currentUsd: 1, ceilingUsd: 5 }), null);
		strictEqual(budgetAlertNotice({ level: "over", currentUsd: "6", ceilingUsd: 5 }), null);
		strictEqual(budgetAlertNotice({ level: "over", currentUsd: Number.NaN, ceilingUsd: 5 }), null);
		strictEqual(budgetAlertNotice({ level: "over", currentUsd: 6 }), null);
	});
});

describe("restart-required notice", () => {
	it("names the changed settings and asks for a restart", () => {
		const text = restartRequiredNotice({ diff: { restartRequired: ["budget.concurrency"] } });
		ok(text);
		match(text, /setting budget\.concurrency changed/);
		match(text, /restart/i);

		const multi = restartRequiredNotice({ diff: { restartRequired: ["budget.concurrency", "engine.runtime"] } });
		ok(multi);
		match(multi, /settings budget\.concurrency, engine\.runtime changed/);
	});

	it("ignores malformed or empty payloads", () => {
		strictEqual(restartRequiredNotice(null), null);
		strictEqual(restartRequiredNotice({}), null);
		strictEqual(restartRequiredNotice({ diff: { restartRequired: [] } }), null);
		strictEqual(restartRequiredNotice({ diff: { restartRequired: "budget.concurrency" } }), null);
		strictEqual(restartRequiredNotice({ diff: { restartRequired: [42, ""] } }), null);
	});
});

describe("safety blocked notice", () => {
	it("names tool, action class, rule, and policy source", () => {
		const notice = safetyBlockedNotice({
			tool: "bash",
			actionClass: "git_destructive",
			ruleId: "dc-001",
			policySource: "damage-control:base",
			reasonCode: "damage-control:dc-001",
		});
		ok(notice);
		strictEqual(notice.level, "warn");
		match(notice.text, /^\[safety-net\] blocked bash \(git_destructive\)/);
		match(notice.text, /rule dc-001 \(damage-control:dc-001\)/);
		match(notice.text, /via damage-control:base/);
		match(notice.text, /applies at every autonomy level/);
	});

	it("falls back to the reason code when no rule id is present", () => {
		const notice = safetyBlockedNotice({
			tool: "write",
			actionClass: "system_modify",
			policySource: "project-policy",
			reasonCode: "classification:system_modify",
		});
		ok(notice);
		match(notice.text, /classification:system_modify via project-policy/);
	});

	it("ignores malformed payloads", () => {
		strictEqual(safetyBlockedNotice(null), null);
		strictEqual(safetyBlockedNotice({ tool: "bash" }), null);
		strictEqual(safetyBlockedNotice({ tool: "", actionClass: "x", policySource: "y", reasonCode: "z" }), null);
		strictEqual(safetyBlockedNotice({ tool: "bash", actionClass: "x", policySource: "y", reasonCode: 7 }), null);
	});
});

describe("domain stop() releases bus subscriptions", () => {
	const scratchRoots: string[] = [];
	afterEach(() => {
		for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("prompts unsubscribes from config.hotReload", async () => {
		const ctx = domainContext();
		const bundle = createPromptsBundle(ctx, { noContextFiles: true });
		await bundle.extension.start();
		strictEqual(ctx.bus.listeners(BusChannels.ConfigHotReload).length, 1);
		await bundle.extension.stop?.();
		strictEqual(ctx.bus.listeners(BusChannels.ConfigHotReload).length, 0);
		// Emitting after stop must be a no-op rather than a stale reload.
		ctx.bus.emit(BusChannels.ConfigHotReload, { diff: { hotReload: ["prompt.fragment"] } } as never);
	});

	it("context unsubscribes from session.start", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "clio-orphan-events-"));
		scratchRoots.push(scratch);
		const previousCwd = process.cwd();
		process.chdir(scratch);
		try {
			const ctx = domainContext();
			const bundle = await ContextDomainModule.createExtension(ctx);
			await bundle.extension.start();
			strictEqual(ctx.bus.listeners(BusChannels.SessionStart).length, 1);
			await bundle.extension.stop?.();
			strictEqual(ctx.bus.listeners(BusChannels.SessionStart).length, 0);
			ctx.bus.emit(BusChannels.SessionStart, { at: Date.now() });
		} finally {
			process.chdir(previousCwd);
		}
	});
});

describe("context activity payload unions", () => {
	function emitAndRead(overrides: Record<string, unknown>) {
		const bus = createSafeEventBus();
		const store = createContextActivityStore(bus);
		bus.emit(BusChannels.ContextActivity, {
			kind: "context-init",
			phase: "scan",
			status: "started",
			message: "scanning",
			at: 1000,
			...overrides,
		});
		return store.current(1001);
	}

	it("accepts in-union values", () => {
		ok(emitAndRead({}));
	});

	it("rejects out-of-union kind, phase, and status", () => {
		strictEqual(emitAndRead({ kind: "context-detonate" }), null);
		strictEqual(emitAndRead({ phase: "warp" }), null);
		strictEqual(emitAndRead({ status: "exploded" }), null);
	});
});

describe("run.aborted payload reaches the status summary", () => {
	it("validates the canonical payload shape", () => {
		ok(isRunAbortedPayload({ source: "dispatch_drain", runId: "r1", startedAt: null, elapsedMs: 12, at: 5 }));
		ok(isRunAbortedPayload({ source: "stream_cancel", runId: null, startedAt: null, elapsedMs: null, reason: "x" }));
		strictEqual(isRunAbortedPayload({ source: "meteor", runId: null, startedAt: null, elapsedMs: null }), false);
		strictEqual(isRunAbortedPayload({ source: "dispatch_abort", runId: 7, startedAt: null, elapsedMs: null }), false);
		strictEqual(isRunAbortedPayload(null), false);
	});

	function controllerHarness() {
		const bus = createSafeEventBus();
		let chatListener: ((event: ChatLoopEvent) => void) | null = null;
		const chat = {
			onEvent(handler: (event: ChatLoopEvent) => void) {
				chatListener = handler;
				return () => {
					chatListener = null;
				};
			},
			getSessionId: () => null,
		} as unknown as ChatLoop;
		const providers = { list: () => [] } as unknown as ProvidersContract;
		const controller = createStatusController({
			chat,
			providers,
			bus,
			setInterval: () => 0,
			clearInterval: () => {},
			setTimeout: () => 0,
			clearTimeout: () => {},
		});
		return {
			bus,
			controller,
			startRun: () => chatListener?.({ type: "agent_start" } as ChatLoopEvent),
		};
	}

	it("distinguishes a dispatch drain from a user stream cancel", () => {
		const drained = controllerHarness();
		drained.startRun();
		drained.bus.emit(BusChannels.RunAborted, {
			source: "dispatch_drain",
			runId: "r1",
			startedAt: null,
			elapsedMs: 100,
			at: Date.now(),
		});
		strictEqual(drained.controller.current().phase, "ended");
		strictEqual(drained.controller.current().summary?.stopReason, "cancelled");
		strictEqual(drained.controller.current().summary?.stopDetail, "dispatch drain");
		drained.controller.dispose();

		const cancelled = controllerHarness();
		cancelled.startRun();
		cancelled.bus.emit(BusChannels.RunAborted, {
			source: "stream_cancel",
			runId: null,
			startedAt: null,
			elapsedMs: null,
			at: Date.now(),
			reason: "user cancelled stream",
		});
		strictEqual(cancelled.controller.current().summary?.stopDetail, "stream cancel: user cancelled stream");
		cancelled.controller.dispose();
	});

	it("still ends the run on a malformed payload, without detail", () => {
		const harness = controllerHarness();
		harness.startRun();
		// Deliberately malformed: bypass the compile-time payload check.
		harness.bus.emit(BusChannels.RunAborted, { bogus: true } as never);
		strictEqual(harness.controller.current().phase, "ended");
		strictEqual(harness.controller.current().summary?.stopReason, "cancelled");
		strictEqual(harness.controller.current().summary?.stopDetail, undefined);
		harness.controller.dispose();
	});
});
