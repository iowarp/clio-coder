/**
 * The dispatch-to-pane-host bridge: notifications and the SA-3 self-report.
 *
 * Driven against a fake `MuxContract` rather than the fake herdr server: the
 * wire is already pinned by `mux-contract.test.ts` and
 * `mux-socket-client.test.ts`, and what this file is for is the policy above
 * it. The one thing the bridge must never do any more is open a pane: the
 * per-dispatch viewer panes are gone, and a test here pins that no dispatch
 * lifecycle event produces any mux call beyond `notify`.
 */

import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type AgentStatusChangedPayload,
	BusChannels,
	type DispatchCompletedPayload,
	type DispatchFailedPayload,
	type DispatchStartedPayload,
} from "../../src/core/bus-events.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import type { MuxContract, MuxNotifyRequest, MuxSelfReport } from "../../src/domains/mux/index.js";
import { createMuxBridge, type MuxBridge, type PanesNotificationsPolicy } from "../../src/interactive/mux-bridge.js";

type Call = { kind: "notify"; request: MuxNotifyRequest } | { kind: "self"; state: MuxSelfReport["state"] };

interface FakeMux {
	contract: MuxContract;
	calls: Call[];
	setAvailable(next: boolean): void;
	/** Make the next notify calls reject, as a contract bug rather than a dead socket would. */
	setNotifyError(next: Error | null): void;
}

function fakeMux(options: { available?: boolean } = {}): FakeMux {
	const calls: Call[] = [];
	let available = options.available ?? true;
	let notifyError: Error | null = null;
	const contract: MuxContract = {
		mode: "guest",
		available: () => available,
		detection: () => ({
			mode: "guest",
			socketPath: "/tmp/fake.sock",
			server: { version: "0.7.5", protocol: 17 },
			self: { workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p0" },
			candidates: ["/tmp/fake.sock"],
			reason: "fake",
			refused: false,
		}),
		async openUtilityPane() {
			throw new Error("the bridge must never open a pane");
		},
		async adoptPane() {
			throw new Error("the bridge must never adopt a pane");
		},
		async closePane() {
			throw new Error("the bridge must never close a pane");
		},
		async notify(request: MuxNotifyRequest): Promise<void> {
			calls.push({ kind: "notify", request });
			if (notifyError) throw notifyError;
		},
		async worktreeCreate(): Promise<null> {
			return null;
		},
		async worktreeRemove(): Promise<boolean> {
			return false;
		},
		onPaneGone(): () => void {
			return () => {};
		},
		list: () => [],
		async reportSelf(report: MuxSelfReport): Promise<boolean> {
			calls.push({ kind: "self", state: report.state });
			return true;
		},
		async shutdown(): Promise<void> {},
	};
	return {
		contract,
		calls,
		setAvailable(next: boolean): void {
			available = next;
		},
		setNotifyError(next: Error | null): void {
			notifyError = next;
		},
	};
}

interface Harness {
	bus: SafeEventBus;
	mux: FakeMux;
	bridge: MuxBridge;
	/** How many trailing-edge timers were armed, which is the coalescing measure. */
	timersArmed(): number;
	policy: { value: PanesNotificationsPolicy };
	notices: Array<{ level: "error"; text: string }>;
}

function harness(options: { policy?: PanesNotificationsPolicy; available?: boolean } = {}): Harness {
	const bus = createSafeEventBus();
	const mux = fakeMux(options.available === undefined ? {} : { available: options.available });
	const policy = { value: options.policy ?? "failures" };
	const notices: Array<{ level: "error"; text: string }> = [];
	let armed = 0;
	// A no-op timer factory: the test drives the trailing edge through flush(),
	// which is what makes the coalescing assertion a count rather than a sleep.
	const bridge = createMuxBridge({
		bus,
		mux: mux.contract,
		notificationsPolicy: () => policy.value,
		setTimeoutFn: ((handler: () => void) => {
			armed += 1;
			void handler;
			return { unref(): void {} } as unknown as NodeJS.Timeout;
		}) as unknown as typeof setTimeout,
		clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
		notice: (level, text) => notices.push({ level, text }),
	});
	return { bus, mux, bridge, policy, notices, timersArmed: () => armed };
}

function identity(runId: string, agentId: string, task?: string): DispatchStartedPayload {
	return {
		runId,
		agentId,
		...(task === undefined ? {} : { task }),
		requestOrigin: "agent",
		targetId: "t1",
		wireModelId: "qwen3-coder",
		runtimeId: "native",
		runtimeKind: "http",
		pid: 42,
		assignmentId: runId,
		attempt: 0,
	};
}

function completed(
	bus: SafeEventBus,
	runId: string,
	agentId: string,
	options: { durationMs?: number; detail?: string } = {},
): void {
	const payload = {
		...identity(runId, agentId),
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: options.detail ?? null,
		...(options.durationMs === undefined ? {} : { durationMs: options.durationMs }),
	} as unknown as DispatchCompletedPayload;
	bus.emit(BusChannels.DispatchCompleted, payload);
}

function failed(bus: SafeEventBus, runId: string, agentId: string, detail: string | null = "exit 1"): void {
	const payload = {
		...identity(runId, agentId),
		reason: "failed",
		outcomeCode: null,
		outcomeDetail: detail,
		durationMs: 500,
	} as unknown as DispatchFailedPayload;
	bus.emit(BusChannels.DispatchFailed, payload);
}

function status(bus: SafeEventBus, phase: AgentStatusChangedPayload["phase"]): void {
	bus.emit(BusChannels.AgentStatusChanged, { phase, at: Date.now() } as AgentStatusChangedPayload);
}

describe("mux bridge dispatch notifications", () => {
	it("opens no pane for any dispatch lifecycle, ever", async () => {
		// The fake throws from every pane-affecting method, so this test fails
		// loudly if the bridge regains the old per-dispatch pane behavior.
		const h = harness({ policy: "all" });
		h.bus.emit(BusChannels.DispatchStarted, identity("run-1", "tester"));
		h.bus.emit(BusChannels.DispatchProgress, { runId: "run-1", agentId: "tester", event: { type: "x" } });
		completed(h.bus, "run-1", "tester", { durationMs: 100 });
		await h.bridge.flush();
		deepStrictEqual(
			h.mux.calls.filter((call) => call.kind !== "notify"),
			[],
		);
	});

	it("raises a failure toast with a persistent notice under the failures policy", async () => {
		const h = harness();
		h.bus.emit(BusChannels.DispatchStarted, identity("run-1", "tester"));
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		const notify = h.mux.calls.find((call) => call.kind === "notify");
		ok(notify && notify.kind === "notify");
		strictEqual(notify.request.title, "tester failed");
		strictEqual(notify.request.body, "exit 1");
		strictEqual(notify.request.sound, "request");
		deepStrictEqual(h.notices, [{ level: "error", text: "tester failed (run-1): exit 1" }]);

		// A success is one of many under `failures`; nothing is raised.
		completed(h.bus, "run-2", "scout", { durationMs: 100 });
		await h.bridge.flush();
		strictEqual(h.mux.calls.filter((call) => call.kind === "notify").length, 1);
	});

	it("chimes only for a long success under the all policy", async () => {
		const h = harness({ policy: "all" });
		completed(h.bus, "run-1", "scout", { durationMs: 1_000 });
		completed(h.bus, "run-2", "builder", { durationMs: 90_000 });
		await h.bridge.flush();
		const sounds = h.mux.calls.flatMap((call) => (call.kind === "notify" ? [call.request.sound] : []));
		deepStrictEqual(sounds, ["none", "done"]);
		deepStrictEqual(h.notices, [], "a success never leaves an error notice");
	});

	it("suppresses both signals under the off policy", async () => {
		const h = harness({ policy: "off" });
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, []);
		deepStrictEqual(h.notices, []);
	});

	it("keeps the persistent failure notice when the pane host is gone", async () => {
		const h = harness({ available: false });
		failed(h.bus, "run-1", "tester", null);
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, [], "no toast can be painted without a host");
		deepStrictEqual(h.notices, [{ level: "error", text: "tester failed (run-1)" }]);
	});

	// The toast path shipped with its failure side never driven against a live
	// host. The contract swallows a refused toast and a dead socket on its own
	// (pinned in mux-contract.test.ts against the fake wire, and confirmed against
	// a live herdr 0.8.2 socket), so anything reaching the bridge's catch is a
	// contract bug. It still must not take the session with it: every toast and
	// self-report shares one `draining` promise, and one unhandled rejection there
	// would silently stop every later notification.
	it("survives a notify that rejects and keeps the chain running", async () => {
		const h = harness();
		h.mux.setNotifyError(new Error("contract bug"));
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		// The transcript line is written before the toast is attempted, so the
		// auditable record of the failure does not depend on the toast working.
		deepStrictEqual(h.notices, [{ level: "error", text: "tester failed (run-1): exit 1" }]);

		h.mux.setNotifyError(null);
		failed(h.bus, "run-2", "builder");
		await h.bridge.flush();
		const titles = h.mux.calls.flatMap((call) => (call.kind === "notify" ? [call.request.title] : []));
		deepStrictEqual(titles, ["tester failed", "builder failed"], "a rejected toast did not poison the chain");

		// The self-report rides the same chain, so it has to survive too.
		status(h.bus, "writing");
		await h.bridge.flush();
		ok(
			h.mux.calls.some((call) => call.kind === "self" && call.state === "working"),
			"the self-report chain outlived the rejection",
		);
	});

	it("keeps a rejected toast out of the dispatch event that raised it", async () => {
		const h = harness();
		h.mux.setNotifyError(new Error("contract bug"));
		// The emit itself must stay clean: onTerminal runs inside the bus handler,
		// and a throw there would surface as a dispatch failure rather than a
		// missing toast.
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		strictEqual(h.mux.calls.filter((call) => call.kind === "notify").length, 1);
	});

	it("reads the policy live, so a /settings change applies to the next terminal run", async () => {
		const h = harness({ policy: "off" });
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		strictEqual(h.mux.calls.length, 0);
		h.policy.value = "failures";
		failed(h.bus, "run-2", "tester");
		await h.bridge.flush();
		strictEqual(h.mux.calls.filter((call) => call.kind === "notify").length, 1);
	});

	it("bounds and sanitizes terminal detail before it reaches a toast", async () => {
		const h = harness();
		failed(h.bus, "run-1", "tester", `bad[31m output ${"x".repeat(300)}`);
		await h.bridge.flush();
		const notify = h.mux.calls.find((call) => call.kind === "notify");
		ok(notify && notify.kind === "notify");
		ok(notify.request.body !== undefined);
		ok(!notify.request.body.includes(""), "escape sequences are stripped");
		ok(notify.request.body.length <= 96, "detail is bounded");
	});

	it("falls back to its own start stamp when a terminal event carries no duration", async () => {
		let clock = 1_000;
		const bus = createSafeEventBus();
		const mux = fakeMux();
		const bridge = createMuxBridge({
			bus,
			mux: mux.contract,
			notificationsPolicy: () => "all",
			now: () => clock,
		});
		bus.emit(BusChannels.DispatchStarted, identity("run-1", "builder"));
		clock += 120_000;
		completed(bus, "run-1", "builder");
		await bridge.flush();
		const notify = mux.calls.find((call) => call.kind === "notify");
		ok(notify && notify.kind === "notify");
		strictEqual(notify.request.sound, "done", "two minutes of work earns the chime");
		bridge.dispose();
	});
});

describe("mux bridge self-report (SA-3)", () => {
	it("coalesces a burst of status phases into one trailing report", async () => {
		const h = harness();
		status(h.bus, "writing");
		status(h.bus, "tool_running");
		status(h.bus, "tool_blocked");
		strictEqual(h.timersArmed(), 1, "one trailing-edge timer covers the whole burst");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, [{ kind: "self", state: "blocked" }], "only the last state reaches the wire");
	});

	it("never re-reports an unchanged state", async () => {
		const h = harness();
		status(h.bus, "writing");
		await h.bridge.flush();
		status(h.bus, "tool_running");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, [{ kind: "self", state: "working" }]);
		status(h.bus, "idle");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, [
			{ kind: "self", state: "working" },
			{ kind: "self", state: "idle" },
		]);
	});

	it("stops listening after dispose", async () => {
		const h = harness();
		h.bridge.dispose();
		status(h.bus, "writing");
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, []);
		deepStrictEqual(h.notices, []);
	});
});
