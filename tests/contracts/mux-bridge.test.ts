/**
 * The dispatch bridge's pane policy, per spec 4.7.
 *
 * Driven against a fake `MuxContract` rather than the fake herdr server: the
 * wire is already pinned by `mux-contract.test.ts` and `mux-socket-client.test.ts`,
 * and what this file is for is the policy above it. Every mux call the bridge
 * makes is recorded in order, so the assertions read as the sequence an
 * operator's pane host would actually receive.
 *
 * Nothing here depends on the run event journal being written. The journal is a
 * separate surface with its own contract test, and a bridge test that needed it
 * would be measuring two things.
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
import type {
	MuxAdoptableRun,
	MuxContract,
	MuxNotifyRequest,
	MuxOpenRunPaneRequest,
	MuxOpenUtilityPaneRequest,
	MuxPaneRecord,
	MuxPaneRef,
	MuxRunDisplayState,
	MuxSelfReport,
} from "../../src/domains/mux/index.js";
import {
	createMuxBridge,
	type MuxBridge,
	type MuxBridgePanesSettings,
	runPaneLabel,
} from "../../src/interactive/mux-bridge.js";

type Call =
	| { kind: "open"; runId: string; label: string }
	| { kind: "report"; runId: string; state: MuxRunDisplayState }
	| { kind: "close"; runId: string; keepOnFailure: boolean | undefined }
	| { kind: "notify"; request: MuxNotifyRequest }
	| { kind: "self"; state: MuxSelfReport["state"] }
	| { kind: "adopt"; runIds: ReadonlyArray<string> };

interface FakeMux {
	contract: MuxContract;
	calls: Call[];
	/** Fire the pane-gone handlers, as a user closing a viewer would. */
	paneGone(runId: string): void;
	setAvailable(next: boolean): void;
	/** Run ids whose panes exist as far as this fake is concerned. */
	adoptable: Set<string>;
}

function fakeMux(options: { available?: boolean } = {}): FakeMux {
	const calls: Call[] = [];
	const panes = new Map<string, MuxPaneRecord>();
	const handlers = new Set<(record: MuxPaneRecord) => void>();
	const adoptable = new Set<string>();
	let available = options.available ?? true;
	let nextPane = 0;

	const ref = (): MuxPaneRef => {
		nextPane += 1;
		return { paneId: `w1:p${nextPane}`, tabId: "w1:tFleet", workspaceId: "w1" };
	};

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
		}),
		async openRunPane(request: MuxOpenRunPaneRequest): Promise<MuxPaneRef | null> {
			calls.push({ kind: "open", runId: request.runId, label: request.label });
			const existing = [...panes.values()].find((record) => record.runId === request.runId);
			if (existing) return existing.ref;
			const created = ref();
			panes.set(created.paneId, {
				ref: created,
				purpose: "run",
				label: request.label,
				openedAt: 0,
				runId: request.runId,
				agentId: request.agentId,
				outcome: null,
			});
			return created;
		},
		async focusRunPane(): Promise<boolean> {
			return true;
		},
		async closeRunPane(runId: string, closeOptions): Promise<void> {
			calls.push({ kind: "close", runId, keepOnFailure: closeOptions?.keepOnFailure });
			const entry = [...panes.values()].find((record) => record.runId === runId);
			const failed = entry?.outcome === "failed" || entry?.outcome === "timed_out";
			if (entry && !(closeOptions?.keepOnFailure === true && failed)) panes.delete(entry.ref.paneId);
		},
		async openUtilityPane(_request: MuxOpenUtilityPaneRequest): Promise<MuxPaneRef | null> {
			return null;
		},
		async closePane(): Promise<boolean> {
			return false;
		},
		async reportRunState(runId: string, state: MuxRunDisplayState): Promise<void> {
			calls.push({ kind: "report", runId, state });
			const entry = [...panes.values()].find((record) => record.runId === runId);
			if (entry) panes.set(entry.ref.paneId, { ...entry, outcome: state.outcome ?? null });
		},
		async notify(request: MuxNotifyRequest): Promise<void> {
			calls.push({ kind: "notify", request });
		},
		async adoptRunPanes(runs: ReadonlyArray<MuxAdoptableRun>): Promise<ReadonlyArray<string>> {
			const claimed = runs.filter((run) => adoptable.has(run.runId));
			calls.push({ kind: "adopt", runIds: claimed.map((run) => run.runId) });
			for (const run of claimed) {
				const created = ref();
				panes.set(created.paneId, {
					ref: created,
					purpose: "run",
					label: run.label,
					openedAt: 0,
					runId: run.runId,
					agentId: run.agentId,
					outcome: null,
					adopted: true,
				});
			}
			return claimed.map((run) => run.runId);
		},
		onPaneGone(handler: (record: MuxPaneRecord) => void): () => void {
			handlers.add(handler);
			return () => handlers.delete(handler);
		},
		list: () => [...panes.values()],
		async reportSelf(report: MuxSelfReport): Promise<boolean> {
			calls.push({ kind: "self", state: report.state });
			return true;
		},
		async shutdown(): Promise<void> {},
	};

	return {
		contract,
		calls,
		adoptable,
		paneGone(runId: string): void {
			const entry = [...panes.values()].find((record) => record.runId === runId);
			if (!entry) return;
			panes.delete(entry.ref.paneId);
			for (const handler of handlers) handler(entry);
		},
		setAvailable(next: boolean): void {
			available = next;
		},
	};
}

const DEFAULT_SETTINGS: MuxBridgePanesSettings = { agents: "auto", keepFailed: true, notifications: "failures" };

interface Harness {
	bus: SafeEventBus;
	mux: FakeMux;
	bridge: MuxBridge;
	/** How many trailing-edge timers were armed, which is the coalescing measure. */
	timersArmed(): number;
	settings: { value: MuxBridgePanesSettings };
	detached: Set<string>;
}

function harness(
	options: {
		settings?: Partial<MuxBridgePanesSettings>;
		resumable?: ReadonlyArray<MuxAdoptableRun>;
		adoptable?: ReadonlyArray<string>;
		available?: boolean;
	} = {},
): Harness {
	const bus = createSafeEventBus();
	const mux = fakeMux(options.available === undefined ? {} : { available: options.available });
	for (const runId of options.adoptable ?? []) mux.adoptable.add(runId);
	const settings = { value: { ...DEFAULT_SETTINGS, ...options.settings } };
	const detached = new Set<string>();
	let armed = 0;
	// A no-op timer factory: the test drives the trailing edge through flush(),
	// which is what makes the coalescing assertion a count rather than a sleep.
	const bridge = createMuxBridge({
		bus,
		mux: mux.contract,
		getPanesSettings: () => settings.value,
		isDetached: (runId) => detached.has(runId),
		...(options.resumable ? { resumableRuns: () => options.resumable ?? [] } : {}),
		setTimeoutFn: ((handler: () => void) => {
			armed += 1;
			void handler;
			return { unref(): void {} } as unknown as NodeJS.Timeout;
		}) as unknown as typeof setTimeout,
		clearTimeoutFn: (() => {}) as unknown as typeof clearTimeout,
	});
	return { bus, mux, bridge, settings, detached, timersArmed: () => armed };
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

function started(bus: SafeEventBus, runId: string, agentId: string, task?: string): void {
	bus.emit(BusChannels.DispatchEnqueued, identity(runId, agentId, task));
	bus.emit(BusChannels.DispatchStarted, identity(runId, agentId, task));
}

function completed(bus: SafeEventBus, runId: string, agentId: string, durationMs = 1_000): void {
	const payload = {
		...identity(runId, agentId),
		outcome: "succeeded",
		outcomeCode: null,
		outcomeDetail: null,
		durationMs,
	} as unknown as DispatchCompletedPayload;
	bus.emit(BusChannels.DispatchCompleted, payload);
}

function failed(bus: SafeEventBus, runId: string, agentId: string, detail = "exit 1"): void {
	const payload = {
		...identity(runId, agentId),
		outcome: "failed",
		outcomeDetail: detail,
		reason: "failed",
		durationMs: 500,
	} as unknown as DispatchFailedPayload;
	bus.emit(BusChannels.DispatchFailed, payload);
}

function statusPhase(bus: SafeEventBus, phase: AgentStatusChangedPayload["phase"]): void {
	bus.emit(BusChannels.AgentStatusChanged, {
		runId: null,
		phase,
		prevPhase: "idle",
		at: 0,
		elapsedFromStart: 0,
		watchdogTier: 0,
	});
}

const opens = (calls: ReadonlyArray<Call>): ReadonlyArray<string> =>
	calls.flatMap((call) => (call.kind === "open" ? [call.runId] : []));

describe("contracts/mux bridge pane policy", () => {
	it("opens a pane for a detached run under agents=auto and leaves an attached one alone", async () => {
		const h = harness();
		h.detached.add("run-detached");
		started(h.bus, "run-detached", "tester");
		started(h.bus, "run-attached", "fixer");
		await h.bridge.flush();
		deepStrictEqual(opens(h.mux.calls), ["run-detached"]);
	});

	it("opens a pane for every run under agents=all and none under agents=off", async () => {
		const all = harness({ settings: { agents: "all" } });
		started(all.bus, "run-1", "tester");
		started(all.bus, "run-2", "fixer");
		await all.bridge.flush();
		deepStrictEqual(opens(all.mux.calls), ["run-1", "run-2"]);

		const off = harness({ settings: { agents: "off" } });
		off.detached.add("run-1");
		started(off.bus, "run-1", "tester");
		await off.bridge.flush();
		deepStrictEqual(opens(off.mux.calls), []);
	});

	it("opens a pane for a run backgrounded after it started, without a second signal", async () => {
		const h = harness();
		started(h.bus, "run-1", "tester");
		await h.bridge.flush();
		deepStrictEqual(opens(h.mux.calls), [], "an attached run gets nothing while it stays attached");

		// The operator backgrounds it: the durable batch record appears, which is
		// the only thing the policy reads.
		h.detached.add("run-1");
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "tester",
			event: { type: "clio_permission_escalated", payload: { requestId: "a1" } },
		});
		await h.bridge.flush();
		deepStrictEqual(opens(h.mux.calls), ["run-1"]);
	});

	it("opens exactly one pane per run however many events arrive", async () => {
		const h = harness();
		h.detached.add("run-1");
		started(h.bus, "run-1", "tester");
		await h.bridge.flush();
		started(h.bus, "run-1", "tester");
		await h.bridge.flush();
		deepStrictEqual(opens(h.mux.calls), ["run-1"]);
	});

	it("coalesces a burst of events into one pane update and one armed timer", async () => {
		const h = harness();
		h.detached.add("run-1");
		started(h.bus, "run-1", "tester");
		for (let index = 0; index < 50; index += 1) {
			h.bus.emit(BusChannels.DispatchProgress, {
				runId: "run-1",
				agentId: "tester",
				event: { type: "assistant_text", payload: { text: `chunk ${index}` } },
			});
		}
		strictEqual(h.timersArmed(), 1, "50 events must not arm 50 flushes");
		await h.bridge.flush();
		strictEqual(opens(h.mux.calls).length, 1);
		strictEqual(
			h.mux.calls.filter((call) => call.kind === "report").length,
			1,
			"a chatty run must not open a connection per event",
		);
	});

	it("maps running to working, an outstanding approval to blocked, and terminal to idle with labels", async () => {
		const h = harness();
		h.detached.add("run-1");
		started(h.bus, "run-1", "tester");
		await h.bridge.flush();
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "tester",
			event: { type: "clio_permission_escalated", payload: { requestId: "req-1" } },
		});
		await h.bridge.flush();
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "tester",
			event: { type: "clio_permission_resolved", payload: { requestId: "req-1" } },
		});
		await h.bridge.flush();
		completed(h.bus, "run-1", "tester");
		await h.bridge.flush();

		const states = h.mux.calls.flatMap((call) => (call.kind === "report" ? [call.state] : []));
		deepStrictEqual(
			states.map((state) => state.agentState),
			["working", "blocked", "working", "idle"],
		);
		deepStrictEqual(states.at(-1)?.stateLabels, { idle: "review ready" });
		strictEqual(states.at(-1)?.outcome, "succeeded");
	});

	it("keeps a failed run's pane and closes a succeeded one, per panes.keepFailed", async () => {
		const keep = harness();
		keep.detached.add("run-1");
		started(keep.bus, "run-1", "tester");
		await keep.bridge.flush();
		failed(keep.bus, "run-1", "tester");
		await keep.bridge.flush();
		const kept = keep.mux.calls.find((call) => call.kind === "close");
		strictEqual(kept?.kind === "close" ? kept.keepOnFailure : null, true);
		strictEqual(keep.mux.contract.list().length, 1, "the failed run's pane stays open for the post-mortem");

		const drop = harness({ settings: { keepFailed: false } });
		drop.detached.add("run-1");
		started(drop.bus, "run-1", "tester");
		await drop.bridge.flush();
		failed(drop.bus, "run-1", "tester");
		await drop.bridge.flush();
		strictEqual(drop.mux.contract.list().length, 0);
	});

	it("notifies on failure only by default, and on both outcomes under notifications=all", async () => {
		const failures = harness();
		failures.detached.add("run-1");
		failures.detached.add("run-2");
		started(failures.bus, "run-1", "tester");
		started(failures.bus, "run-2", "fixer");
		await failures.bridge.flush();
		completed(failures.bus, "run-1", "tester");
		failed(failures.bus, "run-2", "fixer");
		await failures.bridge.flush();
		const toasts = failures.mux.calls.flatMap((call) => (call.kind === "notify" ? [call.request] : []));
		strictEqual(toasts.length, 1);
		strictEqual(toasts[0]?.sound, "request", "a failure interrupts");
		ok(toasts[0]?.title.includes("fixer"));
		strictEqual(toasts[0]?.body, "exit 1");

		const all = harness({ settings: { notifications: "all" } });
		all.detached.add("run-1");
		all.detached.add("run-2");
		started(all.bus, "run-1", "tester");
		started(all.bus, "run-2", "fixer");
		await all.bridge.flush();
		// One short success and one long one: only the long one earns a sound.
		completed(all.bus, "run-1", "tester", 1_000);
		completed(all.bus, "run-2", "fixer", 120_000);
		await all.bridge.flush();
		deepStrictEqual(
			all.mux.calls.flatMap((call) => (call.kind === "notify" ? [call.request.sound] : [])),
			["none", "done"],
		);

		const quiet = harness({ settings: { notifications: "off" } });
		quiet.detached.add("run-1");
		started(quiet.bus, "run-1", "tester");
		await quiet.bridge.flush();
		failed(quiet.bus, "run-1", "tester");
		await quiet.bridge.flush();
		strictEqual(
			quiet.mux.calls.filter((call) => call.kind === "notify").length,
			0,
			"notifications=off silences even a failure",
		);
	});

	it("never reopens a viewer pane the operator closed mid-run", async () => {
		const h = harness();
		h.detached.add("run-1");
		started(h.bus, "run-1", "tester");
		await h.bridge.flush();
		strictEqual(opens(h.mux.calls).length, 1);

		h.mux.paneGone("run-1");
		h.bus.emit(BusChannels.DispatchProgress, {
			runId: "run-1",
			agentId: "tester",
			event: { type: "clio_permission_escalated", payload: { requestId: "req-1" } },
		});
		await h.bridge.flush();
		strictEqual(opens(h.mux.calls).length, 1, "a deliberately closed pane is not reopened");
		completed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		strictEqual(opens(h.mux.calls).length, 1);
		strictEqual(h.mux.calls.filter((call) => call.kind === "close").length, 0, "there is nothing left to close");
	});

	it("never opens a pane for a run that was already terminal when it first flushed", async () => {
		const h = harness();
		h.detached.add("run-1");
		started(h.bus, "run-1", "tester");
		completed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		deepStrictEqual(opens(h.mux.calls), [], "a finished run has nothing live to view");
	});

	it("adopts still-open panes on boot instead of opening seconds", async () => {
		const resumable: ReadonlyArray<MuxAdoptableRun> = [
			{ runId: "run-1", agentId: "tester", label: "tester: one" },
			{ runId: "run-2", agentId: "fixer", label: "fixer: two" },
		];
		const h = harness({ resumable, adoptable: ["run-1"] });
		await h.bridge.adoption;
		deepStrictEqual(
			h.mux.calls.flatMap((call) => (call.kind === "adopt" ? [...call.runIds] : [])),
			["run-1"],
		);

		h.detached.add("run-1");
		h.detached.add("run-2");
		started(h.bus, "run-1", "tester");
		started(h.bus, "run-2", "fixer");
		await h.bridge.flush();
		deepStrictEqual(opens(h.mux.calls), ["run-2"], "the adopted run keeps the pane it already had");
		// The adopted run still gets its state reported onto the pane it inherited.
		ok(h.mux.calls.some((call) => call.kind === "report" && call.runId === "run-1"));
	});

	it("does nothing at all while the pane layer is unavailable", async () => {
		const h = harness({ available: false });
		h.detached.add("run-1");
		started(h.bus, "run-1", "tester");
		await h.bridge.flush();
		failed(h.bus, "run-1", "tester");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, []);
	});

	it("reports Clio's own pane on turn transitions and never twice for one state", async () => {
		const h = harness();
		statusPhase(h.bus, "waiting_model");
		await h.bridge.flush();
		statusPhase(h.bus, "writing");
		await h.bridge.flush();
		statusPhase(h.bus, "tool_blocked");
		await h.bridge.flush();
		statusPhase(h.bus, "ended");
		await h.bridge.flush();
		statusPhase(h.bus, "idle");
		await h.bridge.flush();
		deepStrictEqual(
			h.mux.calls.flatMap((call) => (call.kind === "self" ? [call.state] : [])),
			["working", "blocked", "idle"],
		);
	});

	it("stops touching the pane layer after dispose", async () => {
		const h = harness();
		h.detached.add("run-1");
		h.bridge.dispose();
		started(h.bus, "run-1", "tester");
		statusPhase(h.bus, "writing");
		await h.bridge.flush();
		deepStrictEqual(h.mux.calls, []);
	});
});

describe("contracts/mux bridge pane labels", () => {
	it("sanitizes and bounds dispatched task text before it becomes a pane label", () => {
		strictEqual(runPaneLabel({ agentId: "tester" }), "tester");
		strictEqual(runPaneLabel({ agentId: "tester", task: "  " }), "tester");
		strictEqual(runPaneLabel({ agentId: "tester", task: "run\nthe\tsuite" }), "tester: run the suite");
		// Control sequences in dispatched text must never reach a metadata value.
		strictEqual(runPaneLabel({ agentId: "tester", task: "[31mred[0m" }), "tester: red");
		const long = runPaneLabel({ agentId: "tester", task: "x".repeat(200) });
		ok(long.length <= "tester: ".length + 48, long);
		ok(long.endsWith("…"));
	});
});
