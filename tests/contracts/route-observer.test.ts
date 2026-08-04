import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { fixedRouteDecision, type RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { createRouteHistoryStore } from "../../src/domains/dispatch/route-history.js";
import { createRouteObserver } from "../../src/domains/dispatch/route-observer.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
	return {
		agentId: "coder",
		specFingerprint: "spec-a",
		executionRole: "builder",
		targetId: "primary",
		modelId: "model-a",
		runtimeId: "openai",
		nodeId: "local",
		toolSignature: "tools-a",
		promptCompositionHash: "prompt-a",
		endpointIdentityHash: "endpoint-a",
		settingsFingerprint: "settings-a",
		...overrides,
	};
}

function envelope(): RunEnvelope {
	return {
		id: "run-1",
		agentId: "coder",
		executionRole: "builder",
		task: "inspect the code",
		targetId: "primary",
		wireModelId: "model-a",
		runtimeId: "openai",
		runtimeKind: "http",
		startedAt: "2026-07-20T00:00:00.000Z",
		endedAt: "2026-07-20T00:00:01.000Z",
		status: "completed",
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: null,
		cwd: "/workspace",
		tokenCount: 0,
		costUsd: 0.1,
	};
}

function receiptDraft(run: RunEnvelope): RunReceiptDraft {
	return {
		runId: run.id,
		agentId: run.agentId,
		executionRole: "builder",
		task: run.task,
		targetId: run.targetId,
		wireModelId: run.wireModelId,
		runtimeId: run.runtimeId,
		runtimeKind: run.runtimeKind,
		startedAt: run.startedAt,
		endedAt: run.endedAt ?? run.startedAt,
		outcome: "succeeded",
		outcomeDetail: null,
		exitCode: 0,
		tokenCount: 0,
		costUsd: 0.1,
		costProvenance: "unknown",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "test",
		piMonoVersion: "test",
		platform: "test",
		nodeVersion: process.version,
		toolCalls: 0,
		toolStats: [],
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [{ sourceId: "verifier", validatorDigest: "a".repeat(64), passed: true }],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: null,
		},
		sessionId: null,
	};
}

describe("route observer durable history", () => {
	it("restart preserves route history and decision replay", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-route-history-"));
		roots.push(stateDir);
		const history = createRouteHistoryStore({ stateDir });
		const observer = createRouteObserver({
			getAgents: () => [{ id: "coder", description: "coding" }],
			history,
			logDir: join(stateDir, "decisions"),
		});
		const route = candidate();
		const handle = observer.observe({
			task: "inspect the code",
			requestedAgentId: "coder",
			decision: fixedRouteDecision(route, "test-fixed-route"),
		});
		ok(handle);
		if (handle === null) return;
		const run = envelope();
		const receipt = withReceiptIntegrity(receiptDraft(run), run);
		observer.recordOutcome(handle.id, {
			route,
			outcome: "succeeded",
			qualityLabel: "pass",
			firstPass: true,
			attempt: 0,
			costUsd: 0.1,
			endToEndMs: 1000,
			receipt,
			envelope: run,
			quality: { label: "pass", checks: [], correlatedGates: [], sourceDigests: [receipt.integrity.digest] },
			phaseTiming: { totalEndToEndMs: 1000, queueWaitMs: 10 },
		});

		const reopened = createRouteHistoryStore({ stateDir });
		const records = reopened.recordsFor(route);
		strictEqual(records.length, 1);
		strictEqual(records[0]?.qualityLabel, "pass");
		strictEqual(records[0]?.completedCostUsd, 0.1);
		// The persisted record itself is the offline replay input; re-opening it
		// yields byte-identical durable observations without a running observer.
		deepStrictEqual(reopened.all(), history.all());
	});

	it("observer failure seals a fixed decision instead of omitting routeDecision", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "clio-route-observer-failure-"));
		roots.push(stateDir);
		const observer = createRouteObserver({
			getAgents: () => {
				throw new Error("catalog unavailable");
			},
			stateDir,
			logDir: join(stateDir, "decisions"),
		});
		const route = candidate();
		const shadow = { ...fixedRouteDecision(route, "shadow-source"), mode: "shadow" as const };
		const handle = observer.observe({
			task: "inspect the code",
			requestedAgentId: "coder",
			decision: shadow,
		});
		strictEqual(handle.decision.mode, "fixed");
		deepStrictEqual(handle.decision.executedRoute, route);
		deepStrictEqual(handle.decision.selected, route);
		ok(handle.decision.reasonCodes.includes("observer-failure-fixed-route"));
		const active = { ...shadow, mode: "active" as const };
		const activeHandle = observer.observe({ task: "inspect", requestedAgentId: "coder", decision: active });
		strictEqual(activeHandle.decision, active);
	});
});
