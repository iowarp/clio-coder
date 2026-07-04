import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type BusChannel, BusChannels } from "../../src/core/bus-events.js";
import { createSafeEventBus, type SafeEventBus } from "../../src/core/event-bus.js";
import type { AccountabilitySummary } from "../../src/domains/observability/accountability.js";
import type { ObservabilitySnapshot, TokenThroughputSnapshot } from "../../src/domains/observability/contract.js";
import type { UsageBreakdown } from "../../src/domains/observability/cost.js";
import type { MetricsView } from "../../src/domains/observability/metrics.js";
import {
	createObservabilityProjection,
	MAX_PROJECTION_NOTICES,
	MAX_PROJECTION_RUNS,
	type ProjectionReadModel,
} from "../../src/domains/observability/projection.js";

// The projection debounces listener fan-out; snapshot() is synchronous, but any
// assertion on a subscribed listener must wait past the debounce window.
const FLUSH_WAIT_MS = 40;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cast partial payloads onto the typed bus; the projection reads defensively so
// tests only supply the fields under test.
function emit(bus: SafeEventBus, channel: BusChannel, payload: unknown): void {
	bus.emit(channel, payload as never);
}

function emptyBreakdown(): UsageBreakdown {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 };
}

function emptyMetrics(): MetricsView {
	return { dispatchesCompleted: 0, dispatchesFailed: 0, safetyClassifications: 0, totalTokens: 0, histograms: {} };
}

function emptyAccountability(): AccountabilitySummary {
	return { totalRuns: 0, firstPassRuns: 0, firstPassRate: 0, failureCauses: [] };
}

interface Harness {
	bus: SafeEventBus;
	projection: ReturnType<typeof createObservabilityProjection>;
	session: {
		cost: number;
		tokens: UsageBreakdown;
		throughput: TokenThroughputSnapshot | null;
		metrics: MetricsView;
		accountability: AccountabilitySummary;
	};
}

function makeHarness(): Harness {
	const bus = createSafeEventBus();
	const session = {
		cost: 0,
		tokens: emptyBreakdown(),
		throughput: null as TokenThroughputSnapshot | null,
		metrics: emptyMetrics(),
		accountability: emptyAccountability(),
	};
	const deps: ProjectionReadModel = {
		metrics: () => session.metrics,
		sessionCost: () => session.cost,
		sessionTokens: () => session.tokens,
		latestThroughput: () => session.throughput,
		readAccountability: () => session.accountability,
	};
	const projection = createObservabilityProjection(bus, deps);
	return { bus, projection, session };
}

function findRun(snapshot: ObservabilitySnapshot, runId: string) {
	return snapshot.runs.find((run) => run.runId === runId);
}

describe("contracts/observability-projection", () => {
	it("starts from a sane empty snapshot", () => {
		const { projection } = makeHarness();
		const snap = projection.snapshot();
		strictEqual(snap.revision, 0);
		strictEqual(snap.session.costUsd, 0);
		strictEqual(snap.session.latestThroughput, null);
		strictEqual(snap.runs.length, 0);
		strictEqual(snap.notices.length, 0);
		strictEqual(Object.keys(snap.providerHealth).length, 0);
		strictEqual(snap.pendingEvidenceBuildRunIds.length, 0);
		strictEqual(snap.accountability.totalRuns, 0);
		strictEqual(snap.metrics.dispatchesCompleted, 0);
		projection.stop();
	});

	it("invokes subscribe listeners immediately and on coalesced change, then stops on unsubscribe", async () => {
		const { bus, projection } = makeHarness();
		const seen: ObservabilitySnapshot[] = [];
		const unsubscribe = projection.subscribe((snap) => seen.push(snap));
		// Immediate call with the current snapshot.
		strictEqual(seen.length, 1);
		strictEqual(seen[0]?.runs.length, 0);

		emit(bus, BusChannels.DispatchEnqueued, { runId: "r1", agentId: "a1", targetId: "t1", wireModelId: "m1" });
		emit(bus, BusChannels.DispatchStarted, { runId: "r1", agentId: "a1" });
		await delay(FLUSH_WAIT_MS);
		// Two events coalesced into a single notification.
		strictEqual(seen.length, 2);
		strictEqual(findRun(seen[1] as ObservabilitySnapshot, "r1")?.status, "running");

		unsubscribe();
		emit(bus, BusChannels.DispatchCompleted, { runId: "r1", agentId: "a1", outcome: "succeeded" });
		await delay(FLUSH_WAIT_MS);
		strictEqual(seen.length, 2);
		projection.stop();
	});

	it("projects a completed dispatch into a recent run summary", () => {
		const { bus, projection } = makeHarness();
		emit(bus, BusChannels.DispatchEnqueued, { runId: "r1", agentId: "a1", targetId: "t1", wireModelId: "m1" });
		emit(bus, BusChannels.DispatchCompleted, {
			runId: "r1",
			agentId: "a1",
			targetId: "t1",
			wireModelId: "m1",
			outcome: "succeeded",
			outcomeDetail: null,
			tokenCount: 1200,
			inputTokenCount: 1000,
			outputTokenCount: 200,
			reasoningTokenCount: 30,
			costUsd: 0.42,
			durationMs: 5000,
		});
		const run = findRun(projection.snapshot(), "r1");
		ok(run !== undefined);
		strictEqual(run.status, "completed");
		strictEqual(run.outcome, "succeeded");
		strictEqual(run.durationMs, 5000);
		strictEqual(run.costUsd, 0.42);
		strictEqual(run.tokens.total, 1200);
		strictEqual(run.tokens.input, 1000);
		strictEqual(run.tokens.output, 200);
		strictEqual(run.tokens.reasoning, 30);
		strictEqual(run.finishedAtMs !== null, true);
		projection.stop();
	});

	it("projects a failed dispatch with mapped status and outcome fields", () => {
		const { bus, projection } = makeHarness();
		emit(bus, BusChannels.DispatchEnqueued, { runId: "r2", agentId: "a1" });
		emit(bus, BusChannels.DispatchFailed, {
			runId: "r2",
			agentId: "a1",
			outcome: "failed",
			outcomeDetail: "turn timeout exceeded",
			reason: "timed_out",
		});
		const run = findRun(projection.snapshot(), "r2");
		ok(run !== undefined);
		strictEqual(run.status, "failed");
		strictEqual(run.outcome, "failed");
		strictEqual(run.outcomeDetail, "turn timeout exceeded");

		// A canceled reason maps to aborted; a stalled reason maps to dead.
		emit(bus, BusChannels.DispatchFailed, { runId: "r3", agentId: "a1", outcome: "canceled", reason: "canceled" });
		emit(bus, BusChannels.DispatchFailed, { runId: "r4", agentId: "a1", outcome: "stalled", reason: "stalled" });
		const snap = projection.snapshot();
		strictEqual(findRun(snap, "r3")?.status, "aborted");
		strictEqual(findRun(snap, "r4")?.status, "dead");
		projection.stop();
	});

	it("accumulates safe progress fields (heartbeat status, message usage totals)", () => {
		const { bus, projection } = makeHarness();
		emit(bus, BusChannels.DispatchStarted, { runId: "r1", agentId: "a1" });
		emit(bus, BusChannels.DispatchProgress, {
			runId: "r1",
			agentId: "a1",
			event: { type: "message_end", message: { role: "assistant", usage: { input: 100, output: 40, cacheRead: 10 } } },
		});
		emit(bus, BusChannels.DispatchProgress, {
			runId: "r1",
			agentId: "a1",
			event: { type: "heartbeat_status", status: "stale" },
		});
		const run = findRun(projection.snapshot(), "r1");
		ok(run !== undefined);
		strictEqual(run.status, "stale");
		strictEqual(run.tokens.input, 110);
		strictEqual(run.tokens.output, 40);
		strictEqual(run.tokens.total, 150);
		projection.stop();
	});

	it("updates providerHealth from provider probe events", () => {
		const { bus, projection } = makeHarness();
		emit(bus, BusChannels.ProviderHealth, { id: "openai", status: { available: true, reason: "ready" } });
		const snap = projection.snapshot();
		strictEqual(snap.providerHealth.openai?.available, true);
		strictEqual(Object.keys(snap.providerHealth).length, 1);
		projection.stop();
	});

	it("appends bounded notices for runtime/middleware/safety/context/budget events", () => {
		const { bus, projection } = makeHarness();
		emit(bus, BusChannels.RuntimeNotice, {
			kind: "about-to-evict",
			level: "warning",
			targetId: "t1",
			runtimeId: "rt1",
			model: "m1",
			message: "evicting m1 to fit request",
		});
		emit(bus, BusChannels.MiddlewareHookFailed, {
			kind: "hook_failed",
			registrationId: "reg1",
			hook: "beforeToolCall",
			at: Date.now(),
			message: "hook threw",
		});
		emit(bus, BusChannels.SafetyBlocked, {
			tool: "bash",
			actionClass: "shell.exec",
			policySource: "policy",
			reasonCode: "blocked",
			rejection: { short: "blocked by policy", detail: "", hints: [] },
		});
		emit(bus, BusChannels.ContextPruned, {
			stage: "mask_observations",
			tokensBefore: 1000,
			tokensAfter: 600,
			trigger: "pressure",
			snapshotIdBefore: null,
			snapshotIdAfter: "s1",
			at: Date.now(),
		});
		emit(bus, BusChannels.BudgetAlert, { level: "over", currentUsd: 12.5, ceilingUsd: 10 });

		const snap = projection.snapshot();
		const kinds = snap.notices.map((n) => n.kind);
		ok(kinds.includes("runtime"));
		ok(kinds.includes("middleware"));
		ok(kinds.includes("safety"));
		ok(kinds.includes("context"));
		ok(kinds.includes("budget"));
		const safety = snap.notices.find((n) => n.kind === "safety");
		strictEqual(safety?.level, "warning");
		strictEqual(safety?.ref?.tool, "bash");
		const budget = snap.notices.find((n) => n.kind === "budget");
		strictEqual(budget?.level, "error");
		projection.stop();
	});

	it("suppresses a middleware budget notice unless it is steady-state", () => {
		const { bus, projection } = makeHarness();
		emit(bus, BusChannels.MiddlewareHookFailed, {
			kind: "budget_exceeded",
			registrationId: "reg1",
			hook: "beforeToolCall",
			at: Date.now(),
			steadyStateWarn: false,
		});
		strictEqual(projection.snapshot().notices.length, 0);
		emit(bus, BusChannels.MiddlewareHookFailed, {
			kind: "budget_exceeded",
			registrationId: "reg1",
			hook: "beforeToolCall",
			at: Date.now(),
			steadyStateWarn: true,
			budgetMs: 50,
		});
		strictEqual(projection.snapshot().notices.length, 1);
		strictEqual(projection.snapshot().notices[0]?.level, "warning");
		projection.stop();
	});

	it("bounds notices to the retention cap", () => {
		const { bus, projection } = makeHarness();
		for (let i = 0; i < MAX_PROJECTION_NOTICES + 25; i++) {
			emit(bus, BusChannels.RuntimeNotice, {
				kind: "stress",
				level: "info",
				targetId: "t1",
				runtimeId: "rt1",
				model: "m1",
				message: `notice ${i}`,
			});
		}
		strictEqual(projection.snapshot().notices.length, MAX_PROJECTION_NOTICES);
		projection.stop();
	});

	it("bounds recent run summaries to the retention cap", () => {
		const { bus, projection } = makeHarness();
		for (let i = 0; i < MAX_PROJECTION_RUNS + 10; i++) {
			emit(bus, BusChannels.DispatchEnqueued, { runId: `run-${i}`, agentId: "a1" });
		}
		strictEqual(projection.snapshot().runs.length, MAX_PROJECTION_RUNS);
		projection.stop();
	});

	it("populates evidence readiness through the helper path without touching the bus", () => {
		const { bus, projection, session } = makeHarness();
		emit(bus, BusChannels.DispatchEnqueued, { runId: "r1", agentId: "a1" });

		projection.evidenceBuildStarted("r1");
		ok(projection.snapshot().pendingEvidenceBuildRunIds.includes("r1"));

		// The index write feeds accountability; simulate it landing new rows.
		session.accountability = { totalRuns: 1, firstPassRuns: 1, firstPassRate: 1, failureCauses: [] };
		projection.evidenceBuildSucceeded("r1", {
			evidenceId: "run-r1",
			firstPassSuccess: true,
			findingCount: 2,
			tags: ["audit-linked"],
		});
		const snap = projection.snapshot();
		strictEqual(snap.pendingEvidenceBuildRunIds.includes("r1"), false);
		const run = findRun(snap, "r1");
		strictEqual(run?.evidence?.evidenceId, "run-r1");
		strictEqual(run?.evidence?.firstPassSuccess, true);
		strictEqual(run?.evidence?.findingCount, 2);
		strictEqual(snap.accountability.totalRuns, 1);
		projection.stop();
	});

	it("removes pending and appends an evidence notice on build failure", () => {
		const { projection } = makeHarness();
		projection.evidenceBuildStarted("r9");
		projection.evidenceBuildFailed("r9", "bundle write failed");
		const snap = projection.snapshot();
		strictEqual(snap.pendingEvidenceBuildRunIds.includes("r9"), false);
		const notice = snap.notices.find((n) => n.kind === "evidence");
		strictEqual(notice?.level, "warning");
		strictEqual(notice?.message, "bundle write failed");
		strictEqual(notice?.ref?.runId, "r9");
		projection.stop();
	});

	it("refresh() surfaces direct session mutations to subscribers", async () => {
		const { projection, session } = makeHarness();
		const seen: ObservabilitySnapshot[] = [];
		projection.subscribe((snap) => seen.push(snap));
		strictEqual(seen[0]?.session.costUsd, 0);

		session.cost = 3.14;
		session.tokens = { ...emptyBreakdown(), totalTokens: 900 };
		projection.refresh();
		await delay(FLUSH_WAIT_MS);
		const last = seen[seen.length - 1];
		strictEqual(last?.session.costUsd, 3.14);
		strictEqual(last?.session.tokens.totalTokens, 900);
		projection.stop();
	});
});
