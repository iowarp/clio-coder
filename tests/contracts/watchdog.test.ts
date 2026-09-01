/**
 * The opt-in turn-end watchdog: when it fires, what it is briefed with, what it
 * says, and the surfaces on which it stays silent whatever the setting says.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { diffSettings } from "../../src/domains/config/classify.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";
import {
	createWatchdogRegistration,
	WATCHDOG_DIFF_MAX_BYTES,
	type WatchdogSettingsView,
	type WatchdogTrigger,
} from "../../src/domains/middleware/watchdog.js";
import { watchdogBlockersNotice } from "../../src/interactive/bus-notices.js";
import { runWatchdogReview } from "../../src/interactive/watchdog-run.js";

const flushAsync = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function editCall(path: string, diff: string): MiddlewareHookInput {
	return {
		hook: "after_tool",
		toolName: "edit",
		toolCallId: `c-${path}-${diff.length}`,
		metadata: { resultKind: "ok" },
		toolResultDetails: { diff, paths: [path] },
	};
}

function readCall(): MiddlewareHookInput {
	return {
		hook: "after_tool",
		toolName: "read",
		toolCallId: "c-read",
		metadata: { resultKind: "ok" },
		toolResultDetails: { paths: ["src/a.ts"] },
	};
}

const TURN_END: MiddlewareHookInput = { hook: "turn_end", text: "done", metadata: { stopReason: "stop" } };

interface Watched {
	registration: ReturnType<typeof createWatchdogRegistration>;
	triggers: WatchdogTrigger[];
	settle: () => void;
}

function watched(
	settings: WatchdogSettingsView,
	options: { firesOnThisSurface?: boolean; scope?: string | null; hold?: boolean } = {},
): Watched {
	const triggers: WatchdogTrigger[] = [];
	let release: (() => void) | null = null;
	const registration = createWatchdogRegistration({
		getSettings: () => settings,
		getScope: () => options.scope ?? null,
		...(options.firesOnThisSurface === undefined ? {} : { firesOnThisSurface: options.firesOnThisSurface }),
		run: (trigger) => {
			triggers.push(trigger);
			if (options.hold !== true) return Promise.resolve();
			return new Promise<void>((resolve) => {
				release = resolve;
			});
		},
	});
	return { registration, triggers, settle: () => release?.() };
}

function verifierReceipt(text: string): RunReceipt {
	return {
		runId: "w1",
		agentId: "verifier",
		outcome: "succeeded",
		exitCode: 0,
		output: { state: "final", text, bytes: Buffer.byteLength(text), truncated: false },
	} as unknown as RunReceipt;
}

function reviewHarness(receiptText: string): {
	requests: Array<Record<string, unknown>>;
	notices: string[];
	dispatch: DispatchContract;
} {
	const requests: Array<Record<string, unknown>> = [];
	const notices: string[] = [];
	const dispatch = {
		ownsProgressBus: () => true,
		dispatch: async (request: Record<string, unknown>) => {
			requests.push(request);
			return {
				runId: "w1",
				events: (async function* () {})(),
				finalPromise: Promise.resolve(verifierReceipt(receiptText)),
			};
		},
	} as unknown as DispatchContract;
	return { requests, notices, dispatch };
}

const trigger: WatchdogTrigger = {
	reason: "turn_end",
	diff: "--- src/a.ts\n+added",
	paths: ["src/a.ts"],
	scope: "Cache work: t2 add the invalidation test",
	toolCalls: 3,
};

describe("contracts/watchdog", () => {
	it("is off by default and validates its three keys", () => {
		strictEqual(DEFAULT_SETTINGS.safety.review.enabled, false);
		strictEqual(DEFAULT_SETTINGS.safety.review.target, undefined);
		strictEqual(DEFAULT_SETTINGS.safety.review.cadenceToolCalls, undefined);

		const good = validateSettings({
			targets: [{ id: "mini", runtime: "openai" }],
			safety: { review: { enabled: true, target: "mini", cadenceToolCalls: 12 } },
		});
		deepStrictEqual(good.issues, []);
		deepStrictEqual(good.settings.safety.review, { enabled: true, target: "mini", cadenceToolCalls: 12 });

		const bad = validateSettings({ safety: { review: { enabled: "yes", cadenceToolCalls: 0, nope: 1 } } });
		const paths = bad.issues.map((issue) => issue.path).sort();
		deepStrictEqual(paths, ["safety.review.cadenceToolCalls", "safety.review.enabled", "safety.review.nope"]);
	});

	it("hot reloads: a watchdog change never asks for a restart", () => {
		const next = structuredClone(DEFAULT_SETTINGS);
		next.safety.review = { enabled: true, target: "mini", cadenceToolCalls: 5 };
		const diff = diffSettings(DEFAULT_SETTINGS, next);
		deepStrictEqual(diff.restartRequired, []);
		deepStrictEqual(diff.nextTurn, []);
		ok(diff.hotReload.length > 0);
		ok(diff.hotReload.every((path) => path.startsWith("safety.review.")));
	});

	it("fires once per mutating turn with the turn's coalesced diff and the board scope", () => {
		const w = watched({ enabled: true }, { scope: "Cache work: t2 add the invalidation test" });
		w.registration.evaluate(editCall("src/a.ts", "@@ first"), undefined);
		w.registration.evaluate(editCall("src/b.ts", "@@ other"), undefined);
		// Second edit of the same file wins its slot; the path keeps first-touch order.
		w.registration.evaluate(editCall("src/a.ts", "@@ final"), undefined);
		w.registration.evaluate(TURN_END, undefined);

		strictEqual(w.triggers.length, 1);
		const fired = w.triggers[0];
		strictEqual(fired?.reason, "turn_end");
		deepStrictEqual(fired?.paths, ["src/a.ts", "src/b.ts"]);
		ok(fired.diff.includes("--- src/a.ts\n@@ final"));
		ok(fired.diff.includes("--- src/b.ts\n@@ other"));
		ok(!fired.diff.includes("@@ first"));
		strictEqual(fired.scope, "Cache work: t2 add the invalidation test");

		// A middleware continuation re-evaluates turn_end; the accumulator is
		// already clear, so no second run reviews the same change.
		w.registration.evaluate(TURN_END, undefined);
		strictEqual(w.triggers.length, 1);
	});

	it("never fires for a read-only turn", () => {
		const w = watched({ enabled: true });
		w.registration.evaluate(readCall(), undefined);
		w.registration.evaluate(readCall(), undefined);
		w.registration.evaluate(TURN_END, undefined);
		deepStrictEqual(w.triggers, []);
	});

	it("never fires when the setting is off", () => {
		const w = watched({ enabled: false });
		w.registration.evaluate(editCall("src/a.ts", "@@ x"), undefined);
		w.registration.evaluate(TURN_END, undefined);
		deepStrictEqual(w.triggers, []);
	});

	it("never fires on a surface that has no operator, whatever the setting says", () => {
		const w = watched({ enabled: true, cadenceToolCalls: 1 }, { firesOnThisSurface: false });
		w.registration.evaluate(editCall("src/a.ts", "@@ x"), undefined);
		w.registration.evaluate(TURN_END, undefined);
		deepStrictEqual(w.triggers, []);
	});

	it("fires on the cadence and keeps accumulating for the turn's own review", async () => {
		const w = watched({ enabled: true, cadenceToolCalls: 2 });
		w.registration.evaluate(editCall("src/a.ts", "@@ one"), undefined);
		strictEqual(w.triggers.length, 0);
		w.registration.evaluate(editCall("src/b.ts", "@@ two"), undefined);
		strictEqual(w.triggers.length, 1);
		strictEqual(w.triggers[0]?.reason, "cadence");
		deepStrictEqual(w.triggers[0]?.paths, ["src/a.ts", "src/b.ts"]);

		// The cadence run has to settle before the turn ends, or turn end is the
		// overlapping trigger the in-flight rule drops.
		await w.registration.whenIdle();
		w.registration.evaluate(TURN_END, undefined);
		strictEqual(w.triggers.length, 2);
		// Turn end reviews the whole turn, not just what landed since the cadence.
		deepStrictEqual(w.triggers[1]?.paths, ["src/a.ts", "src/b.ts"]);
	});

	it("drops an overlapping trigger and counts it rather than queueing a second run", () => {
		const w = watched({ enabled: true, cadenceToolCalls: 1 }, { hold: true });
		w.registration.evaluate(editCall("src/a.ts", "@@ one"), undefined);
		strictEqual(w.triggers.length, 1);
		strictEqual(w.registration.runInFlight(), true);

		w.registration.evaluate(editCall("src/b.ts", "@@ two"), undefined);
		w.registration.evaluate(TURN_END, undefined);
		strictEqual(w.triggers.length, 1);
		strictEqual(w.registration.droppedTriggers(), 2);
		w.settle();
	});

	it("bounds the coalesced diff it briefs with", () => {
		const w = watched({ enabled: true });
		w.registration.evaluate(editCall("src/big.ts", "x".repeat(WATCHDOG_DIFF_MAX_BYTES * 2)), undefined);
		w.registration.evaluate(TURN_END, undefined);
		const fired = w.triggers[0];
		ok(fired);
		ok(Buffer.byteLength(fired.diff, "utf8") <= WATCHDOG_DIFF_MAX_BYTES);
		ok(fired.diff.includes("[diff truncated]"));
	});

	it("renders blockers as one notice naming the count and the first three checks", () => {
		const notice = watchdogBlockersNotice([
			{ name: "scope: touched src/engine/ai.ts", passed: false },
			{ name: "missing: t2 has no test", passed: false },
			{ name: "defect: unreachable branch", passed: false },
			{ name: "style", passed: false },
			{ name: "types", passed: true },
		]);
		ok(notice);
		strictEqual(notice.level, "warn");
		ok(notice.text.startsWith("[watchdog] 4 blockers after this turn: "));
		ok(notice.text.includes("scope: touched src/engine/ai.ts; missing: t2 has no test; defect: unreachable branch"));
		ok(notice.text.includes("and 1 more"));
		ok(notice.text.includes("Nothing was changed or queued."));
	});

	it("renders nothing for a passing report", () => {
		strictEqual(watchdogBlockersNotice([{ name: "scope", passed: true }]), null);
		strictEqual(watchdogBlockersNotice([]), null);
	});

	it("dispatches a read-only internal verifier run and emits one notice for its blockers", async () => {
		const h = reviewHarness(
			JSON.stringify({
				verdict: "fail",
				checks: [
					{ name: "scope: touched src/engine/ai.ts", passed: false, evidence: "diff hunk 2" },
					{ name: "types", passed: true, evidence: "n/a" },
				],
			}),
		);
		await runWatchdogReview(trigger, {
			dispatch: h.dispatch,
			bus: createSafeEventBus(),
			emitNotice: (text) => h.notices.push(text),
		});

		strictEqual(h.requests.length, 1);
		const request = h.requests[0] ?? {};
		strictEqual(request.agentId, "verifier");
		strictEqual(request.requestOrigin, "internal");
		strictEqual(request.autonomy, "read-only");
		strictEqual(request.target, undefined);
		ok(typeof request.briefing === "string" && request.briefing.includes("--- src/a.ts\n+added"));
		ok(typeof request.briefing === "string" && request.briefing.includes("t2 add the invalidation test"));

		strictEqual(h.notices.length, 1);
		ok(h.notices[0]?.startsWith("[watchdog] 1 blocker after this turn: scope: touched src/engine/ai.ts"));
	});

	it("routes the run at watchdog.target when one is set", async () => {
		const h = reviewHarness(
			JSON.stringify({ verdict: "pass", checks: [{ name: "scope", passed: true, evidence: "ok" }] }),
		);
		await runWatchdogReview(trigger, {
			dispatch: h.dispatch,
			target: "local-lmstudio",
			emitNotice: (text) => h.notices.push(text),
		});
		strictEqual(h.requests[0]?.target, "local-lmstudio");
		// A passing report emits nothing.
		deepStrictEqual(h.notices, []);
	});

	it("stays silent when the run produces no parseable report", async () => {
		const h = reviewHarness("I looked at it and it seems fine.");
		await runWatchdogReview(trigger, { dispatch: h.dispatch, emitNotice: (text) => h.notices.push(text) });
		deepStrictEqual(h.notices, []);
		await flushAsync();
	});
});
